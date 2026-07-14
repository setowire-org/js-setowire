'use strict';

const DEFAULT_INTERVAL_MS = 60_000;

const FRAME_NAMES = {
  0x01: 'DATA',
  0x03: 'PING',
  0x04: 'PONG',
  0x09: 'LAN',
  0x0A: 'GOAWAY',
  0x0B: 'FRAG',
  0x10: 'HAVE',
  0x11: 'WANT',
  0x12: 'CHUNK',
  0x13: 'BATCH',
  0x14: 'CHUNK_ACK',
  0x20: 'RELAY_ANN',
  0x21: 'RELAY_REQ',
  0x22: 'RELAY_FWD',
  0x30: 'PEX',
  0xA1: 'HELLO',
  0xA2: 'HELLO_ACK',
};

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = units.shift();
  while (value >= 1024 && units.length) {
    value /= 1024;
    unit = units.shift();
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

function topEntries(map, limit = 8) {
  return [...map.entries()]
    .sort((a, b) => (b[1].sent + b[1].received + b[1].count) - (a[1].sent + a[1].received + a[1].count))
    .slice(0, limit);
}

class NetworkDiagnostics {
  constructor(opts = {}) {
    this.enabled = opts.enabled === true;
    this.intervalMs = opts.intervalMs || DEFAULT_INTERVAL_MS;
    this.logger = opts.logger || console;
    this.startedAt = Date.now();
    this.lastReportAt = this.startedAt;
    this.resetWindow();
    this.total = this.emptyCounters();
    this._timer = null;

    if (this.enabled) {
      this._timer = setInterval(() => this.report(), this.intervalMs);
      if (this._timer.unref) this._timer.unref();
    }
  }

  emptyCounters() {
    return {
      sent: 0,
      received: 0,
      messagesSent: 0,
      messagesReceived: 0,
      connectionsOpened: 0,
      connectionAttempts: 0,
      reconnects: 0,
      broadcasts: 0,
      broadcastRecipients: 0,
      byType: new Map(),
      byPeer: new Map(),
    };
  }

  resetWindow() {
    this.window = this.emptyCounters();
  }

  close() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  frameName(buf, fallback = 'UNKNOWN') {
    if (!buf || !buf.length) return fallback;
    return FRAME_NAMES[buf[0]] || `0x${buf[0].toString(16).padStart(2, '0')}`;
  }

  recordSend({ bytes, type, peerId, address }) {
    this.recordTraffic('sent', bytes, type, peerId, address);
  }

  recordReceive({ bytes, type, peerId, address }) {
    this.recordTraffic('received', bytes, type, peerId, address);
  }

  recordTraffic(direction, bytes, type, peerId, address) {
    if (!this.enabled) return;
    const messagesKey = direction === 'sent' ? 'messagesSent' : 'messagesReceived';
    this.total[direction] += bytes;
    this.total[messagesKey]++;
    this.window[direction] += bytes;
    this.window[messagesKey]++;
    this.addByType(this.total.byType, type, direction, bytes);
    this.addByType(this.window.byType, type, direction, bytes);
    this.addByPeer(this.total.byPeer, peerId, address, direction, bytes);
    this.addByPeer(this.window.byPeer, peerId, address, direction, bytes);
  }

  addByType(map, type, direction, bytes) {
    const key = type || 'UNKNOWN';
    const value = map.get(key) || { sent: 0, received: 0, count: 0 };
    value[direction] += bytes;
    value.count++;
    map.set(key, value);
  }

  addByPeer(map, peerId, address, direction, bytes) {
    const key = peerId || address || 'unknown';
    const value = map.get(key) || { sent: 0, received: 0, count: 0, address: address || null };
    value[direction] += bytes;
    value.count++;
    if (address) value.address = address;
    map.set(key, value);
  }

  recordConnectionOpened() {
    if (!this.enabled) return;
    this.total.connectionsOpened++;
    this.window.connectionsOpened++;
  }

  recordConnectionAttempt({ reconnect = false } = {}) {
    if (!this.enabled) return;
    this.total.connectionAttempts++;
    this.window.connectionAttempts++;
    if (reconnect) {
      this.total.reconnects++;
      this.window.reconnects++;
    }
  }

  recordBroadcast(recipients) {
    if (!this.enabled) return;
    this.total.broadcasts++;
    this.total.broadcastRecipients += recipients;
    this.window.broadcasts++;
    this.window.broadcastRecipients += recipients;
  }

  report() {
    if (!this.enabled) return;
    const now = Date.now();
    const seconds = Math.max(1, (now - this.lastReportAt) / 1000);
    const messages = this.window.messagesSent + this.window.messagesReceived;
    const lines = [
      '[setowire diagnostics]',
      `window=${Math.round(seconds)}s sent=${formatBytes(this.window.sent)} received=${formatBytes(this.window.received)} messages/s=${(messages / seconds).toFixed(2)}`,
      `connections.opened=${this.window.connectionsOpened} attempts=${this.window.connectionAttempts} reconnects=${this.window.reconnects} broadcasts=${this.window.broadcasts} recipients=${this.window.broadcastRecipients}`,
      `total.sent=${formatBytes(this.total.sent)} total.received=${formatBytes(this.total.received)} uptime=${Math.round((now - this.startedAt) / 1000)}s`,
    ];

    const byType = topEntries(this.window.byType)
      .map(([type, v]) => `${type}: sent=${formatBytes(v.sent)} recv=${formatBytes(v.received)} count=${v.count}`);
    if (byType.length) lines.push(`byType: ${byType.join(' | ')}`);

    const byPeer = topEntries(this.window.byPeer)
      .map(([peer, v]) => `${String(peer).slice(0, 12)}${v.address ? `@${v.address}` : ''}: sent=${formatBytes(v.sent)} recv=${formatBytes(v.received)} count=${v.count}`);
    if (byPeer.length) lines.push(`byPeer: ${byPeer.join(' | ')}`);

    this.logger.log(lines.join('\n'));
    this.lastReportAt = now;
    this.resetWindow();
  }
}

function createNetworkDiagnostics(opts) {
  if (opts instanceof NetworkDiagnostics) return opts;
  const envEnabled = process.env.SETOWIRE_DIAGNOSTICS === '1';
  if (opts === true) return new NetworkDiagnostics({ enabled: true });
  if (opts && typeof opts === 'object') return new NetworkDiagnostics({ ...opts, enabled: opts.enabled !== false });
  return new NetworkDiagnostics({ enabled: envEnabled });
}

module.exports = { NetworkDiagnostics, createNetworkDiagnostics };
