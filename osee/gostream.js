// OSEE GoStream control protocol (GoStream Deck, Deck Plus, Duet, Duet SDI,
// Duet 8 ISO).
//
// TCP, default port 19010. Each message is a JSON command
//   { "id": "pgmIndex", "type": "get" | "set" | "pus", "value": [ ... ] }
// wrapped in a packet:
//   0xEB 0xA6 | proto (0x00) | U16LE length of what follows | JSON | U16LE CRC
// The CRC is CRC-16/MODBUS over everything before it, header included.
// The switcher answers a "get" with a "get" and a "set" with a "pus"; it
// also sends "pus" by itself when something changes on the panel.
//
// Firmware 2.3+ (Deck/Duet) and 2.1+ (Duet 8 ISO) use the "v2" command set
// below. Older firmware ("v1") speaks the same framing with different ids;
// only the basic switching commands are mapped for it.
'use strict';

const net = require('net');
const { EventEmitter } = require('events');

const DEFAULT_PORT = 19010;
const HEAD1 = 0xeb;
const HEAD2 = 0xa6;
const PROTO = 0x00;
const HEADER_SIZE = 5;

function crc16modbus(buf) {
  let crc = 0xffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let b = 0; b < 8; b++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return crc;
}

function pack(cmd) {
  const json = Buffer.from(JSON.stringify(cmd), 'utf8');
  const packet = Buffer.alloc(json.length + 7);
  packet[0] = HEAD1;
  packet[1] = HEAD2;
  packet[2] = PROTO;
  packet.writeUInt16LE(json.length + 2, 3);
  json.copy(packet, HEADER_SIZE);
  packet.writeUInt16LE(crc16modbus(packet.subarray(0, packet.length - 2)), packet.length - 2);
  return packet;
}

// Reassembles packets from a TCP byte stream. Packets can arrive several per
// segment or split across segments.
class PacketParser {
  constructor() {
    this.buf = Buffer.alloc(0);
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    for (;;) {
      let start = -1;
      for (let i = 0; i + 1 < this.buf.length; i++) {
        if (this.buf[i] === HEAD1 && this.buf[i + 1] === HEAD2) { start = i; break; }
      }
      if (start < 0) {
        // Keep a trailing 0xEB: it may be the first half of the next header.
        this.buf = this.buf.length && this.buf[this.buf.length - 1] === HEAD1 ? this.buf.subarray(-1) : Buffer.alloc(0);
        break;
      }
      if (start > 0) this.buf = this.buf.subarray(start);
      if (this.buf.length < HEADER_SIZE) break;
      const len = this.buf.readUInt16LE(3);
      if (len < 2 || len > 65000) { this.buf = this.buf.subarray(2); continue; }
      if (this.buf.length < HEADER_SIZE + len) break;
      const packet = this.buf.subarray(0, HEADER_SIZE + len);
      this.buf = this.buf.subarray(HEADER_SIZE + len);
      const crc = packet.readUInt16LE(packet.length - 2);
      if (crc !== crc16modbus(packet.subarray(0, packet.length - 2))) continue;
      try {
        const cmd = JSON.parse(packet.subarray(HEADER_SIZE, packet.length - 2).toString('utf8'));
        if (cmd && typeof cmd.id === 'string') out.push(cmd);
      } catch {
        // Corrupt JSON in a packet with a valid CRC: skip it.
      }
    }
    return out;
  }
}

// Ids whose first value is a channel/key/output index rather than the value
// itself, so the state store keeps one entry per index ("dskOnAir:1").
const INDEXED_V2 = /^(dsk(?!Count|FillSourceList|KeySourceList)\w+|key(Enable|Type|OnAir)|(luma|chroma|pattern|pip)(?!\w*List$)\w+|audioMixer(Enable|Fader|Panning|EffectEnable|HPF|HPFEnable|NoiseGate|NoiseGateEnable|Compressor|CompressorEnable|EQEnable|Limiter|LimiterEnable|MicType|MicTypeList|Input|Delay|OutSource)|AudioMixerAFVEnable|liveStreamOutput(Enable|ServiceName|Url|Key|Status)|macro(Infos|Info|RunIndex|RecordIndex)|recordISOChannel|color(Hue|Saturation|Brightness)|outSource(Range)?|playbackMode|playRepeat|playPause|playStatus|still|browser|mediaPlayer|multiSourceWindow\w+)$/;
const INDEXED_V1 = /^(audioFader|audioBalance|audioEnable|audioInput|audioDelay|macroInfo|liveInfo|streamOutput|streamPlatform|streamServer|streamKey|transitionRate)$/;

function storeKey(protocol, cmd) {
  const re = protocol === 'v1' ? INDEXED_V1 : INDEXED_V2;
  const v = Array.isArray(cmd.value) ? cmd.value : [];
  if (re.test(cmd.id) && v.length >= 2) return `${cmd.id}:${v[0]}`;
  return cmd.id;
}

const list = (v) => (Array.isArray(v) ? v.map(Number).filter((n) => !Number.isNaN(n)) : []);
const first = (store, id) => (store[id] ? store[id][0] : undefined);

// --- Initial state requests -------------------------------------------------

function syncPhase1V2() {
  return ['buildInfo', 'deviceId', 'deviceName', 'inputList', 'version', 'deviceType',
    'audioMixerInputSourceList', 'multiSourceWindowCount', 'keyCount', 'dskCount', 'playCount',
    'recordISOChannelList', 'audioMixerOutSourceList', 'outSourceList'].map((id) => ({ id, type: 'get' }));
}

function syncPhase2V2(store) {
  const g = (id, value) => (value === undefined ? { id, type: 'get' } : { id, type: 'get', value });
  const cmds = [
    'pgmIndex', 'pvwIndex', 'previewTransition', 'transitionStatus', 'transitionStyle',
    'transitionDipFillSource', 'transitionDipFillSourceList', 'transitionDipRate', 'transitionMixRate',
    'transitionWipeRate', 'transitionWipeDirection', 'transitionWipePatternIndex', 'ftbRate', 'ftbAfv', 'ftbStatus',
    'dskFillSourceList', 'dskKeySourceList', 'audioMixerSwitchType',
    'recordStatus', 'recordFormat', 'recordBitrate', 'recordDuration', 'recordFree', 'ISORecordFree',
    'live', 'liveStreamOutputBitrate', 'macroInfos', 'outFormat', 'outFormatList', 'multiViewLayout', 'inputMode',
  ].map((id) => g(id));
  const keys = Number(first(store, 'keyCount')) || 0;
  for (let i = 0; i < keys; i++) ['keyEnable', 'keyType', 'keyOnAir'].forEach((id) => cmds.push(g(id, [i])));
  const dsks = Number(first(store, 'dskCount')) || 0;
  for (let i = 0; i < dsks; i++) ['dskEnable', 'dskOnAir', 'dskFillSource', 'dskKeySource', 'dskRate'].forEach((id) => cmds.push(g(id, [i])));
  for (const s of list(store.audioMixerInputSourceList)) {
    ['audioMixerEnable', 'audioMixerFader', 'audioMixerPanning'].forEach((id) => cmds.push(g(id, [s])));
  }
  for (let i = 0; i < 3; i++) ['liveStreamOutputEnable', 'liveStreamOutputServiceName', 'liveStreamOutputStatus'].forEach((id) => cmds.push(g(id, [i])));
  for (const o of list(store.outSourceList)) ['outSourceRange', 'outSource'].forEach((id) => cmds.push(g(id, [o])));
  for (const c of list(store.recordISOChannelList)) cmds.push(g('recordISOChannel', [c]));
  return cmds;
}

function syncV1() {
  const cmds = ['pgmIndex', 'pvwIndex', 'prev', 'transitionIndex', 'keyOnAir', 'dskOnAir', 'ftb', 'record', 'recordTime',
    'live', 'getMacroInfoAll', 'audioTransition'].map((id) => ({ id, type: 'get' }));
  for (let s = 0; s <= 6; s++) ['audioFader', 'audioEnable'].forEach((id) => cmds.push({ id, type: 'get', value: [s] }));
  for (let t = 0; t <= 2; t++) cmds.push({ id: 'transitionRate', type: 'get', value: [t] });
  return cmds;
}

// --- Client -----------------------------------------------------------------

// Events: 'status' (status, message), 'params' ([{ key, cmd }]), 'synced'.
// status: 'connecting' | 'connected' | 'disconnected' | 'error'.
class GoStreamClient extends EventEmitter {
  constructor({ host, port = DEFAULT_PORT, protocol = 'v2', reconnectMs = 2000, connectTimeoutMs = 4000 } = {}) {
    super();
    this.host = host;
    this.port = Number(port) || DEFAULT_PORT;
    this.protocol = protocol === 'v1' ? 'v1' : 'v2';
    this.reconnectMs = reconnectMs;
    this.connectTimeoutMs = connectTimeoutMs;
    this.store = {};
    this.status = 'disconnected';
    this.message = '';
    this.socket = null;
    this.parser = null;
    this.timer = null;
    this.stopped = true;
    this.synced = false;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = null;
    if (this.socket) { this.socket.removeAllListeners(); this.socket.destroy(); this.socket = null; }
    this.setStatus('disconnected', '');
  }

  setStatus(status, message = '') {
    if (status === this.status && message === this.message) return;
    this.status = status;
    this.message = message;
    this.emit('status', status, message);
  }

  connect() {
    if (this.stopped) return;
    if (this.socket) { this.socket.removeAllListeners(); this.socket.destroy(); }
    this.parser = new PacketParser();
    this.synced = false;
    this.setStatus('connecting', `${this.host}:${this.port}`);
    const sock = new net.Socket();
    this.socket = sock;
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 2000);
    sock.setTimeout(this.connectTimeoutMs, () => sock.destroy(new Error('Connection timed out')));
    sock.on('connect', () => {
      sock.setTimeout(0);
      this.store = {};
      this.setStatus('connected', '');
      this.sync();
    });
    sock.on('data', (chunk) => this.receive(this.parser.push(chunk)));
    sock.on('error', (err) => this.setStatus('error', err.code === 'ECONNREFUSED' ? 'Connection refused' : err.message));
    sock.on('close', () => {
      if (this.socket !== sock) return;
      this.socket = null;
      if (this.status === 'connected') this.setStatus('disconnected', 'Connection closed');
      if (!this.stopped) {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.connect(), this.reconnectMs);
      }
    });
    sock.connect(this.port, this.host);
  }

  receive(cmds) {
    if (!cmds.length) return;
    const changes = [];
    for (const cmd of cmds) {
      if (!Array.isArray(cmd.value)) cmd.value = cmd.value === undefined ? [] : [cmd.value];
      const key = storeKey(this.protocol, cmd);
      this.store[key] = cmd.value;
      changes.push({ key, cmd });
    }
    this.emit('params', changes);
  }

  send(cmds) {
    if (!this.socket || this.status !== 'connected') return false;
    const list = (Array.isArray(cmds) ? cmds : [cmds]).filter((c) => c && typeof c.id === 'string' && c.id);
    if (!list.length) return false;
    this.socket.write(Buffer.concat(list.map((c) => pack({
      id: c.id,
      type: c.type === 'get' ? 'get' : 'set',
      ...(c.value === undefined ? {} : { value: Array.isArray(c.value) ? c.value : [c.value] }),
    }))));
    return true;
  }

  async sync() {
    const sock = this.socket;
    if (this.protocol === 'v1') {
      this.send(syncV1());
    } else {
      this.send(syncPhase1V2());
      // Counts and source lists decide what to ask for next.
      const t0 = Date.now();
      while (Date.now() - t0 < 1500 && !(this.store.dskCount && this.store.outSourceList && this.store.audioMixerInputSourceList)) {
        await new Promise((r) => setTimeout(r, 50));
        if (this.socket !== sock) return;
      }
      this.send(syncPhase2V2(this.store));
    }
    this.synced = true;
    this.emit('synced');
  }
}

module.exports = { GoStreamClient, PacketParser, pack, crc16modbus, storeKey, DEFAULT_PORT };
