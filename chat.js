'use strict';

const Swarm  = require('./index');
const crypto = require('crypto');
const rl     = require('readline');
const fs     = require('fs');

const nick = process.argv[2];
const room = process.argv[3] || 'general';

if (!nick) {
  console.error('usage: node chat.js <nick> [room]');
  process.exit(1);
}

const SEED_FILE = './identity.json';
let seed;
if (fs.existsSync(SEED_FILE)) {
  seed = JSON.parse(fs.readFileSync(SEED_FILE)).seed;
} else {
  seed = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SEED_FILE, JSON.stringify({ seed }));
}

const iface = rl.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
let closing = false;

const clearLine = () => process.stdout.write('\r\x1b[2K');

function print(line) {
  if (closing || iface.closed) return;
  clearLine();
  console.log(line);
  iface.prompt(true);
}

function ts() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

const sys = msg => print(`\x1b[90m[${ts()}] * ${msg}\x1b[0m`);
const msg = (from, text) => {
  const color = from === nick ? '\x1b[32m' : '\x1b[35m';
  print(`\x1b[90m[${ts()}]\x1b[0m ${color}${from}\x1b[0m: ${text}`);
};

const swarm     = new Swarm({ seed });
const topic     = crypto.createHash('sha256').update('chat:' + room).digest();
const nicks     = new Map();
const handshook = new Set();

sys(`starting... nick=${nick} room=${room}`);

swarm.join(topic, { announce: true, lookup: true }).ready().then(() => {
  const localPort = swarm._sock.address().port;
  sys(`ready | nat=${swarm.natType} | addr=LAN | local=${localPort}`);
  iface.prompt(true);
});

swarm.on('nat',     () => {
  const localPort = swarm._sock.address().port;
  sys(`nat=${swarm.natType} addr=${swarm.publicAddress || 'LAN'} local=${localPort}`);
});
swarm.on('nattype', () => sys(`nat type refined: ${swarm.natType}`));

swarm.on('connection', peer => {
  peer.write(Buffer.from(JSON.stringify({ type: 'JOIN', nick })));
});

swarm.on('data', (data, peer) => {
  let m;
  try { m = JSON.parse(data.toString()); } catch { return; }

  if (m._selfId === swarm._id) return;

  if (m.type === 'JOIN') {
    const fresh = !nicks.has(peer.id);
    nicks.set(peer.id, m.nick);
    if (fresh) sys(`${m.nick} joined`);
    if (!handshook.has(peer.id)) {
      handshook.add(peer.id);
      try { peer.write(Buffer.from(JSON.stringify({ type: 'JOIN', nick }))); } catch {}
    }
    return;
  }

  if (m.type === 'MSG') { msg(m.nick, m.text); return; }

  if (m.type === 'LEAVE') {
    sys(`${nicks.get(peer.id) || m.nick} left`);
    nicks.delete(peer.id);
  }
});

swarm.on('disconnect', id => {
  sys(`${nicks.get(id) || id.slice(0, 8)} disconnected`);
  nicks.delete(id);
  handshook.delete(id);
});

iface.setPrompt(`\x1b[32m${nick}\x1b[0m > `);

iface.on('line', line => {
  const text = line.trim();
  if (!text) { iface.prompt(true); return; }

  if (text === '/peers') {
    sys(`${swarm.size} peer(s) connected`);
    for (const p of swarm.peers) {
      sys(`  ${p.id.slice(0, 8)} nick=${nicks.get(p.id) || '?'} rtt=${Math.round(p.rtt)}ms mesh=${p.inMesh}`);
    }
    iface.prompt(true);
    return;
  }

  if (text === '/nat') {
    sys(`nat=${swarm.natType} addr=${swarm.publicAddress || 'LAN'}`);
    iface.prompt(true);
    return;
  }

  if (text === '/quit') {
    closing = true;
    swarm.broadcast(Buffer.from(JSON.stringify({ type: 'LEAVE', nick })));
    setTimeout(() => swarm.destroy().then(() => process.exit(0)), 300);
    return;
  }

  const payload = Buffer.from(JSON.stringify({ type: 'MSG', nick, text, _selfId: swarm._id }));
  if (!swarm.broadcast(payload)) {
    for (const p of swarm.peers) {
      if (p._session) p.write(payload);
    }
  }
  msg(nick, text);
  iface.prompt(true);
});

iface.on('close', () => {
  closing = true;
  swarm.broadcast(Buffer.from(JSON.stringify({ type: 'LEAVE', nick })));
  swarm.destroy().then(() => process.exit(0));
});

setTimeout(() => sys('commands: /peers  /nat  /quit'), 500);

