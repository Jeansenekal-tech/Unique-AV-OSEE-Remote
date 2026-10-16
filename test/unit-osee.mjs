// OSEE Switcher Remote: GoStream framing + bridge end-to-end against the simulator.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { pack, PacketParser, crc16modbus, storeKey } = require('../osee/gostream.js');
const { startSimulator } = require('../osee/sim.js');
const { OseeBridge } = require('../osee/server.js');
const { parseResponse } = require('../osee/discovery.js');

let passed = 0;
const ok = (name) => { passed++; console.log(`  ✓ ${name}`); };

// CRC-16/MODBUS check value for "123456789" is 0x4B37.
assert.equal(crc16modbus(Buffer.from('123456789')), 0x4b37);
ok('crc16 modbus');

const p = pack({ id: 'pgmIndex', type: 'set', value: [2] });
assert.equal(p[0], 0xeb); assert.equal(p[1], 0xa6); assert.equal(p[2], 0);
assert.equal(p.readUInt16LE(3), p.length - 5);
ok('packet header and length');

{
  const a = pack({ id: 'a', type: 'pus', value: [1] });
  const b = pack({ id: 'b', type: 'pus', value: ['x', 2] });
  const all = Buffer.concat([Buffer.from([0, 1, 2]), a, b]);
  const parser = new PacketParser();
  const got = [];
  // Feed one byte at a time: split headers and bodies must reassemble.
  for (let i = 0; i < all.length; i++) got.push(...parser.push(all.subarray(i, i + 1)));
  assert.deepEqual(got.map((c) => c.id), ['a', 'b']);
  const bad = Buffer.from(a); bad[bad.length - 1] ^= 0xff;
  assert.deepEqual(new PacketParser().push(Buffer.concat([bad, b])).map((c) => c.id), ['b']);
  ok('stream parser: byte-split packets, garbage, bad CRC');
}

assert.equal(storeKey('v2', { id: 'dskOnAir', value: [1, 0] }), 'dskOnAir:1');
assert.equal(storeKey('v2', { id: 'pgmIndex', value: [3] }), 'pgmIndex');
assert.equal(storeKey('v2', { id: 'inputList', value: [1, 2, 3] }), 'inputList');
assert.equal(storeKey('v2', { id: 'dskFillSourceList', value: [1, 2, 3] }), 'dskFillSourceList');
assert.equal(storeKey('v2', { id: 'audioMixerFader', value: [1301, -3] }), 'audioMixerFader:1301');
assert.equal(storeKey('v1', { id: 'audioFader', value: [2, -3] }), 'audioFader:2');
ok('state keys for indexed parameters');

{
  // A minimal mDNS answer: PTR + SRV + A.
  const name = (n) => Buffer.concat([...n.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0])]);
  const rr = (n, type, data) => { const h = Buffer.alloc(10); h.writeUInt16BE(type, 0); h.writeUInt16BE(1, 2); h.writeUInt32BE(120, 4); h.writeUInt16BE(data.length, 8); return Buffer.concat([name(n), h, data]); };
  const header = Buffer.alloc(12); header.writeUInt16BE(0x8400, 2); header.writeUInt16BE(3, 6);
  const srv = Buffer.concat([Buffer.from([0, 0, 0, 0, 0x4a, 0x42]), name('gostream.local')]);
  const msg = Buffer.concat([header,
    rr('_oseectrl._tcp.local', 12, name('Deck._oseectrl._tcp.local')),
    rr('Deck._oseectrl._tcp.local', 33, srv),
    rr('gostream.local', 1, Buffer.from([192, 168, 1, 80]))]);
  const r = parseResponse(msg);
  assert.deepEqual(r.ptr, ['Deck._oseectrl._tcp.local']);
  assert.equal(r.srv['Deck._oseectrl._tcp.local'].port, 19010);
  assert.equal(r.a['gostream.local'], '192.168.1.80');
  ok('bonjour response parsing');
}

// --- End to end -------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osee-'));
const sim = await startSimulator({ port: 0, model: 'duet8iso' });
const sim2 = await startSimulator({ port: 0, model: 'deck' });
const bridge = new OseeBridge({ port: 0, host: '127.0.0.1', configFile: path.join(tmp, 'devices.json'), log: () => {} });
await bridge.start();
const base = `http://127.0.0.1:${bridge.port}`;
const j = async (url, opt = {}) => {
  const r = await fetch(base + url, { ...opt, headers: { 'Content-Type': 'application/json', ...(opt.headers || {}) }, body: opt.body ? JSON.stringify(opt.body) : undefined });
  return { status: r.status, body: await r.json() };
};
const until = async (fn, what, ms = 4000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 40)); }
  throw new Error(`Timed out waiting for ${what}`);
};
const devState = async (id) => (await j('/api/devices')).body.find((d) => d.id === id);

try {
  const html = await fetch(`${base}/`).then((r) => r.text());
  assert.match(html, /OSEE Switcher Remote/);
  assert.equal((await fetch(`${base}/../server.js`)).status, 404);
  ok('serves the web UI');

  const a = (await j('/api/devices', { method: 'POST', body: { name: 'Stage', host: '127.0.0.1', port: sim.port } })).body;
  const b = (await j('/api/devices', { method: 'POST', body: { name: 'Booth', host: '127.0.0.1', port: sim2.port } })).body;
  await until(async () => { const d = await devState(a.id); return d.status === 'connected' && d.store['keyOnAir:3'] && d.store['audioMixerFader:8']; }, 'sync of device A');
  await until(async () => (await devState(b.id)).store.pvwIndex, 'sync of device B');
  const st = (await devState(a.id)).store;
  assert.equal(st.deviceType[0], 10);
  assert.equal(st.inputList.length, 16);
  assert.ok(st['outSourceRange:21001']);
  assert.ok(st['macroInfos:4']);
  ok('connects and syncs both switchers (counts drive per-key/per-channel requests)');

  // SSE stream delivers live changes.
  const ac = new AbortController();
  const events = [];
  fetch(`${base}/api/events`, { signal: ac.signal }).then(async (r) => {
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    for (;;) { const { value, done } = await reader.read(); if (done) break; events.push(dec.decode(value)); }
  }).catch(() => {});

  await j(`/api/devices/${a.id}/send`, { method: 'POST', body: { cmds: [{ id: 'pvwIndex', type: 'set', value: [5] }] } });
  await until(async () => (await devState(a.id)).store.pvwIndex[0] === 5, 'preview change');
  await j(`/api/devices/${a.id}/send`, { method: 'POST', body: { cmds: [{ id: 'cutTransition', type: 'set' }] } });
  await until(async () => (await devState(a.id)).store.pgmIndex[0] === 5, 'cut');
  ok('preview + cut round trip');

  await j(`/api/devices/${a.id}/send`, { method: 'POST', body: { cmds: [{ id: 'keyOnAir', type: 'set', value: [2, true] }, { id: 'audioMixerFader', type: 'set', value: [3, -12.5] }] } });
  await until(async () => { const s = (await devState(a.id)).store; return s['keyOnAir:2'][1] === true && s['audioMixerFader:3'][1] === -12.5; }, 'key + fader');
  ok('indexed parameters (key on air, fader)');

  // Linked send: one request, two switchers.
  await j('/api/send', { method: 'POST', body: { devices: { [a.id]: [{ id: 'recordStart', type: 'set', value: [0] }], [b.id]: [{ id: 'recordStart', type: 'set', value: [0] }] } } });
  await until(async () => (await devState(a.id)).store.recordStatus[0] === 1 && (await devState(b.id)).store.recordStatus[0] === 1, 'record on both');
  ok('linked send to several switchers');

  await until(async () => events.join('').includes('"pgmIndex":[5]') || events.join('').includes('recordStatus'), 'SSE params event');
  assert.match(events.join(''), /event: hello/);
  ac.abort();
  ok('live updates over server-sent events');

  await j(`/api/devices/${a.id}`, { method: 'PUT', body: { labels: { 1: 'Pastor' }, hidden: [1000], linked: true } });
  const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'devices.json'), 'utf8'));
  assert.equal(saved.devices.find((d) => d.id === a.id).labels['1'], 'Pastor');
  assert.equal(saved.devices.find((d) => d.id === a.id).linked, true);
  ok('labels, hidden sources and link flag persist');

  // Switcher restart: the bridge reconnects and re-syncs by itself.
  await sim2.close();
  await until(async () => (await devState(b.id)).status !== 'connected', 'disconnect');
  const sim3 = await startSimulator({ port: sim2.port, model: 'deck' });
  await until(async () => { const d = await devState(b.id); return d.status === 'connected' && d.store.pvwIndex; }, 'reconnect', 8000);
  await sim3.close();
  ok('reconnects after the switcher restarts');

  await j('/api/settings', { method: 'PUT', body: { password: 'pw' } });
  assert.equal((await j('/api/devices')).status, 401);
  assert.equal((await j('/api/devices', { headers: { 'X-Osee-Pass': 'pw' } })).status, 200);
  assert.equal((await j('/api/info')).body.needsPassword, true);
  ok('password protection');

  assert.equal((await j(`/api/devices/${b.id}`, { method: 'DELETE', headers: { 'X-Osee-Pass': 'pw' } })).body.ok, true);
  ok('remove device');
} finally {
  await bridge.stop();
  await sim.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`OSEE remote: ${passed} checks passed`);
