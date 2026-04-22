'use strict';

const dgram        = require('dgram');
const dns          = require('dns');
const https        = require('https');
const os           = require('os');
const crypto       = require('crypto');
const EventEmitter = require('events');
const SimpleDHT    = require('./dht_lib');

const {
  PIPING_SERVERS, STUN_HOSTS,
  F_RELAY_ANN, F_RELAY_REQ, F_RELAY_FWD,
  F_PEX, PEX_MAX, PEX_INTERVAL,
  HARDCODED_SEEDS, HARDCODED_HTTP_BOOTSTRAP,
  PEER_CACHE_EMIT_MS,
  RELAY_NAT_OPEN, RELAY_MAX, RELAY_ANN_MS, RELAY_BAN_MS,
  BOOTSTRAP_TIMEOUT,
  MAX_PEERS, PEER_TIMEOUT, ANNOUNCE_MS,
  HEARTBEAT_MS, PUNCH_TRIES, PUNCH_INTERVAL,
  GOSSIP_MAX, GOSSIP_TTL,
  D_DEFAULT, D_MIN, D_MAX, D_LOW, D_HIGH, D_GOSSIP, IHAVE_MAX,
  BLOOM_BITS, BLOOM_HASHES,
  SYNC_CACHE_MAX, SYNC_CHUNK_SIZE, SYNC_TIMEOUT, HAVE_BATCH,
  FRAG_HDR,
  DRAIN_TIMEOUT,
  F_DATA, F_PING, F_PONG, F_FRAG, F_GOAWAY,
  F_HAVE, F_WANT, F_CHUNK, F_BATCH,
  F_CHUNK_ACK,
  MCAST_ADDR, MCAST_PORT, F_LAN,
  RTT_ALPHA,
} = require('./constants');

const { BloomFilter, LRU, PayloadCache } = require('./structs');
const { generateX25519, deriveSession, decrypt } = require('./crypto');
const { xorHash, BatchSender }                   = require('./framing');
const Peer                                       = require('./peer');

function localIP() {
  for (const ifaces of Object.values(os.networkInterfaces()))
    for (const i of ifaces)
      if (i.family === 'IPv4' && !i.internal) return i.address;
  return '127.0.0.1';
}

class Swarm extends EventEmitter {
  constructor(opts = {}) {
    super();
    this._sock       = null;
    this._mcastSock  = null;
    this._batch      = null;
    this._ext        = null;
    this._lip        = localIP();
    this._lport      = null;
    this._peers      = new Map();
    this._addrToId   = new Map();
    this._dialing    = new Set();
    this._destroyed  = false;
    this._announcers = [];
    this._maxPeers   = opts.maxPeers || MAX_PEERS;

    this._relays    = new Map();
    this._isRelay   = opts.relay === true;
    this._relayBans = new Map();
    this._relayIdx  = 0;

    this._pipingServers = opts.pipingServers
      ? opts.exclusivePiping
        ? [...new Set(opts.pipingServers)]
        : [...new Set([...opts.pipingServers, ...PIPING_SERVERS])]
      : [...PIPING_SERVERS];

    this._bootstrapNodes = opts.bootstrap || [];

    this._bootstrapHttp = [...(opts.bootstrapHttp || []), ...HARDCODED_HTTP_BOOTSTRAP];

    this._peerCache    = new Map(); 
    this._onSavePeers  = opts.onSavePeers  || null;
    this._onLoadPeers  = opts.onLoadPeers  || null;
    this._loadPeerCache();

    this._hardcodedSeeds = [...(opts.seeds || []), ...HARDCODED_SEEDS];

    this._relayList = this._pipingServers;

    this._myX25519 = generateX25519(opts.seed || null);
    this._id       = crypto.createHash('sha256').update(this._myX25519.pubRaw).digest().slice(0, 20).toString('hex');

    this.natType       = 'unknown';
    this.publicAddress = null;

this._bloom = new BloomFilter(BLOOM_BITS, BLOOM_HASHES);

this._gossipSeen  = new LRU(GOSSIP_MAX, GOSSIP_TTL);

this._meshD         = D_DEFAULT;
    this._lastMeshAdapt = 0;
    this._ihaveBuf      = [];

this._payloadCache = new PayloadCache(8192);

this._store       = new LRU(opts.storeCacheMax || SYNC_CACHE_MAX);
    this._storage     = opts.storage || null;
    this._wantPending = new Map(); 

    this._ready = this._init();
  }

get peers()     { return [...this._peers.values()]; }
  get size()      { return this._peers.size; }
  get meshPeers() { return this.peers.filter(p => p.inMesh); }

store(key, value) {
    const k = typeof key === 'string' ? key : key.toString('hex');
    const v = Buffer.isBuffer(value) ? value : Buffer.from(value);
    this._store.add(k, v);
    if (this._storage) this._storage.set(k, v).catch(() => {});
    this._announceHave([k]);
  }

async fetch(key, timeout = SYNC_TIMEOUT) {
    const k = typeof key === 'string' ? key : key.toString('hex');
    const mem = this._store.get(k);
    if (mem) return mem;
    if (this._storage) {
      const disk = await this._storage.get(k).catch(() => null);
      if (disk) { this._store.add(k, disk); return disk; }
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._wantPending.delete(k);
        reject(new Error(`fetch timeout: ${k}`));
      }, timeout);
      this._wantPending.set(k, { resolve, reject, timer });
      this._sendWant(k);
    });
  }

  join(topicBuf, jopts = {}) {
    const announce  = jopts.announce !== false;
    const lookup    = jopts.lookup   !== false;
    const topicHex  = Buffer.isBuffer(topicBuf) ? topicBuf.toString('hex') : String(topicBuf);
    const topicHash = crypto.createHash('sha1').update(topicHex).digest('hex').slice(0, 12);
    this._topicHash = topicHash;
    const ANNOUNCE_PATH = `/p2p-${topicHash}-announce`;
    const inbox         = `/p2p-${topicHash}-${this._id}`;
    const me            = () => this._me();
    const timers        = [];

const pipingPost = (host, path, body) => new Promise(resolve => {
      const buf = Buffer.from(JSON.stringify(body));
      const req = https.request({
        hostname: host, port: 443, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': buf.length },
      }, res => { res.resume(); resolve(true); });
      req.on('error', () => resolve(false));
      req.setTimeout(8000, () => { req.destroy(); resolve(false); });
      req.write(buf); req.end();
    });

    const pipingGet = (host, path, cb) => {
      const loop = () => {
        if (this._destroyed) return;
        const req = https.request({ hostname: host, port: 443, path, method: 'GET' }, res => {
          let buf = '';
          res.setEncoding('utf8');
          res.on('data', c => { buf += c; });
          res.on('end', () => {
            try { const d = JSON.parse(buf.trim()); if (d) cb(d); } catch {}
            setTimeout(loop, 100);
          });
          res.on('error', () => setTimeout(loop, 2000));
        });
        req.on('error', () => setTimeout(loop, 2000));
        req.setTimeout(120_000, () => req.destroy());
        req.end();
      };
      loop();
    };

const postAll = (path, body) => {
      this._pipingServers.forEach(host => pipingPost(host, path, body));
    };

const dialBootstrapNode = (hostport) => {
      const lastColon = hostport.lastIndexOf(':');
      if (lastColon === -1) return;
      const host = hostport.slice(0, lastColon);
      const port = parseInt(hostport.slice(lastColon + 1), 10) || 49737;
      dns.resolve4(host, (err, addrs) => {
        const ips = err ? [host] : addrs;
        ips.forEach(ip => this._dial(ip, port, null, null, null));
      });
    };

const scheduleBootstrapFallback = () => {
      if (!this._bootstrapNodes.length) return;
      setTimeout(() => {
        if (this._peers.size === 0 && !this._destroyed) {
          this._bootstrapNodes.forEach(n => dialBootstrapNode(n));
        }
      }, BOOTSTRAP_TIMEOUT);
    };

const DHT_FALLBACK_MS = 12_000;

    const startDHT = async () => {
      this._dht = new SimpleDHT({ port: 0 });
      await this._dht.ready();

      if (this._bootstrapNodes.length) {
        const nodes = this._bootstrapNodes.map(hostport => {
          const c = hostport.lastIndexOf(':');
          if (c === -1) return null;
          return { ip: hostport.slice(0, c), port: parseInt(hostport.slice(c + 1)) || 49737 };
        }).filter(Boolean);
        await this._dht.bootstrap(nodes).catch(() => {});
      }

if (announce) {
        const doAnnounce = () => {
          if (this._destroyed) return;
          this._dht.put(`topic:${topicHash}:${this._id}`, JSON.stringify(me()));
        };
        doAnnounce();
        const t = setInterval(doAnnounce, ANNOUNCE_MS);
        timers.push(t);
        this._announcers.push(t);
      }

      if (lookup) {
        const doLookup = () => {
          if (this._destroyed) return;
          for (const [key, raw] of this._dht.storage.entries()) {
            let info;
            try { info = JSON.parse(raw); } catch { continue; }
            if (!info?.id || info.id === this._id) continue;
            
            if (key.startsWith('relay:') && !this._relays.has(info.id)) {
              this._registerRelay(info.id, info.ip, info.port);
            }
            const existing = this._peers.get(info.id);
            if (existing && existing._open && existing._session) continue;
            if (info.ip && info.port) this._meet(info);
          }
        };
        setTimeout(doLookup, 1500);
        const t = setInterval(doLookup, ANNOUNCE_MS);
        timers.push(t);
      }
    };

const startRelay = () => {

startDHT().catch(() => {});

this._dialPeerCache();

this._dialHardcodedSeeds();

this._queryBootstrapHttp();

if (announce) {
        postAll(ANNOUNCE_PATH, me());
        setTimeout(() => { if (!this._destroyed) postAll(ANNOUNCE_PATH, me()); }, 2_000);
        setTimeout(() => { if (!this._destroyed) postAll(ANNOUNCE_PATH, me()); }, 5_000);
        const t = setInterval(() => {
          if (this._destroyed) return clearInterval(t);
          postAll(ANNOUNCE_PATH, me());
        }, ANNOUNCE_MS);
        timers.push(t); this._announcers.push(t);
      }

      if (lookup) {
        this._pipingServers.forEach(host => {
          pipingGet(host, ANNOUNCE_PATH, info => {
            if (!info?.id || info.id === this._id) return;
            if (announce) postAll(`/p2p-${topicHash}-${info.id}`, me());
            if (info.ip && info.port) this._meet(info);
          });
        });
        this._pipingServers.forEach(host => {
          pipingGet(host, inbox, info => {
            if (!info?.id || info.id === this._id) return;
            if (info.ip && info.port) this._meet(info);
          });
        });
      }

scheduleBootstrapFallback();
    };

    this._ready.then(() => {
      if (this._ext) {
        startRelay();
      } else {
        let called = false;
        const onNat = () => { if (!called) { called = true; startRelay(); } };
        this.once('nat', onNat);
        setTimeout(() => {
          if (!called && this._ext) { called = true; this.off('nat', onNat); startRelay(); }
        }, 200);
      }
    });

    return { ready: () => this._ready, destroy: () => timers.forEach(t => clearInterval(t)) };
  }

  broadcast(data) {
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data);
    let sent = 0;
    for (const peer of this.peers) {
      if (peer._session && peer._open) { peer.write(raw); sent++; }
    }
    return sent;
  }

  destroy() {
    if (this._destroyed) return Promise.resolve();
    this._destroyed = true;
    this._announcers.forEach(t => clearInterval(t));
    clearInterval(this._hb);
    const goaway = Buffer.from([F_GOAWAY]);
    for (const peer of this.peers) {
      try { peer._sendRawNow(goaway); } catch {}
    }
    return new Promise(resolve => {
      setTimeout(() => {
        this._emitPeerCache();
        this._batch?.destroy();
        try { this._sock?.close(); } catch {}
        try { this._mcastSock?.close(); } catch {}
        try { this._dht?.destroy(); } catch {}
        this._peers.forEach(p => p.destroy());
        this._peers.clear();
        this.emit('close');
        resolve();
      }, DRAIN_TIMEOUT);
    });
  }

async _init() {
    this._sock  = dgram.createSocket('udp4');
    await new Promise((ok, fail) => this._sock.bind(0, e => e ? fail(e) : ok()));
    this._lport = this._sock.address().port;
    this._batch = new BatchSender(this._sock);
    this._sock.on('message', (buf, r) => this._recv(buf, r));
    this._sock.on('error', () => {});
    this._heartbeat();
    this._stunLazy();
    this._initLan();
    this._initPex();
    this._initPeerCacheEmit();
    setTimeout(() => this._queryBootstrapHttp(), 500);
  }

  _stunLazy() {
    const attempt = () => {
      if (this._destroyed) return;
      
      const probes = STUN_HOSTS.map(s => this._stunProbe(s, 3000));
      Promise.race(probes).then(first => {
        if (first) {
          this._ext          = first;
          this.publicAddress = `${first.ip}:${first.port}`;
          this.natType       = 'unknown';
          this.emit('nat');
          this._queryBootstrapHttp();
          this._startBootstrapAnnounce();
          Promise.all(probes).then(results => {
            const valid = results.filter(Boolean);
            if (valid.length < 2) return;
            const sameIp = valid.filter(r => r.ip === valid[0].ip);
            if (sameIp.length < 2) return;
            const portsEq = sameIp.every(r => r.port === sameIp[0].port);
            if      (portsEq)  { this.natType = 'full_cone'; }
            else               { this.natType = 'restricted_cone'; }
            this.emit('nattype');
            this._checkBecomeRelay();
          });
        } else {
          setTimeout(attempt, 3000);
        }
      }).catch(() => setTimeout(attempt, 3000));
    };
    attempt();
  }

  _stunProbe(server, timeout) {
    return new Promise(resolve => {
      let done  = false;
      const timer = setTimeout(() => { if (!done) { done = true; this._sock.off('message', h); resolve(null); } }, timeout);
      const h = buf => {
        if (buf.length < 20 || buf.readUInt16BE(0) !== 0x0101) return;
        const len = buf.readUInt16BE(2); let off = 20;
        while (off + 4 <= 20 + len) {
          const type = buf.readUInt16BE(off), alen = buf.readUInt16BE(off + 2); off += 4;
          if (off + alen > buf.length) break;
          if (type === 0x0001 || type === 0x0020) {
            try {
              let ip, port;
              if (type === 0x0001) {
                port = buf.readUInt16BE(off + 2);
                ip   = `${buf[off+4]}.${buf[off+5]}.${buf[off+6]}.${buf[off+7]}`;
              } else {
                port = buf.readUInt16BE(off + 2) ^ 0x2112;
                ip   = `${buf[off+4]^0x21}.${buf[off+5]^0x12}.${buf[off+6]^0xA4}.${buf[off+7]^0x42}`;
              }
              if (!done) { done = true; clearTimeout(timer); this._sock.off('message', h); resolve({ ip, port }); }
            } catch {}
            return;
          }
          off += alen + (alen % 4 ? 4 - alen % 4 : 0);
        }
      };
      this._sock.on('message', h);
      const req = Buffer.alloc(20);
      req.writeUInt16BE(0x0001, 0);
      req.writeUInt32BE(0x2112A442, 4);
      crypto.randomBytes(12).copy(req, 8);
      try { this._sock.send(req, 0, req.length, server.port, server.host); } catch { resolve(null); }
    });
  }

  _initLan() {
    try {
      this._mcastSock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      this._mcastSock.bind(MCAST_PORT, () => {
        try { this._mcastSock.addMembership(MCAST_ADDR); } catch {}
      });
      this._mcastSock.on('message', (buf, r) => {
        if (buf[0] !== F_LAN) return;
        const src = buf.slice(1).toString();
        const [pid, ip, portStr, tHash] = src.split(':');
        if (pid === this._id) return;
        
        if (tHash && this._topicHash && tHash !== this._topicHash) return;
        if (!this._peers.has(pid) && !this._dialing.has(pid))
          this._dial(ip, +portStr, pid, null, null);
      });
      setInterval(() => {
        const tHash = this._topicHash || '';
        const msg = Buffer.from([F_LAN, ...Buffer.from(`${this._id}:${this._lip}:${this._lport}:${tHash}`)]);
        try { this._mcastSock.send(msg, 0, msg.length, MCAST_PORT, MCAST_ADDR); } catch {}
      }, 5000);
    } catch {}
  }

_recv(buf, r) {
    if (buf.length < 2) return;
    const src  = `${r.address}:${r.port}`;
    const type = buf[0];

    if (type === 0xA1)   return this._onHello(buf, src);
    if (type === 0xA2)   return this._onHelloAck(buf, src);
    if (type === F_DATA) return this._onData(buf, src);
    if (type === F_PING) return this._onPing(buf, src);
    if (type === F_PONG) return this._onPong(buf, src);
    if (type === F_FRAG) return this._onFrag(buf, src);
    if (type === F_GOAWAY) return this._onGoaway(src);
    if (type === F_BATCH)  return this._onBatch(buf, src);
    if (type === F_HAVE)      return this._onHave(buf, src);
    if (type === F_WANT)      return this._onWant(buf, src);
    if (type === F_CHUNK)     return this._onChunk(buf, src);
    if (type === F_CHUNK_ACK) return this._onChunkAck(buf, src);
    if (type === F_RELAY_ANN) return this._onRelayAnn(buf, src);
    if (type === F_RELAY_REQ) return this._onRelayReq(buf, src);
    if (type === F_RELAY_FWD) return this._onRelayFwd(buf, src);
    if (type === F_PEX)       return this._onPex(buf, src);
  }

_onBatch(buf, src) {
    if (buf.length < 3) return;
    const count = buf[1];
    let off = 2;
    for (let i = 0; i < count; i++) {
      if (off + 2 > buf.length) break;
      const len = buf.readUInt16BE(off); off += 2;
      if (off + len > buf.length) break;
      this._recv(buf.slice(off, off + len), { address: src.split(':')[0], port: +src.split(':')[1] });
      off += len;
    }
  }

_sendHello(ip, port) {
    const idBuf = Buffer.from(this._id, 'hex');
    const frame = Buffer.allocUnsafe(1 + 8 + 32);
    frame[0] = 0xA1;
    idBuf.copy(frame, 1);
    this._myX25519.pubRaw.copy(frame, 9);
    try { this._sock.send(frame, 0, frame.length, +port, ip); } catch {}
  }

  _sendHelloAck(ip, port) {
    const idBuf = Buffer.from(this._id, 'hex');
    const frame = Buffer.allocUnsafe(1 + 8 + 32);
    frame[0] = 0xA2;
    idBuf.copy(frame, 1);
    this._myX25519.pubRaw.copy(frame, 9);
    try { this._sock.send(frame, 0, frame.length, +port, ip); } catch {}
  }

  _onHello(buf, src) {
    if (buf.length < 41) return;
    const pid      = buf.slice(1, 9).toString('hex');
    const theirPub = buf.slice(9, 41);
    if (pid === this._id) return;
    const [ip, port] = src.split(':');
    this._sendHelloAck(ip, +port);
    const isNew = this._registerPeer(pid, src, theirPub);
    if (isNew) {
      const peer = this._peers.get(pid);
      this._addToMesh(peer);
      this._gossipPeer(ip, +port, pid);
      this._sendHaveSummary(peer);
      
      this._peerCache.set(src, { id: pid, ip, port: +port, lastSeen: Date.now() });
      this.emit('connection', peer, { peerId: pid, address: ip, port: +port, nat: this.natType });
      peer.emit('open');
    } else {
      const peer = this._peers.get(pid);
      if (peer) peer._touch(src);
    }
  }

  _onHelloAck(buf, src) {
    if (buf.length < 41) return;
    const pid      = buf.slice(1, 9).toString('hex');
    const theirPub = buf.slice(9, 41);
    if (pid === this._id) return;
    const isNew = this._registerPeer(pid, src, theirPub);
    if (isNew) {
      const peer = this._peers.get(pid);
      const [ip, port] = src.split(':');
      this._addToMesh(peer);
      this._gossipPeer(ip, +port, pid);
      this._sendHaveSummary(peer);
      
      this._peerCache.set(src, { id: pid, ip, port: +port, lastSeen: Date.now() });
      this.emit('connection', peer, { peerId: pid, address: ip, port: +port, nat: this.natType });
      peer.emit('open');
    } else {
      const peer = this._peers.get(pid);
      if (peer) peer._touch(src);
    }
  }

  _registerPeer(pid, src, theirPubRaw) {
    if (this._peers.has(pid)) return false;
    if (this._peers.size >= this._maxPeers) return false;
    const peer = new Peer(this, pid, src);
    peer._theirPubRaw = theirPubRaw;
    const raw   = deriveSession(this._myX25519.privateKey, theirPubRaw);
    const iAmLo = this._id < pid;
    peer._session = {
      sendKey:   iAmLo ? raw.sendKey : raw.recvKey,
      recvKey:   iAmLo ? raw.recvKey : raw.sendKey,
      sessionId: raw.sessionId,
      sendCtr:   0n,
    };
    this._peers.set(pid, peer);
    this._addrToId.set(src, pid);
    this._dialing.delete(pid);
    return true;
  }

_onData(buf, src) {
    if (buf.length < 2) return;
    const pid  = this._addrToId.get(src);
    const peer = pid ? this._peers.get(pid) : null;
    if (!peer?._session) return;

    const plain = decrypt(peer._session, buf.slice(1));
    if (!plain) return;

    peer._touch(src);
    peer._onAck();
    peer._scoreUp();

    const msgKey = xorHash(plain);
    this._payloadCache.set(msgKey, buf);
    this._ihaveBuf.push(Buffer.from(msgKey, 'hex'));

if (plain.length > 0 && plain[0] === 0x7B) { 
      try {
        const obj = JSON.parse(plain.toString());
        if (obj._gossip) { this._meet(obj); return; }
      } catch {}
    }

    if (plain.length >= 4) {
      const seq  = plain.readUInt32BE(0);
      const data = plain.slice(4);
      peer._jitter.push(seq, data);
    } else {
      if (this._bloom.seen(msgKey)) return;
      peer.emit('data', plain);
      this.emit('data', plain, peer);
      this._floodMesh(plain, pid);
    }
  }

  _onFrag(buf, src) {
    if (buf.length < 1 + FRAG_HDR) return;
    const pid  = this._addrToId.get(src);
    const peer = pid ? this._peers.get(pid) : null;
    if (!peer) return;
    const payload   = buf.slice(1);
    const fragId    = payload.slice(0, 8);
    const fragIdx   = payload.readUInt16BE(8);
    const fragTotal = payload.readUInt16BE(10);
    const data      = payload.slice(FRAG_HDR);
    const assembled = peer._fragger.add(fragId, fragIdx, fragTotal, data);
    if (assembled) {
      const msgKey = xorHash(assembled);
      if (this._bloom.seen(msgKey)) return;
      peer.emit('data', assembled);
      this.emit('data', assembled, peer);
      this._floodMesh(assembled, peer.id);
    }
  }

  _onPing(buf, src) {
    let pid  = this._addrToId.get(src);
    if (!pid && buf.length >= 17) {
      const senderId = buf.slice(9, 17).toString('hex');
      if (this._peers.has(senderId)) pid = senderId;
    }
    const peer = pid ? this._peers.get(pid) : null;
    if (peer) peer._touch(src);
    const idBuf = Buffer.from(this._id, 'hex');
    const pong  = Buffer.allocUnsafe(1 + idBuf.length);
    pong[0] = F_PONG;
    idBuf.copy(pong, 1);
    try { const [ip, port] = src.split(':'); this._sock.send(pong, 0, pong.length, +port, ip); } catch {}
  }

  _onPong(buf, src) {
    let pid  = this._addrToId.get(src);
    if (!pid && buf.length >= 9) {
      const senderId = buf.slice(1, 9).toString('hex');
      if (this._peers.has(senderId)) pid = senderId;
    }
    const peer = pid ? this._peers.get(pid) : null;
    if (!peer) return;
    if (!this._addrToId.has(src)) this._addrToId.set(src, peer.id);
    const rtt = peer._lastPingSent ? Date.now() - peer._lastPingSent : peer.rtt;
    peer._touch(src, rtt);
    peer._onAck();
    peer.rtt = peer.rtt + RTT_ALPHA * (rtt - peer.rtt);
  }

  _onGoaway(src) {
    const pid = this._addrToId.get(src);
    if (pid) { this._drop(pid); this.emit('disconnect', pid); }
  }

_sendHaveSummary(peer) {
    const keys = [...this._store.keys()].slice(0, HAVE_BATCH);
    if (!keys.length) return;
    this._sendHaveKeys(peer, keys);
  }

  _announceHave(keys) {
    for (const peer of this.meshPeers) {
      if (peer._session && peer._open) this._sendHaveKeys(peer, keys);
    }
  }

  _sendHaveKeys(peer, keys) {
    const parts = [Buffer.from([F_HAVE, keys.length])];
    for (const k of keys) {
      const kb = Buffer.from(k);
      parts.push(Buffer.from([kb.length]), kb);
    }
    peer.writeCtrl(Buffer.concat(parts));
  }

  _sendWant(key) {
    const kb  = Buffer.from(key);
    const msg = Buffer.allocUnsafe(2 + kb.length);
    msg[0] = F_WANT;
    msg[1] = kb.length;
    kb.copy(msg, 2);
    const targets = this.meshPeers.length > 0 ? this.meshPeers : this.peers;
    for (const peer of targets) {
      if (peer._session && peer._open) peer.writeCtrl(msg);
    }
  }

  _onHave(buf, src) {
    if (buf.length < 3) return;
    const pid  = this._addrToId.get(src);
    const peer = pid ? this._peers.get(pid) : null;
    if (!peer) return;

    const count = buf[1];
    let off = 2;
    for (let i = 0; i < count; i++) {
      if (off >= buf.length) break;
      const klen = buf[off++];
      if (off + klen > buf.length) break;
      const key = buf.slice(off, off + klen).toString();
      off += klen;
      if (this._wantPending.has(key)) {
        const kb  = Buffer.from(key);
        const msg = Buffer.allocUnsafe(2 + kb.length);
        msg[0] = F_WANT;
        msg[1] = kb.length;
        kb.copy(msg, 2);
        peer.writeCtrl(msg);
      }
    }
  }

  _onWant(buf, src) {
    if (buf.length < 3) return;
    const pid  = this._addrToId.get(src);
    const peer = pid ? this._peers.get(pid) : null;
    if (!peer) return;

    const klen = buf[1];
    if (buf.length < 2 + klen) return;
    const key   = buf.slice(2, 2 + klen).toString();
    const value = this._store.get(key);
    if (!value) return;

    const kb = Buffer.from(key);

    if (value.length <= SYNC_CHUNK_SIZE) {
      const msg = Buffer.allocUnsafe(1 + 1 + kb.length + 2 + value.length);
      let o = 0;
      msg[o++] = F_CHUNK;
      msg[o++] = kb.length;
      kb.copy(msg, o); o += kb.length;
      msg.writeUInt16BE(value.length, o); o += 2;
      value.copy(msg, o);
      peer.writeCtrl(msg);
      return;
    }

    const total      = Math.ceil(value.length / SYNC_CHUNK_SIZE);
    const [ip, port] = peer._best.split(':');
    const WINDOW     = 8;
    const RTO_MS     = 1500;

    const txKey = `${key}:${pid}`;
    if (!this._reliableTx) this._reliableTx = new Map();
    if (this._reliableTx.has(txKey)) return;

    const acked  = new Uint8Array(total);
    const timers = new Array(total);
    const tx     = { acked, timers, done: false };
    this._reliableTx.set(txKey, tx);

    const cleanup = () => {
      tx.done = true;
      timers.forEach(t => clearTimeout(t));
      this._reliableTx.delete(txKey);
    };
    setTimeout(cleanup, 60000);

    const sendFrame = (i) => {
      if (tx.done || acked[i]) return;
      const chunk = value.slice(i * SYNC_CHUNK_SIZE, Math.min((i + 1) * SYNC_CHUNK_SIZE, value.length));
      const msg   = Buffer.allocUnsafe(1 + 1 + kb.length + 2 + 2 + 2 + chunk.length);
      let o = 0;
      msg[o++] = F_CHUNK;
      msg[o++] = kb.length;
      kb.copy(msg, o); o += kb.length;
      msg.writeUInt16BE(0xFFFF, o); o += 2;
      msg.writeUInt16BE(i, o); o += 2;
      msg.writeUInt16BE(total, o); o += 2;
      chunk.copy(msg, o);
      try { this._batch.send(ip, port, msg); } catch {}
      clearTimeout(timers[i]);
      timers[i] = setTimeout(() => { if (!tx.done && !acked[i]) sendFrame(i); }, RTO_MS);
    };

    tx.onAck = (idx) => {
      acked[idx] = 1;
      clearTimeout(timers[idx]);
      if (acked.every((v, i) => i >= total || v)) { cleanup(); return; }
      for (let i = 0; i < total; i++) {
        if (!acked[i] && !timers[i]) { sendFrame(i); break; }
      }
    };

    let sent = 0;
    for (let i = 0; i < total && sent < WINDOW; i++) {
      sendFrame(i);
      sent++;
    }
  }

  _onChunkAck(buf, src) {
    if (buf.length < 5) return;
    let o = 1;
    const klen = buf[o++];
    if (o + klen + 2 > buf.length) return;
    const key = buf.slice(o, o + klen).toString(); o += klen;
    const idx = buf.readUInt16BE(o);
    const pid = this._addrToId.get(src);
    if (!pid) return;
    const tx = this._reliableTx?.get(`${key}:${pid}`);
    if (!tx || tx.done) return;
    tx.onAck(idx);
  }

  _onChunk(buf, src) {
    if (buf.length < 4) return;
    let o    = 1;
    const klen  = buf[o++];
    if (o + klen > buf.length) return;
    const key   = buf.slice(o, o + klen).toString(); o += klen;
    if (o + 2 > buf.length) return;
    const vlen  = buf.readUInt16BE(o); o += 2;

    if (vlen !== 0xFFFF) {
      if (o + vlen > buf.length) return;
      const value = buf.slice(o, o + vlen);
      this._store.add(key, value);
      if (this._storage) this._storage.set(key, value).catch(() => {});
      const pending = this._wantPending.get(key);
      if (pending) {
        clearTimeout(pending.timer);
        this._wantPending.delete(key);
        pending.resolve(value);
      }
      this.emit('sync', key, value);
    } else {
      if (o + 4 > buf.length) return;
      const idx   = buf.readUInt16BE(o); o += 2;
      const total = buf.readUInt16BE(o); o += 2;
      const data  = buf.slice(o);

      const kb2  = Buffer.from(key);
      const ack  = Buffer.allocUnsafe(1 + 1 + kb2.length + 2);
      let ao = 0;
      ack[ao++] = F_CHUNK_ACK;
      ack[ao++] = kb2.length;
      kb2.copy(ack, ao); ao += kb2.length;
      ack.writeUInt16BE(idx, ao);
      const pid2 = this._addrToId.get(src);
      const peer2 = pid2 ? this._peers.get(pid2) : null;
      if (peer2) {
        const [ip2, port2] = peer2._best.split(':');
        try { this._batch.send(ip2, port2, ack); } catch {}
      }

      if (!this._chunkAssembly) this._chunkAssembly = new Map();
      let asm = this._chunkAssembly.get(key);
      if (!asm) {
        asm = { total, pieces: new Map(), timer: setTimeout(() => this._chunkAssembly?.delete(key), SYNC_TIMEOUT) };
        this._chunkAssembly.set(key, asm);
      }
      asm.pieces.set(idx, data);
      if (asm.pieces.size === asm.total) {
        clearTimeout(asm.timer);
        this._chunkAssembly.delete(key);
        const parts = [];
        for (let i = 0; i < asm.total; i++) parts.push(asm.pieces.get(i));
        const value = Buffer.concat(parts);
        this._store.add(key, value);
        if (this._storage) this._storage.set(key, value).catch(() => {});
        const pending = this._wantPending.get(key);
        if (pending) {
          clearTimeout(pending.timer);
          this._wantPending.delete(key);
          pending.resolve(value);
        }
        this.emit('sync', key, value);
      }
    }
  }

  _checkBecomeRelay() {
    if (this._isRelay) return;
    const natOk = RELAY_NAT_OPEN.has(this.natType) || this.natType === 'full_cone';
    if (!natOk) return;
    if (!this._ext) return;
    this._isRelay = true;
    this._announceRelay();
    this._announceRelayDHT();
    this._relayAnnTimer = setInterval(() => {
      this._announceRelay();
      this._announceRelayDHT();
    }, RELAY_ANN_MS);
    this._announcers.push(this._relayAnnTimer);
  }

  _announceRelayDHT() {
    if (!this._dht || !this._ext || !this._topicHash) return;
    this._dht.put(
      `relay:${this._topicHash}:${this._id}`,
      JSON.stringify({ id: this._id, ip: this._ext.ip, port: this._ext.port })
    );
  }

  _announceRelay() {
    if (!this._isRelay || !this._ext) return;
    const idBuf   = Buffer.from(this._id, 'hex');
    const ipBuf   = Buffer.from(this._ext.ip);
    const frame   = Buffer.allocUnsafe(1 + 8 + 1 + ipBuf.length + 2);
    let o = 0;
    frame[o++] = F_RELAY_ANN;
    idBuf.copy(frame, o); o += 8;
    frame[o++] = ipBuf.length;
    ipBuf.copy(frame, o); o += ipBuf.length;
    frame.writeUInt16BE(this._ext.port, o);
    for (const peer of this.peers) {
      if (peer._open) peer.writeCtrl(frame);
    }
  }

  _registerRelay(id, ip, port) {
    if (this._relays.size >= RELAY_MAX) {
      const oldest = [...this._relays.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0];
      if (oldest) this._relays.delete(oldest[0]);
    }
    this._relays.set(id, { id, ip, port, lastSeen: Date.now(), fails: 0 });
  }

  _onRelayAnn(buf, src) {
    if (buf.length < 12) return;
    let o = 1;
    const id    = buf.slice(o, o + 8).toString('hex'); o += 8;
    if (id === this._id) return;
    const ipLen = buf[o++];
    if (o + ipLen + 2 > buf.length) return;
    const ip    = buf.slice(o, o + ipLen).toString(); o += ipLen;
    const port  = buf.readUInt16BE(o);

    const ban = this._relayBans.get(id);
    if (ban && Date.now() - ban < RELAY_BAN_MS) return;

    this._registerRelay(id, ip, port);
  }

  _requestViaRelay(targetId) {
    const relayList = [...this._relays.values()].filter(r => {
      const ban = this._relayBans.get(r.id);
      return !ban || Date.now() - ban >= RELAY_BAN_MS;
    });
    if (!relayList.length) return false;

    const relay  = relayList.sort((a, b) => b.lastSeen - a.lastSeen)[0];
    const myId   = Buffer.from(this._id, 'hex');
    const tgtId  = Buffer.from(targetId, 'hex');
    const myIp   = Buffer.from(this._ext?.ip || this._lip);
    const frame  = Buffer.allocUnsafe(1 + 8 + 8 + 1 + myIp.length + 2);
    let o = 0;
    frame[o++] = F_RELAY_REQ;
    myId.copy(frame, o); o += 8;
    tgtId.copy(frame, o); o += 8;
    frame[o++] = myIp.length;
    myIp.copy(frame, o); o += myIp.length;
    frame.writeUInt16BE(this._lport, o);
    try { this._sock.send(frame, 0, frame.length, relay.port, relay.ip); } catch {}
    return true;
  }

  _onRelayReq(buf, src) {
    if (!this._isRelay) return;
    if (buf.length < 18) return;
    let o = 1;
    const fromId  = buf.slice(o, o + 8).toString('hex'); o += 8;
    const toId    = buf.slice(o, o + 8).toString('hex'); o += 8;
    const ipLen   = buf[o++];
    if (o + ipLen + 2 > buf.length) return;
    const fromIp  = buf.slice(o, o + ipLen).toString(); o += ipLen;
    const fromPort= buf.readUInt16BE(o);
    const fwdIdBuf = Buffer.from(fromId, 'hex');
    const fwdIpBuf = Buffer.from(fromIp);
    const fwd      = Buffer.allocUnsafe(1 + 8 + 1 + fwdIpBuf.length + 2);
    let fo = 0;
    fwd[fo++] = F_RELAY_FWD;
    fwdIdBuf.copy(fwd, fo); fo += 8;
    fwd[fo++] = fwdIpBuf.length;
    fwdIpBuf.copy(fwd, fo); fo += fwdIpBuf.length;
    fwd.writeUInt16BE(fromPort, fo);

    const toPeer = this._peers.get(toId);
    if (toPeer && toPeer._open) {
      toPeer.writeCtrl(fwd);
    }
  }

  _onRelayFwd(buf, src) {
    if (buf.length < 12) return;
    let o = 1;
    const id    = buf.slice(o, o + 8).toString('hex'); o += 8;
    const ipLen = buf[o++];
    if (o + ipLen + 2 > buf.length) return;
    const ip    = buf.slice(o, o + ipLen).toString(); o += ipLen;
    const port  = buf.readUInt16BE(o);
    if (id === this._id) return;
    if (!this._peers.has(id)) this._dial(ip, port, id, null, null);
  }

  _initPex() {
    const t = setInterval(() => {
      if (this._destroyed) return;
      for (const peer of this.peers) {
        if (peer._open && peer._session) this._sendPex(peer);
      }
    }, PEX_INTERVAL);
    this._announcers.push(t);
  }

  _sendPex(peer) {
    const known = this.peers
      .filter(p => p.id !== peer.id && p._open && p._best)
      .slice(0, PEX_MAX);
    if (!known.length) return;

    const parts = [Buffer.from([F_PEX, known.length])];
    for (const p of known) {
      const [pip, pport] = p._best.split(':');
      const idBuf  = Buffer.from(p.id, 'hex');
      const ipBuf  = Buffer.from(pip);
      const entry  = Buffer.allocUnsafe(1 + idBuf.length + 1 + ipBuf.length + 2);
      let o = 0;
      entry[o++] = idBuf.length;
      idBuf.copy(entry, o); o += idBuf.length;
      entry[o++] = ipBuf.length;
      ipBuf.copy(entry, o); o += ipBuf.length;
      entry.writeUInt16BE(+pport, o);
      parts.push(entry);
    }
    peer.writeCtrl(Buffer.concat(parts));
  }

  _onPex(buf, src) {
    if (buf.length < 3) return;
    const count = buf[1];
    let o = 2;
    for (let i = 0; i < count; i++) {
      if (o >= buf.length) break;
      const idLen = buf[o++];
      if (o + idLen > buf.length) break;
      const id = buf.slice(o, o + idLen).toString('hex'); o += idLen;
      if (o >= buf.length) break;
      const ipLen = buf[o++];
      if (o + ipLen + 2 > buf.length) break;
      const ip   = buf.slice(o, o + ipLen).toString(); o += ipLen;
      const port = buf.readUInt16BE(o); o += 2;

      if (id === this._id) continue;
      if (this._peers.has(id)) continue;
      const addr = `${ip}:${port}`;
      this._peerCache.set(addr, { id, ip, port, lastSeen: Date.now() });
      this._dial(ip, port, id, null, null);
    }
  }

  _loadPeerCache() {
    if (!this._onLoadPeers) return;
    try {
      const list = this._onLoadPeers();
      if (!Array.isArray(list)) return;
      for (const entry of list) {
        if (entry.ip && entry.port) {
          this._peerCache.set(`${entry.ip}:${entry.port}`, entry);
        }
      }
    } catch {}
  }

  _emitPeerCache() {
    const list = [...this._peerCache.values()]
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .slice(0, 200);
    this.emit('peers', list);
    if (this._onSavePeers) {
      try { this._onSavePeers(list); } catch {}
    }
  }

  _initPeerCacheEmit() {
    const t = setInterval(() => {
      if (this._destroyed) return;
      this._emitPeerCache();
    }, PEER_CACHE_EMIT_MS);
    this._announcers.push(t);
  }

  _dialPeerCache() {
    const entries = [...this._peerCache.values()]
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .slice(0, 30);
    for (const e of entries) {
      if (e.id && this._peers.has(e.id)) continue;
      this._dial(e.ip, e.port, e.id || null, null, null);
    }
  }

  _dialHardcodedSeeds() {
    for (const hostport of this._hardcodedSeeds) {
      const c = hostport.lastIndexOf(':');
      if (c === -1) continue;
      const host = hostport.slice(0, c);
      const port = parseInt(hostport.slice(c + 1)) || 49737;
      dns.resolve4(host, (err, addrs) => {
        const ips = err ? [host] : addrs;
        ips.forEach(ip => this._dial(ip, port, null, null, null));
      });
    }
  }

  _queryBootstrapHttp() {
    if (!this._bootstrapHttp.length) return;
    for (const url of this._bootstrapHttp) {
      const base = url.replace(/\/$/, '');
      const lib  = base.startsWith('https') ? require('https') : require('http');
      const announceIp   = this._ext ? this._ext.ip   : this._lip;
      const announcePort = this._ext ? this._ext.port : this._lport;
      if (announceIp && announcePort) {
        const body = Buffer.from(JSON.stringify({
          id:   this._id,
          ip:   announceIp,
          port: announcePort,
        }));
        const announceUrl = new URL(base + '/announce');
        const req = lib.request({
          hostname: announceUrl.hostname,
          port:     announceUrl.port || (base.startsWith('https') ? 443 : 80),
          path:     '/announce',
          method:   'POST',
          headers:  { 'Content-Type': 'application/json', 'Content-Length': body.length },
        }, (res) => { res.resume(); });
        req.on('error', () => {});
        req.setTimeout(8000, () => req.destroy());
        req.write(body);
        req.end();
      }

      const peersUrl = base + '/peers';
      const req2 = lib.get(peersUrl, (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', c => { buf += c; });
        res.on('end', () => {
          try {
            const list = JSON.parse(buf);
            if (!Array.isArray(list)) return;
            for (const p of list) {
              if (!p.ip || !p.port) continue;
              this._peerCache.set(`${p.ip}:${p.port}`, { ...p, lastSeen: Date.now() });
              if (p.id && this._peers.has(p.id)) continue;
              this._dial(p.ip, p.port, p.id || null, null, null);
            }
          } catch {}
        });
      });
      req2.on('error', () => {});
      req2.setTimeout(8000, () => req2.destroy());
    }
  }

  _startBootstrapAnnounce() {
  const doAnnounce = () => {
    if (this._destroyed) return;
    this._queryBootstrapHttp();
  };

  if (this._ext) {
    doAnnounce();
  } else {
    this.once('nat', () => doAnnounce());
  }

  const t = setInterval(doAnnounce, 3 * 60 * 1000);
  this._announcers.push(t);
}

  _bestRelay() {
    const now = Date.now();
    return [...this._relays.values()]
      .filter(r => {
        const ban = this._relayBans.get(r.id);
        return (!ban || now - ban >= RELAY_BAN_MS) && r.fails < 3;
      })
      .sort((a, b) => b.lastSeen - a.lastSeen)[0] || null;
  }

  _heartbeat() {
    this._hb = setInterval(() => {
      if (this._destroyed) return;
      const now = Date.now();

      const dead = [];
      this._peers.forEach((peer, pid) => {
        if (now - peer._seen > PEER_TIMEOUT) dead.push(pid);
        else if (now - peer._lastPong > 5000 && !peer._lossSignaled) {
          peer._lossSignaled = true;
          peer._onLoss();
        }
      });
      dead.forEach(pid => { this._drop(pid); this.emit('disconnect', pid); });

      this._maintainMesh();
      this._adaptMeshDegree();
      this._emitIhave();

      const idBuf2 = Buffer.from(this._id, 'hex');
      this._peers.forEach(peer => {
        const now2   = Date.now();
        const ping   = Buffer.allocUnsafe(9 + idBuf2.length);
        ping[0] = F_PING;
        ping.writeBigUInt64BE(BigInt(now2), 1);
        idBuf2.copy(ping, 9);
        peer._lastPingSent = now2;
        const [ip, port] = peer._best.split(':');
        try { this._sock.send(ping, 0, ping.length, +port, ip); } catch {}
      });
    }, HEARTBEAT_MS);
  }

  _addToMesh(peer) {
    if (this.meshPeers.length < this._meshD) {
      peer.inMesh    = true;
      peer._meshTime = Date.now();
    }
  }

  _floodMesh(plain, excludePid) {
    for (const peer of this.meshPeers) {
      if (peer.id !== excludePid && peer._session && peer._open)
        peer._enqueue(plain);
    }
  }

  _maintainMesh() {
    const mesh    = this.meshPeers;
    const nonMesh = this.peers.filter(p => !p.inMesh && p._session);
    if (mesh.length > D_HIGH)
      mesh.sort((a, b) => a.score - b.score)
          .slice(0, mesh.length - this._meshD)
          .forEach(p => { p.inMesh = false; });
    if (mesh.length < D_LOW && nonMesh.length)
      nonMesh.sort((a, b) => b.score - a.score)
             .slice(0, this._meshD - mesh.length)
             .forEach(p => { p.inMesh = true; p._meshTime = Date.now(); });
  }

  _adaptMeshDegree() {
    if (Date.now() - this._lastMeshAdapt < 5000) return;
    this._lastMeshAdapt = Date.now();
    const ps = this.peers.filter(p => p._session);
    if (!ps.length) return;
    const avgRtt = ps.reduce((s, p) => s + p.rtt, 0) / ps.length;
    if      (avgRtt > 200 && this._meshD > D_MIN) this._meshD--;
    else if (avgRtt < 50  && this._meshD < D_MAX && ps.length > this._meshD + 2) this._meshD++;

    ps.filter(p => !p.inMesh && p.bandwidth > 50_000)
      .sort((a, b) => b.bandwidth - a.bandwidth)
      .slice(0, 2)
      .forEach(p => { p.inMesh = true; p._meshTime = Date.now(); });
  }

  _emitIhave() {
    if (!this._ihaveBuf.length) return;
    const ids     = this._ihaveBuf.splice(-IHAVE_MAX);
    const targets = this.peers.filter(p => !p.inMesh && p._session).slice(0, D_GOSSIP);
    if (!targets.length) return;
    const inner   = Buffer.concat(ids);
    const payload = Buffer.allocUnsafe(1 + inner.length);
    payload[0]    = 0x07;
    inner.copy(payload, 1);
    targets.forEach(p => p.writeCtrl(payload));
  }

  _dial(ip, port, id, lip, lport) {
    const key = id || `${ip}:${port}`;
    if (this._dialing.has(key)) return;
    if (id && this._peers.has(id)) return;
    this._dialing.add(key);
    for (let i = 0; i < PUNCH_TRIES; i++)
      setTimeout(() => this._sendHello(ip, port), i * PUNCH_INTERVAL);
    if (lip && lport)
      for (let i = 0; i < PUNCH_TRIES; i++)
        setTimeout(() => this._sendHello(lip, lport), i * PUNCH_INTERVAL);
    setTimeout(() => {
      if (!this._peers.has(id)) this._dialing.delete(key);
    }, PUNCH_TRIES * PUNCH_INTERVAL + 3000);
  }

  _meet(info) {
    if (!info?.id || info.id === this._id) return;
    if (!info.ip || !info.port) return;
    this._dial(info.ip, info.port, info.id, info.lip, info.lport);
  }

  _gossipPeer(ip, port, newId) {
    if (this._gossipSeen.seen(newId)) return;
    const info    = { id: newId, ip, port };
    const payload = Buffer.from(JSON.stringify({ _gossip: true, ...info }));
    this._peers.forEach((peer, pid) => {
      if (pid === newId || !peer._session || !peer._open) return;
      peer._enqueue(payload);
    });
  }

  _drop(pid) {
    const peer = this._peers.get(pid);
    if (peer) peer.destroy();
    this._peers.delete(pid);
    this._dialing.delete(pid);
  }

  _me() {
    return { id: this._id, ip: this._ext?.ip, port: this._ext?.port, lip: this._lip, lport: this._lport, nat: this.natType };
  }
}

module.exports = Swarm;

