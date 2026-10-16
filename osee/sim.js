#!/usr/bin/env node
// A fake OSEE GoStream switcher for trying the remote without hardware and
// for the tests. It speaks the v2 protocol on TCP (default port 19010).
//
//   node osee/sim.js [--port 19010] [--model deck|duet|duet8iso]
'use strict';

const net = require('net');
const { PacketParser, pack } = require('./gostream');

const MODELS = {
  deck: { type: 0, name: 'GoStream Deck', inputs: [1, 2, 3, 4, 1000, 2001, 2002, 3010, 3011, 5001], keys: 1, dsks: 1, audio: [1301, 1302, 1, 2, 3, 4, 4001] },
  duet: { type: 1, name: 'GoStream Duet', inputs: [1, 2, 3, 4, 1000, 2001, 2002, 3010, 3011, 5001], keys: 1, dsks: 1, audio: [1301, 1302, 1, 2, 3, 4, 4001] },
  duet8iso: { type: 10, name: 'GoStream Duet 8 ISO', inputs: [1, 2, 3, 4, 5, 6, 7, 8, 1000, 2001, 2002, 3010, 3011, 3020, 3021, 5001], keys: 4, dsks: 2, audio: [1301, 1302, 1, 2, 3, 4, 5, 6, 7, 8] },
};

function createState(modelName) {
  const m = MODELS[modelName] || MODELS.deck;
  const s = {
    deviceType: [m.type], deviceName: [m.name], version: ['2.3.0'], buildInfo: ['sim'], deviceId: ['SIM-0001'],
    inputList: m.inputs, audioMixerInputSourceList: m.audio, keyCount: [m.keys], dskCount: [m.dsks], playCount: [1],
    multiSourceWindowCount: [2], recordISOChannelList: modelName === 'duet8iso' ? [1, 2, 3, 4, 5, 6, 7, 8] : [],
    outSourceList: [21001, 21002, 22001], audioMixerOutSourceList: [21001, 21002],
    pgmIndex: [1], pvwIndex: [2], previewTransition: [0], transitionStatus: [0], transitionStyle: ['Mix'],
    transitionMixRate: [1], transitionDipRate: [1], transitionWipeRate: [1], transitionDipFillSource: [2001],
    transitionDipFillSourceList: [2001, 2002, 1000, 0], transitionWipeDirection: [0], transitionWipePatternIndex: [0],
    ftbRate: [1], ftbAfv: [1], ftbStatus: [0], dskFillSourceList: m.inputs, dskKeySourceList: m.inputs,
    audioMixerSwitchType: [0], recordStatus: [0], recordFormat: ['H.264'], recordBitrate: [0], recordDuration: [0],
    recordFree: [64000, 600], ISORecordFree: [64000, 300], live: [0], liveStreamOutputBitrate: [0], outFormat: ['1080p60'],
    outFormatList: ['1080p24', '1080p25', '1080p30', '1080p50', '1080p60'], multiViewLayout: [0], inputMode: [0],
    indexed: {},
  };
  const ix = (id, i, v) => { s.indexed[`${id}:${i}`] = [i, v]; };
  for (let k = 0; k < m.keys; k++) { ix('keyEnable', k, 0); ix('keyType', k, 'Luma'); ix('keyOnAir', k, 0); }
  for (let k = 0; k < m.dsks; k++) { ix('dskEnable', k, 0); ix('dskOnAir', k, 0); ix('dskFillSource', k, 3010); ix('dskKeySource', k, 3011); ix('dskRate', k, 1); }
  for (const a of m.audio) { ix('audioMixerEnable', a, a > 1000 ? 1 : 2); ix('audioMixerFader', a, 0); ix('audioMixerPanning', a, 0); }
  ['YouTube', 'Facebook', 'Twitch'].forEach((name, i) => { ix('liveStreamOutputEnable', i, i === 0 ? 1 : 0); ix('liveStreamOutputServiceName', i, name); ix('liveStreamOutputStatus', i, 0); });
  for (const o of s.outSourceList) { s.indexed[`outSourceRange:${o}`] = [o, 10010, 10011, 9001, ...m.inputs.slice(0, 4)]; ix('outSource', o, o === 21002 ? 9001 : 10010); }
  for (const c of s.recordISOChannelList) ix('recordISOChannel', c, 1);
  s.macros = [[0, 'Opening', 'Cam 1 + logo'], [1, 'Wide shot', ''], [4, 'Closing', 'FTB']];
  return s;
}

function startSimulator({ port = 19010, model = 'deck', host = '127.0.0.1' } = {}) {
  const s = createState(model);
  const sockets = new Set();
  const out = (sock, id, type, value) => sock.write(pack({ id, type, value }));
  const pushAll = (id, value) => { for (const sk of sockets) out(sk, id, 'pus', value); };
  const setIx = (id, i, v) => { s.indexed[`${id}:${i}`] = [i, v]; pushAll(id, [i, v]); };
  let transitionTimer = null;

  const swap = (animated) => {
    const done = () => {
      const pgm = s.pgmIndex[0];
      s.pgmIndex = [s.pvwIndex[0]];
      s.pvwIndex = [pgm];
      pushAll('pgmIndex', s.pgmIndex);
      pushAll('pvwIndex', s.pvwIndex);
      s.transitionStatus = [0];
      pushAll('transitionStatus', [0]);
    };
    if (!animated) { done(); return; }
    s.transitionStatus = [1];
    pushAll('transitionStatus', [1]);
    clearTimeout(transitionTimer);
    transitionTimer = setTimeout(done, 300);
  };

  const handle = (sock, cmd) => {
    const v = Array.isArray(cmd.value) ? cmd.value : [];
    if (cmd.type === 'get') {
      if (cmd.id === 'macroInfos') { s.macros.forEach((mc) => out(sock, 'macroInfos', 'get', mc)); return; }
      if (v.length && s.indexed[`${cmd.id}:${v[0]}`]) { out(sock, cmd.id, 'get', s.indexed[`${cmd.id}:${v[0]}`]); return; }
      if (s[cmd.id] !== undefined && cmd.id !== 'indexed') out(sock, cmd.id, 'get', s[cmd.id]);
      return;
    }
    switch (cmd.id) {
      case 'cutTransition': swap(false); return;
      case 'autoTransition': swap(true); return;
      case 'ftb': s.ftbStatus = [s.ftbStatus[0] === 1 ? 0 : 1]; pushAll('ftbStatus', s.ftbStatus); return;
      case 'recordStart': s.recordStatus = [v[0] === 1 ? 2 : 1]; pushAll('recordStatus', s.recordStatus); return;
      case 'recordStop': s.recordStatus = [0]; pushAll('recordStatus', [0]); return;
      case 'live':
        s.live = [v[0] ? 1 : 0];
        pushAll('live', s.live);
        for (let i = 0; i < 3; i++) setIx('liveStreamOutputStatus', i, v[0] && s.indexed[`liveStreamOutputEnable:${i}`][1] ? 1 : 0);
        return;
      case 'macroRunStart': pushAll('macroRunIndex', [v[0], 1]); setTimeout(() => pushAll('macroRunIndex', [v[0], 0]), 800); return;
      case 'macroRunStop': return;
      default:
        if (v.length >= 2 && s.indexed[`${cmd.id}:${v[0]}`]) { setIx(cmd.id, v[0], v[1]); return; }
        if (s[cmd.id] !== undefined) { s[cmd.id] = v; pushAll(cmd.id, v); }
    }
  };

  const server = net.createServer((sock) => {
    sockets.add(sock);
    const parser = new PacketParser();
    sock.on('data', (chunk) => parser.push(chunk).forEach((c) => handle(sock, c)));
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve({
    server, state: s, port: server.address().port,
    close: () => new Promise((r) => { for (const sk of sockets) sk.destroy(); server.close(() => r()); }),
  })));
}

module.exports = { startSimulator, MODELS };

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
  startSimulator({ port: Number(opt('port', 19010)), model: opt('model', 'deck'), host: opt('host', '0.0.0.0') })
    .then((sim) => console.log(`Simulated ${sim.state.deviceName[0]} on port ${sim.port}`));
}
