# Setowire - Javascript

A lightweight, portable P2P networking library built on UDP. No central servers, no brokers — peers find each other and communicate directly.

Built to be simple enough to reimplement in any language.

---

## Why

Most P2P libraries are either too heavy or too tied to a specific runtime. We wanted something small, auditable, and easy to port to Rust, Go, or whatever comes next. The protocol fits in your head.

---

## Install

```bash
npm install setowire
```

---

## How it works

Peers discover each other through multiple strategies running in parallel — whichever works first wins:

- **DHT** — decentralized peer discovery by topic
- **Piping servers** — HTTPS rendezvous for peers behind strict NATs
- **LAN multicast** — instant discovery on local networks
- **HTTP bootstrap nodes** — fallback seed servers
- **Peer cache** — remembers peers from previous sessions

Once connected, all traffic is encrypted end-to-end with X25519 + ChaCha20-Poly1305. Peers that detect they have a full-cone NAT automatically become relays for others.

---

## File structure

```
constants.js   — all tuneable parameters and frame type definitions
crypto.js      — X25519 key exchange, ChaCha20-Poly1305 encrypt/decrypt
structs.js     — BloomFilter, LRU, RingBuffer, PayloadCache
framing.js     — packet fragmentation, jitter buffer, batch UDP sender
dht_lib.js     — minimal DHT for decentralized topic-based discovery
peer.js        — per-peer state: queues, congestion control, multipath
swarm.js       — main class: discovery, mesh, relay, sync, gossip
index.js       — entry point
chat.js        — example terminal chat app
```

---

## Quick start

```js
const Swarm  = require('setowire');
const crypto = require('crypto');

const swarm = new Swarm();
const topic = crypto.createHash('sha256').update('my-topic').digest();

swarm.join(topic, { announce: true, lookup: true });

swarm.on('connection', (peer) => {
  peer.write(Buffer.from('hello'));
});

swarm.on('data', (data, peer) => {
  console.log('got:', data.toString());
});
```

---

## API

### `new Swarm(opts?)`

| option | default | description |
|---|---|---|
| `seed` | random | 32-byte hex string — deterministic identity |
| `maxPeers` | 100 | max simultaneous connections |
| `relay` | false | force relay mode regardless of NAT |
| `bootstrap` | [] | `["host:port"]` bootstrap nodes |
| `seeds` | [] | additional hardcoded seed peers |
| `storage` | null | pluggable storage backend (see [Persistent storage](#persistent-storage)) |
| `storeCacheMax` | 10000 | max entries kept in the in-memory cache |
| `onSavePeers` | null | `(peers) => {}` called when the peer cache is updated |
| `onLoadPeers` | null | `() => peers` called on startup to restore known peers |

### `swarm.join(topic, opts?)`

Start announcing and/or looking up peers on a topic. `topic` is a Buffer (usually a hash).

Returns `{ ready(), destroy() }`.

### `swarm.broadcast(data)`

Send data to all connected peers. Returns number of peers reached.

### `swarm.store(key, value)`

Store a value in the local cache, persist it to the storage backend if one is set, and announce to the mesh that you have it.

### `swarm.fetch(key, timeout?)`

Fetch a value. Lookup order:

1. In-memory cache
2. Storage backend (if set)
3. Network — sends a WANT to the mesh and waits up to `timeout` ms (default 30s)

Returns a `Promise<Buffer>`.

### `swarm.destroy()`

Graceful shutdown. Notifies peers and closes the socket.

### Events

| event | args | description |
|---|---|---|
| `connection` | `peer, info` | new peer connected |
| `data` | `data, peer` | message received |
| `disconnect` | `peerId` | peer dropped |
| `sync` | `key, value` | value received from network |
| `nat` | — | public address discovered |

---

## Persistent storage

By default, `store()` and `fetch()` only use an in-memory LRU cache — data is lost when the process exits.

To persist data across restarts, pass a `storage` object with `get` and `set` methods:

```js
const swarm = new Swarm({ storage: myBackend });
```

The backend must implement:

```ts
{
  get(key: string): Promise<Buffer | null>
  set(key: string, value: Buffer): Promise<void>
}
```

Any async key-value store works. Examples:

**LevelDB**
```js
const { Level } = require('level');
const db = new Level('./data', { valueEncoding: 'buffer' });

const swarm = new Swarm({
  storage: {
    get: (k) => db.get(k).catch(() => null),
    set: (k, v) => db.put(k, v),
  }
});
```

**SQLite (via better-sqlite3)**
```js
const Database = require('better-sqlite3');
const db = new Database('data.db');
db.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v BLOB)');

const swarm = new Swarm({
  storage: {
    get: async (k) => {
      const row = db.prepare('SELECT v FROM kv WHERE k = ?').get(k);
      return row ? row.v : null;
    },
    set: async (k, v) => {
      db.prepare('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)').run(k, v);
    },
  }
});
```

**Plain JSON file (simple, not for large data)**
```js
const fs   = require('fs');
const PATH = './store.json';

const load = () => { try { return JSON.parse(fs.readFileSync(PATH)); } catch { return {}; } };
const save = (data) => fs.writeFileSync(PATH, JSON.stringify(data));

const swarm = new Swarm({
  storage: {
    get:  async (k)    => { const d = load(); return d[k] ? Buffer.from(d[k], 'hex') : null; },
    set:  async (k, v) => { const d = load(); d[k] = v.toString('hex'); save(d); },
  }
});
```

If no `storage` is provided, the library works fine — values that aren't in memory will be fetched from the network instead.

---

## Protocol

The wire protocol is plain UDP. Each packet starts with a 1-byte frame type:

| byte | type | description |
|---|---|---|
| `0x01` | DATA | encrypted application data |
| `0x03` | PING | keepalive + RTT measurement |
| `0x04` | PONG | keepalive reply |
| `0x0A` | GOAWAY | graceful disconnect |
| `0x0B` | FRAG | fragment of a large message |
| `0x13` | BATCH | multiple frames in one datagram |
| `0x14` | CHUNK_ACK | acknowledgement for reliable multi-chunk transfers |
| `0x20` | RELAY_ANN | peer announcing itself as relay |
| `0x21` | RELAY_REQ | request introduction via relay |
| `0x22` | RELAY_FWD | relay forwarding an introduction |
| `0x30` | PEX | peer exchange |

Handshake is two frames: `0xA1` (hello) and `0xA2` (hello ack). Each carries the sender's ID and raw X25519 public key. After that, all data is encrypted.

### Reliable chunk transfer

When a value larger than 900 bytes is requested via `fetch()`, the sender uses a sliding window protocol instead of fire-and-forget:

1. Sender splits the value into 900-byte chunks and sends the first 8 in parallel (window size = 8)
2. Receiver sends a `CHUNK_ACK` frame for each chunk it receives
3. Sender retransmits any chunk that isn't acknowledged within 1.5 seconds (RTO)
4. As each ACK arrives, the sender advances the window and sends the next unacknowledged chunk
5. Transfer completes when all chunks are acknowledged; a 60-second safety timeout cleans up any stale state

Small values (≤ 900 bytes) are still fire-and-forget — no ACK needed.

---

## Porting to another language

The minimum you need to implement:

1. X25519 key exchange + HKDF-SHA256 to derive send/recv keys
2. ChaCha20-Poly1305 encrypt/decrypt with a 12-byte nonce (4-byte session ID + 8-byte counter)
3. The handshake frames (`0xA1` / `0xA2`)
4. DATA frame (`0x01`) with the encrypted payload
5. PING/PONG for keepalive

Everything else (DHT, relay, gossip, PEX, reliable chunks) is optional and can be added incrementally.

The session key derivation label is `p2p-v12-session` — both sides must use the same label. The peer with the lexicographically lower ID uses the first 32 bytes as send key; the other peer flips them.

---

## Chat example

```bash
node chat.js <nick> [room]
node chat.js alice myroom
```

Commands: `/peers`, `/nat`, `/quit`

---

## License

MIT

