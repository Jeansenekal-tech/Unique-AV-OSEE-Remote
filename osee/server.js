#!/usr/bin/env node
// OSEE Switcher Remote: a bridge between OSEE GoStream switchers (TCP) and a
// touch web interface for iPad / tablets / phones (HTTP + Server-Sent Events).
//
//   node osee/server.js [--port 8090] [--config path/to/osee-devices.json] [--password secret]
//
// Then open http://<this-computer's-ip>:8090/ on the iPad.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { GoStreamClient, DEFAULT_PORT } = require('./gostream');
const { discover } = require('./discovery');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

function lanAddresses() {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push(a.address);
  }
  return out;
}

class OseeBridge {
  constructor({ port = 8090, host = '0.0.0.0', configFile, password = '', log = console.log } = {}) {
    this.port = Number(port) || 8090;
    this.host = host;
    this.configFile = configFile || path.join(__dirname, 'osee-devices.json');
    this.log = log;
    this.devices = new Map(); // id -> { config, client }
    this.clients = new Set(); // SSE responses
    this.server = null;
    this.settings = { password };
    this.pending = new Map(); // id -> queued param changes, flushed together
    this.flushScheduled = false;
    this.load();
  }

  // --- Persistence ----------------------------------------------------------

  load() {
    let data = {};
    try { data = JSON.parse(fs.readFileSync(this.configFile, 'utf8')); } catch { /* first run */ }
    if (data.password && !this.settings.password) this.settings.password = data.password;
    for (const d of Array.isArray(data.devices) ? data.devices : []) this.addDevice(d, false);
  }

  save() {
    const data = {
      password: this.settings.password || undefined,
      devices: [...this.devices.values()].map((d) => d.config),
    };
    try {
      fs.mkdirSync(path.dirname(this.configFile), { recursive: true });
      fs.writeFileSync(this.configFile, JSON.stringify(data, null, 2));
    } catch (e) {
      this.log(`[osee] could not save ${this.configFile}: ${e.message}`);
    }
  }

  // --- Devices --------------------------------------------------------------

  sanitize(input, base = {}) {
    const c = { ...base };
    if (input.name !== undefined) c.name = String(input.name).slice(0, 60);
    if (input.host !== undefined) c.host = String(input.host).trim();
    if (input.port !== undefined) c.port = Number(input.port) || DEFAULT_PORT;
    if (input.protocol !== undefined) c.protocol = input.protocol === 'v1' ? 'v1' : 'v2';
    if (input.linked !== undefined) c.linked = !!input.linked;
    if (input.labels && typeof input.labels === 'object') {
      c.labels = {};
      for (const [k, v] of Object.entries(input.labels)) if (String(v).trim()) c.labels[String(k)] = String(v).slice(0, 24);
    }
    if (input.hidden && Array.isArray(input.hidden)) c.hidden = input.hidden.map(Number).filter((n) => !Number.isNaN(n));
    return c;
  }

  addDevice(input, persist = true) {
    const config = this.sanitize(input, {
      id: input.id || crypto.randomBytes(4).toString('hex'),
      name: '', host: '', port: DEFAULT_PORT, protocol: 'v2', linked: false, labels: {}, hidden: [],
    });
    if (!config.host) throw new Error('Host is required');
    const client = new GoStreamClient({ host: config.host, port: config.port, protocol: config.protocol });
    const dev = { config, client };
    client.on('status', (status, message) => this.broadcast('status', { id: config.id, status, message }));
    client.on('params', (changes) => this.queueParams(config.id, changes));
    this.devices.set(config.id, dev);
    client.start();
    if (persist) {
      this.save();
      this.broadcast('device', this.describe(dev));
    }
    return dev;
  }

  updateDevice(id, input) {
    const dev = this.devices.get(id);
    if (!dev) throw new Error('No such device');
    const next = this.sanitize(input, dev.config);
    const reconnect = next.host !== dev.config.host || next.port !== dev.config.port || next.protocol !== dev.config.protocol;
    dev.config = next;
    if (reconnect) {
      dev.client.stop();
      dev.client.host = next.host;
      dev.client.port = next.port;
      dev.client.protocol = next.protocol;
      dev.client.store = {};
      dev.client.start();
    }
    this.save();
    this.broadcast('device', this.describe(dev));
    return dev;
  }

  removeDevice(id) {
    const dev = this.devices.get(id);
    if (!dev) return false;
    dev.client.stop();
    dev.client.removeAllListeners();
    this.devices.delete(id);
    this.save();
    this.broadcast('removed', { id });
    return true;
  }

  describe(dev) {
    return { ...dev.config, status: dev.client.status, message: dev.client.message, store: dev.client.store };
  }

  // --- Live updates (SSE) ---------------------------------------------------

  queueParams(id, changes) {
    const q = this.pending.get(id) || {};
    for (const { key, cmd } of changes) q[key] = cmd.value;
    this.pending.set(id, q);
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      setTimeout(() => {
        this.flushScheduled = false;
        for (const [devId, params] of this.pending) this.broadcast('params', { id: devId, params });
        this.pending.clear();
      }, 15);
    }
  }

  broadcast(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) res.write(msg);
  }

  // --- HTTP -----------------------------------------------------------------

  authorized(req, url) {
    if (!this.settings.password) return true;
    const given = req.headers['x-osee-pass'] || url.searchParams.get('pass') || '';
    const a = Buffer.from(String(given));
    const b = Buffer.from(String(this.settings.password));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > 1e6) { reject(new Error('Body too large')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (!text) { resolve({}); return; }
        try { resolve(JSON.parse(text)); } catch { reject(new Error('Invalid JSON')); }
      });
      req.on('error', reject);
    });
  }

  json(res, code, body) {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  serveStatic(res, pathname) {
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  }

  async handle(req, res) {
    const url = new URL(req.url, 'http://local');
    const p = url.pathname;
    if (!p.startsWith('/api/')) { this.serveStatic(res, p); return; }
    if (p === '/api/info') {
      this.json(res, 200, { name: 'OSEE Switcher Remote', needsPassword: !!this.settings.password, addresses: lanAddresses(), port: this.port });
      return;
    }
    if (!this.authorized(req, url)) { this.json(res, 401, { error: 'Wrong password' }); return; }

    if (p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`retry: 1500\nevent: hello\ndata: ${JSON.stringify({ devices: [...this.devices.values()].map((d) => this.describe(d)) })}\n\n`);
      this.clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => { clearInterval(ping); this.clients.delete(res); });
      return;
    }

    try {
      if (p === '/api/devices' && req.method === 'GET') {
        this.json(res, 200, [...this.devices.values()].map((d) => this.describe(d)));
        return;
      }
      if (p === '/api/devices' && req.method === 'POST') {
        const dev = this.addDevice(await this.readBody(req));
        this.json(res, 200, this.describe(dev));
        return;
      }
      if (p === '/api/discover') {
        const known = new Set([...this.devices.values()].map((d) => d.config.host));
        const found = await discover();
        this.json(res, 200, found.map((f) => ({ ...f, known: known.has(f.host) })));
        return;
      }
      if (p === '/api/send' && req.method === 'POST') {
        // Same commands to several switchers at once (linked devices).
        const body = await this.readBody(req);
        const results = {};
        for (const [id, cmds] of Object.entries(body.devices || {})) {
          const dev = this.devices.get(id);
          results[id] = dev ? dev.client.send(cmds) : false;
        }
        this.json(res, 200, { results });
        return;
      }
      const m = p.match(/^\/api\/devices\/([\w-]+)(?:\/(send|resync))?$/);
      if (m) {
        const dev = this.devices.get(m[1]);
        if (!dev) { this.json(res, 404, { error: 'No such device' }); return; }
        if (m[2] === 'send' && req.method === 'POST') {
          const body = await this.readBody(req);
          const ok = dev.client.send(body.cmds || body);
          this.json(res, ok ? 200 : 409, { ok, status: dev.client.status });
          return;
        }
        if (m[2] === 'resync' && req.method === 'POST') {
          dev.client.stop();
          dev.client.store = {};
          dev.client.start();
          this.json(res, 200, { ok: true });
          return;
        }
        if (!m[2] && req.method === 'PUT') {
          this.json(res, 200, this.describe(this.updateDevice(m[1], await this.readBody(req))));
          return;
        }
        if (!m[2] && req.method === 'DELETE') {
          this.json(res, 200, { ok: this.removeDevice(m[1]) });
          return;
        }
      }
      if (p === '/api/settings' && req.method === 'PUT') {
        const body = await this.readBody(req);
        if (body.password !== undefined) this.settings.password = String(body.password);
        this.save();
        this.json(res, 200, { ok: true, needsPassword: !!this.settings.password });
        return;
      }
      this.json(res, 404, { error: 'Not found' });
    } catch (e) {
      this.json(res, 400, { error: e.message });
    }
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handle(req, res).catch((e) => { try { this.json(res, 500, { error: e.message }); } catch { /* sent */ } });
      });
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => {
        this.port = this.server.address().port;
        resolve(this);
      });
    });
  }

  stop() {
    for (const dev of this.devices.values()) dev.client.stop();
    for (const res of this.clients) res.end();
    this.clients.clear();
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  urls() {
    return lanAddresses().map((a) => `http://${a}:${this.port}/`);
  }
}

module.exports = { OseeBridge, lanAddresses };

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (name, def) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : def;
  };
  const bridge = new OseeBridge({
    port: opt('port', process.env.OSEE_PORT || 8090),
    configFile: opt('config', process.env.OSEE_CONFIG),
    password: opt('password', process.env.OSEE_PASSWORD || ''),
  });
  bridge.start().then(() => {
    console.log('OSEE Switcher Remote is running. Open one of these on your iPad:');
    for (const u of bridge.urls()) console.log(`  ${u}`);
    console.log(`  http://localhost:${bridge.port}/ (this computer)`);
  }).catch((e) => {
    console.error(`Could not start: ${e.message}`);
    process.exit(1);
  });
  process.on('SIGINT', () => bridge.stop().then(() => process.exit(0)));
}
