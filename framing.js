'use strict';

const crypto = require('crypto');
const {
  MAX_PAYLOAD, FRAG_HDR, FRAG_DATA_MAX, FRAG_TIMEOUT,
  BATCH_MTU, BATCH_INTERVAL, F_BATCH,
} = require('./constants');

class FragmentAssembler {
  constructor() { this._pending = new Map(); }

  add(fragId, fragIdx, fragTotal, data) {
    const key = fragId.toString('hex');
    let entry = this._pending.get(key);
    if (!entry) {
      entry = {
        total:  fragTotal,
        pieces: new Map(),
        timer:  setTimeout(() => this._pending.delete(key), FRAG_TIMEOUT),
      };
      this._pending.set(key, entry);
    }
    entry.pieces.set(fragIdx, data);
    if (entry.pieces.size === entry.total) {
      clearTimeout(entry.timer);
      this._pending.delete(key);
      const parts = [];
      for (let i = 0; i < entry.total; i++) parts.push(entry.pieces.get(i));
      return Buffer.concat(parts);
    }
    return null;
  }

  clear() {
    for (const e of this._pending.values()) clearTimeout(e.timer);
    this._pending.clear();
  }
}

function fragmentPayload(payload) {
  if (payload.length <= MAX_PAYLOAD) return null;
  const fragId = crypto.randomBytes(8);
  const total  = Math.ceil(payload.length / FRAG_DATA_MAX);
  const frags  = [];
  for (let i = 0; i < total; i++) {
    const chunk = payload.slice(i * FRAG_DATA_MAX, Math.min((i + 1) * FRAG_DATA_MAX, payload.length));
    const hdr   = Buffer.allocUnsafe(FRAG_HDR);
    fragId.copy(hdr, 0);
    hdr.writeUInt16BE(i, 8);
    hdr.writeUInt16BE(total, 10);
    frags.push(Buffer.concat([hdr, chunk]));
  }
  return { fragId, total, frags };
}

class JitterBuffer {
  constructor(onDeliver) {
    this._buf     = new Map();
    this._next    = 0;
    this._deliver = onDeliver;
  }

  push(seq, data) {
    if (seq < this._next) return;
    if (seq === this._next) {
      this._deliver(data);
      this._next++;
      this._flush();
    } else {
      this._buf.set(seq, data);
      setTimeout(() => {
        if (this._buf.has(seq) && seq >= this._next) {
          this._next = seq;
          this._deliver(this._buf.get(seq));
          this._buf.delete(seq);
          this._flush();
        }
      }, 50);
    }
  }

  _flush() {
    while (this._buf.has(this._next)) {
      this._deliver(this._buf.get(this._next));
      this._buf.delete(this._next);
      this._next++;
    }
  }

  clear() { this._buf.clear(); }
}

function xorHash(buf) {
  let a = 0x811C9DC5, b = 0x811C9DC5;
  for (let i = 0; i < buf.length; i++) {
    if (i & 1) { b ^= buf[i]; b = Math.imul(b, 0x01000193) >>> 0; }
    else        { a ^= buf[i]; a = Math.imul(a, 0x01000193) >>> 0; }
  }
  const out = Buffer.allocUnsafe(8);
  out.writeUInt32BE(a, 0);
  out.writeUInt32BE(b, 4);
  return out.toString('hex');
}

class BatchSender {
  constructor(sock, diagnostics = null, peerResolver = null) {
    this._sock    = sock;
    this._pending = new Map(); 
    this._timer   = null;
    this._diagnostics = diagnostics;
    this._peerResolver = peerResolver;
  }

  send(ip, port, buf) {
    const key = `${ip}:${port}`;
    if (!this._pending.has(key)) this._pending.set(key, []);
    this._pending.get(key).push(buf);
    if (!this._timer) this._timer = setTimeout(() => this._flush(), BATCH_INTERVAL);
  }

  sendNow(ip, port, buf) {
    
    this._recordSend(ip, port, buf);
    try { this._sock.send(buf, 0, buf.length, +port, ip); } catch {}
  }

  _flush() {
    this._timer = null;
    for (const [key, bufs] of this._pending) {
      const [ip, port] = key.split(':');
      let batch = [];
      let size  = 0;
      for (const b of bufs) {
        if (size + b.length + 2 > BATCH_MTU && batch.length) {
          this._sendBatch(ip, port, batch);
          batch = []; size = 0;
        }
        batch.push(b);
        size += b.length + 2;
      }
      if (batch.length) this._sendBatch(ip, port, batch);
    }
    this._pending.clear();
  }

  _sendBatch(ip, port, bufs) {
    if (bufs.length === 1) {
      this._recordSend(ip, port, bufs[0]);
      try { this._sock.send(bufs[0], 0, bufs[0].length, +port, ip); } catch {}
      return;
    }
    const parts = [Buffer.from([F_BATCH, bufs.length])];
    for (const b of bufs) {
      const lenBuf = Buffer.allocUnsafe(2);
      lenBuf.writeUInt16BE(b.length, 0);
      parts.push(lenBuf, b);
    }
    const out = Buffer.concat(parts);
    this._recordSend(ip, port, out);
    try { this._sock.send(out, 0, out.length, +port, ip); } catch {}
  }

  _recordSend(ip, port, buf) {
    if (!this._diagnostics?.enabled) return;
    const address = `${ip}:${port}`;
    const peerId = this._peerResolver ? this._peerResolver(address) : null;
    this._diagnostics.recordSend({
      bytes: buf.length,
      type: this._diagnostics.frameName(buf, 'UDP_BATCH'),
      peerId,
      address,
    });
  }

  destroy() { if (this._timer) { clearTimeout(this._timer); this._flush(); } }
}

module.exports = { FragmentAssembler, fragmentPayload, JitterBuffer, xorHash, BatchSender };
