'use strict';

const PIPING_SERVERS = [
  'ppng.io',
  'piping.nwtgck.org',
  'piping.onrender.com',
  'piping.glitch.me',
];

const STUN_HOSTS = [
  { host: 'stun.l.google.com',       port: 19302 },
  { host: 'stun1.l.google.com',      port: 19302 },
  { host: 'stun2.l.google.com',      port: 19302 },
  { host: 'stun.cloudflare.com',     port: 3478  },
  { host: 'stun.stunprotocol.org',   port: 3478  },
  { host: 'global.stun.twilio.com',  port: 3478  },
  { host: 'stun.ekiga.net',          port: 3478  },
];

const F_RELAY_ANN  = 0x20;
const F_RELAY_REQ  = 0x21;
const F_RELAY_FWD  = 0x22;

const F_PEX        = 0x30;
const PEX_MAX      = 20;
const PEX_INTERVAL = 60_000;

const HARDCODED_SEEDS = [];

const HARDCODED_HTTP_BOOTSTRAP = [
'https://bootstrap-4eft.onrender.com',
    'https://bootsrtap.firestarp.workers.dev',
];

const PEER_CACHE_EMIT_MS = 30_000;

const RELAY_NAT_OPEN = new Set(['full_cone', 'open']);
const RELAY_MAX      = 20;
const RELAY_ANN_MS   = 30_000;
const RELAY_BAN_MS   = 5 * 60_000;

const BOOTSTRAP_TIMEOUT = 15_000;

const MAX_PEERS      = 100;
const MAX_ADDRS_PEER = 4;
const PEER_TIMEOUT   = 60_000;
const ANNOUNCE_MS    = 18_000;
const HEARTBEAT_MS   = 1_000;
const PUNCH_TRIES    = 8;
const PUNCH_INTERVAL = 300;

const GOSSIP_MAX = 200_000;
const GOSSIP_TTL = 30_000;

const D_DEFAULT = 6;
const D_MIN     = 4;
const D_MAX     = 16;
const D_LOW     = 4;
const D_HIGH    = 16;
const D_GOSSIP  = 6;
const IHAVE_MAX = 200;

const BATCH_MTU      = 1400;
const BATCH_INTERVAL = 2;

const QUEUE_CTRL = 256;
const QUEUE_DATA = 2048;

const BLOOM_BITS    = 64 * 1024 * 1024;
const BLOOM_HASHES  = 5;
const BLOOM_ROTATE  = 5 * 60 * 1000;

const SYNC_CACHE_MAX  = 10_000;
const SYNC_CHUNK_SIZE = 900;
const SYNC_TIMEOUT    = 30_000;
const HAVE_BATCH      = 64;

const MAX_PAYLOAD   = 1200;
const FRAG_HDR      = 12;
const FRAG_DATA_MAX = MAX_PAYLOAD - FRAG_HDR;
const FRAG_TIMEOUT  = 10_000;

const CWND_INIT  = 16;
const CWND_MAX   = 512;
const CWND_DECAY = 0.75;

const RATE_PER_SEC = 128;
const RATE_BURST   = 256;

const RTT_ALPHA = 0.125;
const RTT_INIT  = 100;

const DRAIN_TIMEOUT     = 2000;
const STUN_FAST_TIMEOUT = 1500;

const TAG_LEN   = 16;
const NONCE_LEN = 12;

const F_DATA   = 0x01;
const F_PING   = 0x03;
const F_PONG   = 0x04;
const F_FRAG   = 0x0B;
const F_GOAWAY = 0x0A;
const F_HAVE   = 0x10;
const F_WANT   = 0x11;
const F_CHUNK  = 0x12;
const F_BATCH  = 0x13;
const F_CHUNK_ACK = 0x14;

const MCAST_ADDR = '239.0.0.1';
const MCAST_PORT = 45678;
const F_LAN      = 0x09;

module.exports = {
  PIPING_SERVERS, STUN_HOSTS,
  F_RELAY_ANN, F_RELAY_REQ, F_RELAY_FWD,
  F_PEX, PEX_MAX, PEX_INTERVAL,
  HARDCODED_SEEDS, HARDCODED_HTTP_BOOTSTRAP,
  PEER_CACHE_EMIT_MS,
  RELAY_NAT_OPEN, RELAY_MAX, RELAY_ANN_MS, RELAY_BAN_MS,
  BOOTSTRAP_TIMEOUT,
  MAX_PEERS, MAX_ADDRS_PEER, PEER_TIMEOUT, ANNOUNCE_MS,
  HEARTBEAT_MS, PUNCH_TRIES, PUNCH_INTERVAL,
  GOSSIP_MAX, GOSSIP_TTL,
  D_DEFAULT, D_MIN, D_MAX, D_LOW, D_HIGH, D_GOSSIP, IHAVE_MAX,
  BATCH_MTU, BATCH_INTERVAL,
  QUEUE_CTRL, QUEUE_DATA,
  BLOOM_BITS, BLOOM_HASHES, BLOOM_ROTATE,
  SYNC_CACHE_MAX, SYNC_CHUNK_SIZE, SYNC_TIMEOUT, HAVE_BATCH,
  MAX_PAYLOAD, FRAG_HDR, FRAG_DATA_MAX, FRAG_TIMEOUT,
  CWND_INIT, CWND_MAX, CWND_DECAY,
  RATE_PER_SEC, RATE_BURST,
  RTT_ALPHA, RTT_INIT,
  DRAIN_TIMEOUT, STUN_FAST_TIMEOUT,
  TAG_LEN, NONCE_LEN,
  F_DATA, F_PING, F_PONG, F_FRAG, F_GOAWAY,
  F_HAVE, F_WANT, F_CHUNK, F_BATCH, F_CHUNK_ACK,
  MCAST_ADDR, MCAST_PORT, F_LAN,
};

