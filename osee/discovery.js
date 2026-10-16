// Finds GoStream switchers on the local network two ways:
//  * Bonjour / mDNS: the switchers advertise "_oseectrl._tcp".
//  * A TCP probe of port 19010 on every address of the local /24 subnets,
//    for networks where multicast is blocked.
'use strict';

const dgram = require('dgram');
const net = require('net');
const os = require('os');
const { DEFAULT_PORT } = require('./gostream');

const SERVICE = '_oseectrl._tcp.local';

function localSubnets() {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal) continue;
      out.push({ address: a.address, prefix: a.address.split('.').slice(0, 3).join('.') });
    }
  }
  return out;
}

function encodeName(name) {
  const parts = name.split('.').filter(Boolean).map((p) => {
    const b = Buffer.from(p, 'utf8');
    return Buffer.concat([Buffer.from([b.length]), b]);
  });
  return Buffer.concat([...parts, Buffer.from([0])]);
}

function buildQuery() {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(1, 4); // one question
  const q = Buffer.alloc(4);
  q.writeUInt16BE(12, 0); // PTR
  q.writeUInt16BE(1, 2); // IN
  return Buffer.concat([header, encodeName(SERVICE), q]);
}

function readName(buf, offset) {
  const labels = [];
  let jumped = false;
  let next = offset;
  for (let guard = 0; guard < 64 && offset < buf.length; guard++) {
    const len = buf[offset];
    if (len === 0) { offset += 1; break; }
    if ((len & 0xc0) === 0xc0) {
      if (!jumped) next = offset + 2;
      offset = ((len & 0x3f) << 8) | buf[offset + 1];
      jumped = true;
      continue;
    }
    labels.push(buf.toString('utf8', offset + 1, offset + 1 + len));
    offset += 1 + len;
  }
  return { name: labels.join('.'), next: jumped ? next : offset };
}

// Returns { ptr: [instance names], srv: {instance: {target, port}}, a: {host: ip} }
function parseResponse(buf) {
  const res = { ptr: [], srv: {}, a: {} };
  if (buf.length < 12) return res;
  const qd = buf.readUInt16BE(4);
  const total = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  let off = 12;
  for (let i = 0; i < qd; i++) off = readName(buf, off).next + 4;
  for (let i = 0; i < total && off < buf.length; i++) {
    const { name, next } = readName(buf, off);
    off = next;
    if (off + 10 > buf.length) break;
    const type = buf.readUInt16BE(off);
    const rdlen = buf.readUInt16BE(off + 8);
    const rd = off + 10;
    if (type === 12) res.ptr.push(readName(buf, rd).name);
    else if (type === 33) res.srv[name] = { port: buf.readUInt16BE(rd + 4), target: readName(buf, rd + 6).name };
    else if (type === 1 && rdlen === 4) res.a[name] = [...buf.subarray(rd, rd + 4)].join('.');
    off = rd + rdlen;
  }
  return res;
}

function mdnsBrowse(timeoutMs = 2500) {
  return new Promise((resolve) => {
    const found = new Map();
    let sock;
    try {
      sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    } catch {
      resolve([]);
      return;
    }
    const records = { srv: {}, a: {}, ptr: new Set() };
    const collect = (msg, rinfo) => {
      const r = parseResponse(msg);
      r.ptr.forEach((p) => records.ptr.add(p));
      Object.assign(records.srv, r.srv);
      Object.assign(records.a, r.a);
      for (const inst of records.ptr) {
        if (!inst.toLowerCase().includes('_oseectrl')) continue;
        const srv = records.srv[inst];
        const host = (srv && records.a[srv.target]) || rinfo.address;
        const name = inst.replace(/\._oseectrl\._tcp\.local$/i, '');
        found.set(host, { host, port: (srv && srv.port) || DEFAULT_PORT, name, via: 'bonjour' });
      }
    };
    sock.on('message', collect);
    sock.on('error', () => {});
    const done = () => {
      try { sock.close(); } catch { /* already closed */ }
      resolve([...found.values()]);
    };
    sock.bind(0, () => {
      const q = buildQuery();
      try {
        sock.setMulticastTTL(255);
        sock.send(q, 5353, '224.0.0.251');
        setTimeout(() => { try { sock.send(q, 5353, '224.0.0.251'); } catch { /* ignore */ } }, 600);
      } catch { /* no multicast route */ }
      setTimeout(done, timeoutMs);
    });
  });
}

function probe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const end = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs, () => end(false));
    s.on('connect', () => end(true));
    s.on('error', () => end(false));
  });
}

async function subnetScan({ port = DEFAULT_PORT, timeoutMs = 400, concurrency = 64 } = {}) {
  const targets = [];
  for (const { prefix, address } of localSubnets()) {
    for (let i = 1; i < 255; i++) {
      const ip = `${prefix}.${i}`;
      if (ip !== address) targets.push(ip);
    }
  }
  const found = [];
  let idx = 0;
  const worker = async () => {
    while (idx < targets.length) {
      const ip = targets[idx++];
      if (await probe(ip, port, timeoutMs)) found.push({ host: ip, port, name: '', via: 'scan' });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
  return found;
}

async function discover() {
  const [bonjour, scanned] = await Promise.all([mdnsBrowse(), subnetScan()]);
  const byHost = new Map();
  for (const d of [...scanned, ...bonjour]) byHost.set(d.host, { ...byHost.get(d.host), ...d });
  return [...byHost.values()].sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true }));
}

module.exports = { discover, mdnsBrowse, subnetScan, localSubnets, parseResponse, buildQuery };
