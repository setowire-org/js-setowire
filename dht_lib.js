'use strict';

const dgram  = require('dgram');
const crypto = require('crypto');
const EventEmitter = require('events');

const K          = 20;    
const ALPHA      = 3;     
const ID_BITS    = 160;   
const ID_BYTES   = 20;
const TIMEOUT_MS = 5000;  
const REPUBLISH  = 60 * 60 * 1000; 

const MSG_PING       = 0x01;
const MSG_PONG       = 0x02;
const MSG_STORE      = 0x03;
const MSG_FIND_NODE  = 0x04;
const MSG_FOUND_NODE = 0x05;
const MSG_FIND_VALUE = 0x06;
const MSG_FOUND_VAL  = 0x07;

function sha1(str) {
  return crypto.createHash('sha1').update(str).digest();
}

function randomId() {
  return crypto.randomBytes(ID_BYTES);
}

function xorDistance(a, b) {
  const d = Buffer.alloc(ID_BYTES);
  for (let i = 0; i < ID_BYTES; i++) d[i] = a[i] ^ b[i];
  return d;
}

function cmpDistance(d1, d2) {
  for (let i = 0; i < ID_BYTES; i++) {
    if (d1[i] < d2[i]) return -1;
    if (d1[i] > d2[i]) return 1;
  }
  return 0;
}

function bucketIndex(selfId, otherId) {
  const d = xorDistance(selfId, otherId);
  for (let i = 0; i < ID_BYTES; i++) {
    if (d[i] === 0) continue;
    let bit = 7;
    let byte = d[i];
    while (byte > 1) { byte >>= 1; bit--; }
    return i * 8 + (7 - bit);
  }
  return ID_BITS - 1;
}

function encode(msg) {
  return Buffer.from(JSON.stringify(msg));
}
function decode(buf) {
  try { return JSON.parse(buf.toString()); } catch { return null; }
}

class KBucket {
  constructor() {
    this.nodes = []; 
  }

  add(node) {
    const existing = this.nodes.findIndex(n => n.id === node.id);
    if (existing >= 0) {
      
      this.nodes.splice(existing, 1);
      this.nodes.push({ ...node, lastSeen: Date.now() });
      return;
    }
    if (this.nodes.length < K) {
      this.nodes.push({ ...node, lastSeen: Date.now() });
    }
    
  }

  remove(id) {
    this.nodes = this.nodes.filter(n => n.id !== id);
  }

closest(targetIdBuf, count = K) {
    return [...this.nodes]
      .sort((a, b) => {
        const da = xorDistance(Buffer.from(a.id, 'hex'), targetIdBuf);
        const db = xorDistance(Buffer.from(b.id, 'hex'), targetIdBuf);
        return cmpDistance(da, db);
      })
      .slice(0, count);
  }
}

class RoutingTable {
  constructor(selfId) {
    this.selfId  = selfId; 
    this.buckets = Array.from({ length: ID_BITS }, () => new KBucket());
  }

  add(node) {
    if (node.id === this.selfId.toString('hex')) return;
    const idx = bucketIndex(this.selfId, Buffer.from(node.id, 'hex'));
    this.buckets[idx].add(node);
  }

  remove(id) {
    const idx = bucketIndex(this.selfId, Buffer.from(id, 'hex'));
    this.buckets[idx].remove(id);
  }

closest(target, count = K) {
    const targetBuf = Buffer.isBuffer(target) ? target : Buffer.from(target, 'hex');
    const all = [];
    for (const b of this.buckets) all.push(...b.nodes);
    return all
      .sort((a, b) => {
        const da = xorDistance(Buffer.from(a.id, 'hex'), targetBuf);
        const db = xorDistance(Buffer.from(b.id, 'hex'), targetBuf);
        return cmpDistance(da, db);
      })
      .slice(0, count);
  }

  get size() {
    return this.buckets.reduce((s, b) => s + b.nodes.length, 0);
  }
}

class SimpleDHT extends EventEmitter {
  constructor(opts = {}) {
    super();

    const idBuf   = opts.nodeId ? Buffer.from(opts.nodeId, 'hex') : randomId();
    this.nodeId   = idBuf.toString('hex');
    this._idBuf   = idBuf;
    this.port     = opts.port || 0;

    this.storage  = new Map();    
    this._table   = new RoutingTable(idBuf);
    this._pending = new Map();    
    this._sock    = null;
    this._ready   = false;
    this._diagnostics = opts.diagnostics || null;

    this._startSocket();
    this._scheduleRepublish();
  }

_startSocket() {
    this._sock = dgram.createSocket('udp4');
    this._sock.on('message', (buf, rinfo) => this._onMessage(buf, rinfo));
    this._sock.on('error', () => {});
    this._sock.bind(this.port, () => {
      this.port   = this._sock.address().port;
      this._ready = true;
      this.emit('ready');
    });
  }

  ready() {
    if (this._ready) return Promise.resolve();
    return new Promise(res => this.once('ready', res));
  }

_send(ip, port, msg) {
    const buf = encode(msg);
    this._diagnostics?.recordSend?.({
      bytes: buf.length,
      type: `DHT_${msg.type || 'UNKNOWN'}`,
      address: `${ip}:${port}`,
    });
    this._sock.send(buf, 0, buf.length, port, ip, () => {});
  }

  _rpc(ip, port, msg) {
    return new Promise((resolve, reject) => {
      const rpcId  = crypto.randomBytes(4).toString('hex');
      const timer  = setTimeout(() => {
        this._pending.delete(rpcId);
        reject(new Error('timeout'));
      }, TIMEOUT_MS);
      this._pending.set(rpcId, { resolve, reject, timer });
      this._send(ip, port, { ...msg, rpcId });
    });
  }

  _reply(ip, port, rpcId, msg) {
    this._send(ip, port, { ...msg, rpcId });
  }

  _onMessage(buf, rinfo) {
    this._diagnostics?.recordReceive?.({
      bytes: buf.length,
      type: 'DHT',
      address: `${rinfo.address}:${rinfo.port}`,
    });
    const msg = decode(buf);
    if (!msg) return;

if (msg.from) {
      this._table.add({ id: msg.from, ip: rinfo.address, port: rinfo.port });
    }

if (msg.rpcId && this._pending.has(msg.rpcId)) {
      const { resolve, timer } = this._pending.get(msg.rpcId);
      clearTimeout(timer);
      this._pending.delete(msg.rpcId);
      resolve(msg);
      return;
    }

switch (msg.type) {
      case MSG_PING:
        this._reply(rinfo.address, rinfo.port, msg.rpcId, {
          type: MSG_PONG, from: this.nodeId
        });
        break;

      case MSG_STORE:
        if (msg.key && msg.value !== undefined) {
          this.storage.set(msg.key, msg.value);
        }
        break;

      case MSG_FIND_NODE: {
        const target  = msg.target;
        const closest = this._table.closest(target, K)
          .map(n => ({ id: n.id, ip: n.ip, port: n.port }));
        this._reply(rinfo.address, rinfo.port, msg.rpcId, {
          type: MSG_FOUND_NODE, from: this.nodeId, nodes: closest
        });
        break;
      }

      case MSG_FIND_VALUE: {
        const key = msg.key;
        if (this.storage.has(key)) {
          this._reply(rinfo.address, rinfo.port, msg.rpcId, {
            type: MSG_FOUND_VAL, from: this.nodeId, value: this.storage.get(key)
          });
        } else {
          const closest = this._table.closest(Buffer.from(key, 'hex'), K)
            .map(n => ({ id: n.id, ip: n.ip, port: n.port }));
          this._reply(rinfo.address, rinfo.port, msg.rpcId, {
            type: MSG_FOUND_NODE, from: this.nodeId, nodes: closest
          });
        }
        break;
      }
    }
  }

addNode(nodeOrInfo) {
    const id   = nodeOrInfo.nodeId || nodeOrInfo.id;
    const ip   = nodeOrInfo.ip   || '127.0.0.1';
    const port = nodeOrInfo.port || nodeOrInfo._sock?.address?.().port;
    if (!id || !port) return;
    this._table.add({ id, ip, port });
  }

put(key, value) {
    const keyHash = sha1(key).toString('hex');
    this.storage.set(keyHash, value);

const closest = this._table.closest(Buffer.from(keyHash, 'hex'), K);
    for (const n of closest) {
      this._send(n.ip, n.port, {
        type: MSG_STORE, from: this.nodeId, key: keyHash, value
      });
    }

    return keyHash;
  }

get(key) {
    const keyHash = sha1(key).toString('hex');
    const value   = this.storage.get(keyHash);
    return value !== undefined ? value : null;
  }

async findValue(key) {
    
    const local = this.get(key);
    if (local !== null) return local;

    const keyHash  = sha1(key).toString('hex');
    const keyBuf   = Buffer.from(keyHash, 'hex');
    const visited  = new Set();
    let   shortlist = this._table.closest(keyBuf, ALPHA);

    console.log(`[SEARCH] Buscando "${key}" nos nós vizinhos...`);

    for (let round = 0; round < 20; round++) {
      const toQuery = shortlist
        .filter(n => !visited.has(n.id))
        .slice(0, ALPHA);

      if (!toQuery.length) break;

      const results = await Promise.allSettled(
        toQuery.map(n => {
          visited.add(n.id);
          return this._rpc(n.ip, n.port, {
            type: MSG_FIND_VALUE, from: this.nodeId, key: keyHash
          });
        })
      );

      for (const r of results) {
        if (r.status !== 'fulfilled') continue;
        const msg = r.value;
        if (msg.type === MSG_FOUND_VAL) {
          this.storage.set(keyHash, msg.value); 
          return msg.value;
        }
        if (msg.type === MSG_FOUND_NODE && msg.nodes) {
          for (const n of msg.nodes) {
            this._table.add(n);
            if (!visited.has(n.id)) shortlist.push(n);
          }
        }
      }

shortlist = shortlist
        .filter(n => !visited.has(n.id))
        .sort((a, b) => cmpDistance(
          xorDistance(Buffer.from(a.id, 'hex'), keyBuf),
          xorDistance(Buffer.from(b.id, 'hex'), keyBuf)
        ));
    }

    return null;
  }

async bootstrap(nodes = []) {
    for (const n of nodes) this.addNode(n);

const closest = this._table.closest(this._idBuf, ALPHA);
    await Promise.allSettled(
      closest.map(n =>
        this._rpc(n.ip, n.port, {
          type: MSG_FIND_NODE, from: this.nodeId, target: this.nodeId
        }).then(msg => {
          if (msg.nodes) msg.nodes.forEach(nn => this._table.add(nn));
        }).catch(() => {})
      )
    );
  }

_getDistance(id1, id2) {
    return xorDistance(Buffer.from(id1, 'hex'), Buffer.from(id2, 'hex')).toString('hex');
  }

  destroy() {
    clearInterval(this._republishTimer);
    try { this._sock.close(); } catch {}
  }

_scheduleRepublish() {
    this._republishTimer = setInterval(() => {
      for (const [keyHash, value] of this.storage.entries()) {
        const closest = this._table.closest(Buffer.from(keyHash, 'hex'), K);
        for (const n of closest) {
          this._send(n.ip, n.port, {
            type: MSG_STORE, from: this.nodeId, key: keyHash, value
          });
        }
      }
    }, REPUBLISH);
  }
}

module.exports = SimpleDHT;
