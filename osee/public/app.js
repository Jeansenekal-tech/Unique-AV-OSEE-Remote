// OSEE Switcher Remote – touch UI. Talks to the bridge (server.js) over
// HTTP + Server-Sent Events; the bridge talks TCP to the switchers.
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

const S = {
  devices: new Map(),
  active: store.get('osee.active', null),
  tab: store.get('osee.tab', 'switch'),
  pass: store.get('osee.pass', ''),
  logs: new Map(), // device id -> recent incoming messages (for the console)
  dragging: false,
  renderQueued: false,
  es: null,
};

// ---------------------------------------------------------------------------
// Source names
// ---------------------------------------------------------------------------

const SOURCE_NAMES = {
  0: 'Black', 1000: 'Color Bars', 2001: 'Color 1', 2002: 'Color 2',
  3010: 'Still 1', 3011: 'Still 1 Key', 3020: 'Still 2', 3021: 'Still 2 Key',
  4001: 'AUX 1', 4002: 'AUX 2', 4003: 'AUX 3', 4004: 'AUX 4', 5001: 'S/SRC', 9001: 'Multiview',
  10010: 'PGM', 10011: 'PVW', 1301: 'MIC 1', 1302: 'MIC 2', 2301: 'Headphones',
  20001: 'SDI Out', 21001: 'HDMI Out 1', 21002: 'HDMI Out 2', 22001: 'USB-C Out', 25001: 'Stream',
};
const MODEL_NAMES = { 0: 'GoStream Deck', 1: 'GoStream Duet', 2: 'GoStream Deck', 3: 'GoStream Deck Plus', 10: 'GoStream Duet 8 ISO', 16: 'GoStream Duet 8 ISO' };

function label(dev, id, fallback) {
  const custom = dev.labels && dev.labels[id];
  if (custom) return custom;
  if (fallback) return fallback;
  if (SOURCE_NAMES[id]) return SOURCE_NAMES[id];
  if (id >= 1 && id <= 99) return `IN ${id}`;
  return `Src ${id}`;
}

// ---------------------------------------------------------------------------
// Protocol adapters: read the raw switcher state, build commands.
// ---------------------------------------------------------------------------

const val = (d, key, i = 0) => (d.store[key] ? d.store[key][i] : undefined);
const num = (d, key, i = 0, def = 0) => { const n = Number(val(d, key, i)); return Number.isNaN(n) ? def : n; };
const nums = (d, key) => (Array.isArray(d.store[key]) ? d.store[key].map(Number).filter((n) => !Number.isNaN(n)) : []);
const bool = (x) => x === true || x === 1 || x === '1' || x === 'true';
const set = (id, ...value) => ({ id, type: 'set', ...(value.length ? { value } : {}) });

const V2 = {
  model: (d) => MODEL_NAMES[num(d, 'deviceType', 0, -1)] || (d.store.deviceType ? 'GoStream' : ''),
  firmware: (d) => val(d, 'version') || '',
  deviceName: (d) => val(d, 'deviceName') || '',
  sources: (d) => nums(d, 'inputList').map((id) => ({ id, name: label(d, id) })),
  pgm: (d) => num(d, 'pgmIndex', 0, -1),
  pvw: (d) => num(d, 'pvwIndex', 0, -1),
  inTransition: (d) => num(d, 'transitionStatus') === 1,
  style: (d) => String(val(d, 'transitionStyle') || 'Mix'),
  rate: (d) => num(d, `transition${V2.style(d)}Rate`, 0, 1),
  prev: (d) => bool(val(d, 'previewTransition')),
  ftb: (d) => num(d, 'ftbStatus'), // 0 off, 1 black, 2 fading
  ftbSupported: (d) => d.store.ftbStatus !== undefined || num(d, 'deviceType', 0, -1) !== 10,
  usk: (d) => Array.from({ length: num(d, 'keyCount') }, (_, i) => ({
    i, onAir: bool(val(d, `keyOnAir:${i}`, 1)), next: bool(val(d, `keyEnable:${i}`, 1)), type: String(val(d, `keyType:${i}`, 1) || ''),
  })),
  dsk: (d) => Array.from({ length: num(d, 'dskCount') }, (_, i) => ({
    i, onAir: bool(val(d, `dskOnAir:${i}`, 1)), next: bool(val(d, `dskEnable:${i}`, 1)),
  })),
  audio: (d) => nums(d, 'audioMixerInputSourceList').map((s) => ({
    s, name: label(d, s), fader: num(d, `audioMixerFader:${s}`, 1, 0), state: num(d, `audioMixerEnable:${s}`, 1, 0),
    pan: num(d, `audioMixerPanning:${s}`, 1, 0), hasPan: true,
  })),
  record: (d) => ({
    status: num(d, 'recordStatus'), duration: num(d, 'recordDuration'), free: d.store.recordFree,
    iso: nums(d, 'recordISOChannelList').length > 0, format: val(d, 'recordFormat') || '',
  }),
  stream: (d) => {
    const outs = [0, 1, 2].map((i) => ({
      i, name: val(d, `liveStreamOutputServiceName:${i}`, 1) || `Stream ${i + 1}`,
      enabled: bool(val(d, `liveStreamOutputEnable:${i}`, 1)), status: num(d, `liveStreamOutputStatus:${i}`, 1),
    }));
    const live = bool(val(d, 'live')) || outs.some((o) => o.status === 1);
    return { live, outs, toggleable: true };
  },
  macros: (d) => {
    const out = [];
    for (const [k, v] of Object.entries(d.store)) {
      const m = k.match(/^macroInfos:(\d+)$/);
      if (m) out.push({ i: Number(m[1]), name: v[1] || `Macro ${Number(m[1]) + 1}`, desc: v[2] || '', running: num(d, `macroRunIndex:${m[1]}`, 1) === 1 });
    }
    return out.sort((a, b) => a.i - b.i);
  },
  outputs: (d) => nums(d, 'outSourceList').map((o) => ({
    o, name: label(d, o), src: num(d, `outSource:${o}`, 1, -1), range: nums(d, `outSourceRange:${o}`).slice(1),
  })),
  multiview: (d) => (d.store.multiViewLayout ? num(d, 'multiViewLayout') : null),
  outFormat: (d) => val(d, 'outFormat') || '',

  cmd: {
    pgm: (s) => [set('pgmIndex', s)],
    pvw: (s) => [set('pvwIndex', s)],
    cut: () => [set('cutTransition')],
    auto: () => [set('autoTransition')],
    ftb: () => [set('ftb')],
    style: (st) => [set('transitionStyle', st)],
    rate: (d, r) => [set(`transition${V2.style(d)}Rate`, r)],
    prev: (on) => [set('previewTransition', on ? 1 : 0)],
    uskAir: (i, on) => [set('keyOnAir', i, !!on)],
    uskNext: (i, on) => [set('keyEnable', i, !!on)],
    dskAir: (i, on) => [set('dskOnAir', i, on ? 1 : 0)],
    dskNext: (i, on) => [set('dskEnable', i, on ? 1 : 0)],
    fader: (s, db) => [set('audioMixerFader', s, db)],
    audioState: (s, st) => [set('audioMixerEnable', s, st)],
    pan: (s, p) => [set('audioMixerPanning', s, p)],
    record: (d, on, iso) => (on ? [...(V2.record(d).status ? [set('recordStop')] : []), set('recordStart', iso ? 1 : 0)] : [set('recordStop')]),
    live: (on) => [set('live', on ? 1 : 0)],
    streamEnable: (i, on) => [set('liveStreamOutputEnable', i, on ? 1 : 0)],
    macro: (i) => [set('macroRunStart', i)],
    macroStop: () => [set('macroRunStop')],
    outSource: (o, s) => [set('outSource', o, s)],
    multiview: (l) => [set('multiViewLayout', l)],
  },
};

// Firmware before 2.3: same framing, older ids, sources are 0-based slots.
const V1_SOURCES = ['IN 1', 'IN 2', 'IN 3', 'IN 4', 'AUX', 'S/SRC', 'Still 1', 'Still 2'];
const V1_AUDIO = ['MIC 1', 'MIC 2', 'IN 1', 'IN 2', 'IN 3', 'IN 4', 'AUX'];
const V1_STYLES = ['Mix', 'Dip', 'Wipe'];
const V1 = {
  model: () => 'GoStream (legacy firmware)',
  firmware: () => '< 2.3',
  deviceName: () => '',
  sources: (d) => V1_SOURCES.map((n, id) => ({ id, name: label(d, id, n) })),
  pgm: (d) => num(d, 'pgmIndex', 0, -1),
  pvw: (d) => num(d, 'pvwIndex', 0, -1),
  inTransition: (d) => bool(val(d, 'autoTransition')),
  style: (d) => V1_STYLES[num(d, 'transitionIndex')] || 'Mix',
  rate: (d) => num(d, `transitionRate:${num(d, 'transitionIndex')}`, 1, 1),
  prev: (d) => bool(val(d, 'prev')),
  ftb: (d) => (bool(val(d, 'ftb')) ? 1 : 0),
  ftbSupported: () => true,
  usk: (d) => [{ i: 0, onAir: bool(val(d, 'keyOnAir')), next: null, type: '' }],
  dsk: (d) => [{ i: 0, onAir: bool(val(d, 'dskOnAir')), next: null }],
  audio: (d) => V1_AUDIO.map((n, s) => ({
    s, name: label(d, 1000000 + s, n), fader: num(d, `audioFader:${s}`, 1, 0), state: num(d, `audioEnable:${s}`, 1, 0), hasPan: false,
  })),
  record: (d) => ({ status: bool(val(d, 'record')) ? 1 : 0, duration: num(d, 'recordTime'), free: null, iso: false, format: '' }),
  stream: (d) => ({ live: bool(val(d, 'live')), outs: [], toggleable: false }),
  macros: () => Array.from({ length: 12 }, (_, i) => ({ i, name: `Macro ${i + 1}`, desc: '', running: false })),
  outputs: () => [],
  multiview: () => null,
  outFormat: () => '',
  cmd: {
    pgm: (s) => [set('pgmIndex', s)],
    pvw: (s) => [set('pvwIndex', s)],
    cut: () => [set('cutTransition')],
    auto: () => [set('autoTransition')],
    ftb: () => [set('ftb')],
    style: (st) => [set('transitionIndex', Math.max(0, V1_STYLES.indexOf(st)))],
    rate: (d, r) => [set('transitionRate', num(d, 'transitionIndex'), r)],
    prev: (on) => [set('prev', on ? 1 : 0)],
    uskAir: (_i, on) => [set('keyOnAir', on ? 1 : 0)],
    uskNext: () => [],
    dskAir: (_i, on) => [set('dskOnAir', on ? 1 : 0)],
    dskNext: () => [],
    fader: (s, db) => [set('audioFader', s, db)],
    audioState: (s, st) => [set('audioEnable', s, st)],
    pan: () => [],
    record: (_d, on) => [set('record', on ? 1 : 0)],
    live: (on) => [set('live', on ? 1 : 0)],
    streamEnable: () => [],
    macro: (i) => [set('macroRun', 1, i)],
    macroStop: () => [set('macroRun', 0, 0)],
    outSource: () => [],
    multiview: () => [],
  },
};

const adapter = (d) => (d && d.protocol === 'v1' ? V1 : V2);
const activeDev = () => S.devices.get(S.active) || null;

// ---------------------------------------------------------------------------
// Bridge communication
// ---------------------------------------------------------------------------

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Osee-Pass': S.pass },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { askPassword(); throw new Error('Password required'); }
  if (!res.ok && res.status !== 409) throw new Error(data.error || res.statusText);
  return data;
}

// Sends to the active switcher, or to every linked switcher when `global`
// is set and the active one is linked.
function send(build, { global = false } = {}) {
  const d = activeDev();
  if (!d) return;
  const targets = global && d.linked ? [...S.devices.values()].filter((x) => x.linked) : [d];
  const payload = {};
  for (const t of targets) {
    if (t.status !== 'connected') continue;
    const cmds = build(adapter(t), t);
    if (cmds.length) payload[t.id] = cmds;
  }
  if (!Object.keys(payload).length) { toast(d.status === 'connected' ? 'Not available on this model' : 'Switcher is not connected'); return; }
  api('/api/send', { method: 'POST', body: { devices: payload } }).catch((e) => toast(e.message));
}

function connectEvents() {
  if (S.es) S.es.close();
  const es = new EventSource(`/api/events?pass=${encodeURIComponent(S.pass)}`);
  S.es = es;
  es.addEventListener('hello', (e) => {
    banner('');
    S.devices.clear();
    for (const d of JSON.parse(e.data).devices) S.devices.set(d.id, d);
    if (!S.devices.has(S.active)) S.active = S.devices.size ? S.devices.keys().next().value : null;
    render();
  });
  es.addEventListener('status', (e) => {
    const { id, status, message } = JSON.parse(e.data);
    const d = S.devices.get(id);
    if (!d) return;
    d.status = status;
    d.message = message;
    if (status === 'connecting') d.store = {};
    render();
  });
  es.addEventListener('params', (e) => {
    const { id, params } = JSON.parse(e.data);
    const d = S.devices.get(id);
    if (!d) return;
    Object.assign(d.store, params);
    const log = S.logs.get(id) || [];
    for (const [k, v] of Object.entries(params)) log.push(`← ${k} ${JSON.stringify(v)}`);
    S.logs.set(id, log.slice(-300));
    render();
  });
  es.addEventListener('device', (e) => {
    const d = JSON.parse(e.data);
    S.devices.set(d.id, d);
    if (!S.active) S.active = d.id;
    render();
  });
  es.addEventListener('removed', (e) => {
    S.devices.delete(JSON.parse(e.data).id);
    if (!S.devices.has(S.active)) S.active = S.devices.size ? S.devices.keys().next().value : null;
    render();
  });
  es.onerror = () => {
    banner('Connection to the bridge lost – reconnecting…');
    // A wrong password makes EventSource fail without a status code; check.
    fetch('/api/devices', { headers: { 'X-Osee-Pass': S.pass } }).then((r) => { if (r.status === 401) { es.close(); askPassword(); } }).catch(() => {});
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  if (S.renderQueued) return;
  S.renderQueued = true;
  requestAnimationFrame(() => {
    S.renderQueued = false;
    if (S.dragging) return; // re-rendered when the drag ends
    renderDevices();
    renderTop();
    renderTabs();
    renderView();
    if (S.consoleOpen) renderConsoleLog();
  });
}

function renderDevices() {
  $('#devices').innerHTML = [...S.devices.values()].map((d) => {
    const a = adapter(d);
    const sub = d.status === 'connected' ? (a.model(d) || 'Connected') : d.status === 'connecting' ? 'Connecting…' : (d.message || 'Offline');
    return `<div class="chip ${d.id === S.active ? 'active' : ''}" data-act="select" data-id="${d.id}">
      <span class="dot ${d.status}"></span>
      <span class="meta"><b>${esc(d.name || a.deviceName(d) || d.host)}</b><small>${esc(sub)}</small></span>
      <button class="link ${d.linked ? 'on' : ''}" data-act="link" data-id="${d.id}" title="Link: CUT/AUTO/FTB/REC/LIVE go to all linked switchers">⛓</button>
    </div>`;
  }).join('');
}

function renderTop() {
  const d = activeDev();
  let html = '';
  if (d && d.status === 'connected') {
    const a = adapter(d);
    const r = a.record(d);
    const st = a.stream(d);
    html += `<span class="pill ${r.status ? 'rec' : ''}">● REC${r.status === 2 ? ' ISO' : ''}</span>`;
    html += `<span class="pill ${st.live ? 'live' : ''}">LIVE</span>`;
  }
  $('#top-status').innerHTML = html;
}

function renderTabs() {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === S.tab));
}

function renderView() {
  const view = $('#view');
  const d = activeDev();
  if (!d) {
    view.innerHTML = `<div class="empty"><h2>No switchers yet</h2>
      <p>Add your OSEE GoStream switchers (Deck, Deck Plus, Duet, Duet SDI, Duet 8 ISO).<br>They must be on the same network as the computer running the bridge.</p>
      <button class="btn blue" data-act="add">＋ Add or find switchers</button></div>`;
    return;
  }
  if (d.status !== 'connected') {
    view.innerHTML = `<div class="empty"><h2>${esc(d.name || d.host)} is ${d.status === 'connecting' ? 'connecting…' : 'offline'}</h2>
      <p>${esc(d.host)}:${esc(d.port)} ${d.message ? '– ' + esc(d.message) : ''}</p>
      <p class="hint">Check the switcher is on, on this network, and its IP address is right (on the switcher: Settings → Network).</p>
      <button class="btn" data-act="edit" data-id="${d.id}">Edit connection</button></div>`;
    return;
  }
  const a = adapter(d);
  const fn = { switch: viewSwitch, audio: viewAudio, record: viewRecord, macros: viewMacros, outputs: viewOutputs }[S.tab] || viewSwitch;
  view.innerHTML = fn(d, a);
}

function viewSwitch(d, a) {
  const hidden = new Set(d.hidden || []);
  const sources = a.sources(d).filter((s) => !hidden.has(s.id));
  const pgm = a.pgm(d);
  const pvw = a.pvw(d);
  const bus = (kind, cur) => sources.map((s) => `<button class="btn ${s.id === cur ? kind : ''}" data-act="${kind}" data-v="${s.id}" data-rename="${s.id}">${esc(s.name)}</button>`).join('');
  const style = a.style(d);
  const rate = a.rate(d);
  const ftb = a.ftb(d);
  const keys = [
    ...a.usk(d).map((k) => keyCard(`Key ${k.i + 1}`, k.type, 'usk', k)),
    ...a.dsk(d).map((k) => keyCard(`DSK ${k.i + 1}`, '', 'dsk', k)),
  ].join('');
  const linked = d.linked ? [...S.devices.values()].filter((x) => x.linked).length : 0;
  return `<div class="switcher">
    <div class="buses">
      <div class="panel"><h3><span class="bus-label"><span class="tag pgm">PROGRAM</span></span><span class="muted">${esc(a.outFormat(d))}</span></h3>
        <div class="grid sources">${bus('pgm', pgm)}</div></div>
      <div class="panel"><h3><span class="bus-label"><span class="tag pvw">PREVIEW</span></span><span class="muted">hold a button to rename it</span></h3>
        <div class="grid sources">${bus('pvw', pvw)}</div></div>
      ${keys ? `<div class="panel"><h3>Keys</h3><div class="grid keys">${keys}</div></div>` : ''}
    </div>
    <div class="transition">
      <div class="cut-auto">
        <button class="btn big" data-act="cut">CUT</button>
        <button class="btn big ${a.inTransition(d) ? 'auto-running' : ''}" data-act="auto">AUTO</button>
        ${a.ftbSupported(d) ? `<button class="btn big ftb ${ftb === 1 ? 'ftb-on' : ftb === 2 ? 'auto-running' : ''}" data-act="ftb">FTB</button>` : ''}
      </div>
      ${linked > 1 ? `<div class="hint" style="text-align:center">⛓ Linked to ${linked - 1} other switcher${linked > 2 ? 's' : ''}</div>` : ''}
      <div class="panel"><h3>Transition</h3>
        <div class="seg">${['Mix', 'Dip', 'Wipe'].map((st) => `<button class="${st === style ? 'on' : ''}" data-act="style" data-v="${st}">${st.toUpperCase()}</button>`).join('')}</div>
        <div class="slider" style="margin-top:10px"><input type="range" min="0.5" max="8" step="0.5" value="${rate}" data-act="rate"><span class="val">${rate.toFixed(1)}s</span></div>
        <button class="btn ${a.prev(d) ? 'amber' : ''}" style="width:100%;margin-top:6px;min-height:48px" data-act="prev">PREV TRANS</button>
      </div>
    </div>
  </div>`;
}

function keyCard(name, type, kind, k) {
  return `<div class="key"><div class="name"><span>${esc(name)}</span><span>${esc(type)}</span></div>
    <div class="pair">
      ${k.next === null ? '<span></span>' : `<button class="btn ${k.next ? 'outline-amber' : ''}" data-act="${kind}Next" data-i="${k.i}" data-on="${k.next ? 0 : 1}">NEXT</button>`}
      <button class="btn ${k.onAir ? 'pgm' : ''}" data-act="${kind}Air" data-i="${k.i}" data-on="${k.onAir ? 0 : 1}">ON AIR</button>
    </div></div>`;
}

const FADER_MIN = -75;
const FADER_MAX = 10;
// Fader law: more travel near 0 dB, like a hardware fader.
const dbToPos = (db) => { const x = (Math.max(FADER_MIN, Math.min(FADER_MAX, db)) - FADER_MIN) / (FADER_MAX - FADER_MIN); return Math.pow(x, 2.2); };
const faderTop = (db) => `calc(14px + ${(1 - dbToPos(db)).toFixed(4)} * (100% - 28px))`;
const posToDb = (p) => { const db = FADER_MIN + Math.pow(Math.max(0, Math.min(1, p)), 1 / 2.2) * (FADER_MAX - FADER_MIN); return Math.round(db * 2) / 2; };

function viewAudio(d, a) {
  const strips = a.audio(d);
  if (!strips.length) return '<div class="empty">This switcher has not reported any audio channels.</div>';
  const states = [['OFF', ''], ['ON', 'pvw'], ['AFV', 'amber']];
  return `<div class="mixer">${strips.map((c) => `
    <div class="strip">
      <div class="label" data-rename="${d.protocol === 'v1' ? 1000000 + c.s : c.s}">${esc(c.name)}</div>
      <div class="grid" style="width:100%;gap:6px">${states.map(([n, cls], st) => `<button class="btn ${c.state === st ? cls || 'blue' : ''}" data-act="astate" data-s="${c.s}" data-v="${st}">${n}</button>`).join('')}</div>
      <div class="db" id="db-${c.s}">${c.fader <= FADER_MIN ? '-∞' : (c.fader > 0 ? '+' : '') + c.fader.toFixed(1)} dB</div>
      <div class="fader" data-fader="${c.s}" data-db="${c.fader}">
        <div class="track"></div>
        <div class="unity" style="top:${faderTop(0)}"></div>
        <div class="thumb" style="top:${faderTop(c.fader)}"></div>
      </div>
      <button class="btn" data-act="unity" data-s="${c.s}">0 dB</button>
      ${c.hasPan ? `<div class="pan"><input type="range" min="-100" max="100" step="1" value="${c.pan}" data-act="pan" data-s="${c.s}" title="Pan"></div><div class="hint">Pan ${c.pan}</div>` : ''}
    </div>`).join('')}</div>`;
}

const fmtTime = (s) => { s = Math.max(0, Math.floor(s)); return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, '0')).join(':'); };

function viewRecord(d, a) {
  const r = a.record(d);
  const st = a.stream(d);
  const free = Array.isArray(r.free) ? (Number(r.free[0]) === 0 && Number(r.free[1]) === 0 ? 'No USB drive' : `${r.free[0]} · ${r.free[1]}`) : '–';
  const statusName = ['Off', 'Live', 'Problem'];
  return `<div class="cols">
    <div class="panel"><h3>Record</h3>
      <div class="row" style="margin-bottom:10px">
        <button class="btn big ${r.status === 1 ? 'pgm' : ''}" style="flex:1" data-act="rec" data-on="${r.status === 1 ? 0 : 1}">${r.status === 1 ? '■ STOP' : '● REC'}</button>
        ${r.iso ? `<button class="btn big ${r.status === 2 ? 'pgm' : ''}" style="flex:1" data-act="recIso" data-on="${r.status === 2 ? 0 : 1}">${r.status === 2 ? '■ STOP ISO' : '● REC ISO'}</button>` : ''}
      </div>
      <div class="stat"><span>Status</span><b>${r.status === 2 ? 'Recording ISO' : r.status === 1 ? 'Recording' : 'Stopped'}</b></div>
      <div class="stat"><span>Duration</span><b>${fmtTime(r.duration)}</b></div>
      ${r.format ? `<div class="stat"><span>Format</span><b>${esc(r.format)}</b></div>` : ''}
      ${r.free ? `<div class="stat"><span>Free (space · time)</span><b>${esc(free)}</b></div>` : ''}
    </div>
    <div class="panel"><h3>Live stream</h3>
      <button class="btn big ${st.live ? 'pgm' : ''}" style="width:100%;margin-bottom:8px" data-act="live" data-on="${st.live ? 0 : 1}">${st.live ? '■ STOP STREAM' : '▶ GO LIVE'}</button>
      ${st.outs.map((o) => `<div class="dest">
        <span class="state-dot ${o.status === 1 ? 'on' : o.status === 2 ? 'bad' : ''}"></span>
        <div class="grow"><b>${esc(o.name)}</b><div class="hint">${statusName[o.status] || o.status}</div></div>
        <button class="btn ${o.enabled ? 'blue' : ''}" data-act="sEnable" data-i="${o.i}" data-on="${o.enabled ? 0 : 1}">${o.enabled ? 'Enabled' : 'Disabled'}</button>
      </div>`).join('')}
      ${st.outs.length ? '<p class="hint">Stream keys and servers are set in the GoStream Software Control app.</p>' : ''}
    </div>
  </div>`;
}

function viewMacros(d, a) {
  const macros = a.macros(d);
  if (!macros.length) return '<div class="empty">No macros on this switcher yet. Record them on the switcher or in GoStream Software Control.</div>';
  return `<div class="panel"><h3>Macros <button class="btn" style="min-height:40px" data-act="macroStop">■ Stop</button></h3>
    <div class="grid macros">${macros.map((m) => `<button class="btn ${m.running ? 'running' : ''}" data-act="macro" data-i="${m.i}">
      <span>${esc(m.name)}</span><small>${esc(m.desc || `#${m.i + 1}`)}</small></button>`).join('')}</div></div>`;
}

function viewOutputs(d, a) {
  const outs = a.outputs(d);
  const mv = a.multiview(d);
  if (!outs.length && mv === null) return '<div class="empty">Output routing is not available for this switcher.</div>';
  return `<div class="cols">
    <div class="panel outputs"><h3>Output routing</h3>
      ${outs.map((o) => `<div class="out"><b>${esc(o.name)}</b>
        <div class="grid">${(o.range.length ? o.range : [10010, 10011, 9001]).map((s) => `<button class="btn ${s === o.src ? 'blue' : ''}" data-act="outSrc" data-o="${o.o}" data-v="${s}">${esc(label(d, s))}</button>`).join('')}</div></div>`).join('')}
    </div>
    ${mv !== null ? `<div class="panel"><h3>Multiview layout</h3>
      <div class="seg">${['Layout 1', 'Layout 2'].map((n, i) => `<button class="${mv === i ? 'on' : ''}" data-act="mv" data-v="${i}">${n}</button>`).join('')}</div></div>` : ''}
    <div class="panel"><h3>Switcher</h3>
      <div class="stat"><span>Model</span><b>${esc(a.model(d))}</b></div>
      <div class="stat"><span>Name</span><b>${esc(a.deviceName(d) || '–')}</b></div>
      <div class="stat"><span>Firmware</span><b>${esc(a.firmware(d) || '–')}</b></div>
      <div class="stat"><span>Address</span><b>${esc(d.host)}:${esc(d.port)}</b></div>
      <div class="stat"><span>Video format</span><b>${esc(a.outFormat(d) || '–')}</b></div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Input handling
// ---------------------------------------------------------------------------

let longPress = null;
let suppressClick = false;

document.addEventListener('pointerdown', (e) => {
  const r = e.target.closest('[data-rename]');
  if (!r) return;
  clearTimeout(longPress);
  longPress = setTimeout(() => { suppressClick = true; renameDialog(Number(r.dataset.rename)); }, 650);
});
['pointerup', 'pointercancel', 'pointerleave'].forEach((t) => document.addEventListener(t, () => clearTimeout(longPress)));
document.addEventListener('contextmenu', (e) => { if (e.target.closest('[data-rename]')) e.preventDefault(); });

document.addEventListener('click', (e) => {
  if (suppressClick) { suppressClick = false; e.preventDefault(); return; }
  const el = e.target.closest('[data-act]');
  if (!el || el.tagName === 'INPUT') return;
  const act = el.dataset.act;
  const v = el.dataset.v;
  const i = Number(el.dataset.i);
  const on = el.dataset.on === '1';
  const s = Number(el.dataset.s);
  switch (act) {
    case 'select': S.active = el.dataset.id; store.set('osee.active', S.active); render(); break;
    case 'link': {
      e.stopPropagation();
      const d = S.devices.get(el.dataset.id);
      if (d) api(`/api/devices/${d.id}`, { method: 'PUT', body: { linked: !d.linked } }).catch((err) => toast(err.message));
      break;
    }
    case 'add': deviceDialog(null); break;
    case 'edit': deviceDialog(S.devices.get(el.dataset.id)); break;
    case 'pgm': send((a) => a.cmd.pgm(Number(v))); break;
    case 'pvw': send((a) => a.cmd.pvw(Number(v))); break;
    case 'cut': send((a) => a.cmd.cut(), { global: true }); break;
    case 'auto': send((a) => a.cmd.auto(), { global: true }); break;
    case 'ftb': send((a) => a.cmd.ftb(), { global: true }); break;
    case 'style': send((a) => a.cmd.style(v)); break;
    case 'prev': send((a, d) => a.cmd.prev(!a.prev(d))); break;
    case 'uskAir': send((a) => a.cmd.uskAir(i, on)); break;
    case 'uskNext': send((a) => a.cmd.uskNext(i, on)); break;
    case 'dskAir': send((a) => a.cmd.dskAir(i, on)); break;
    case 'dskNext': send((a) => a.cmd.dskNext(i, on)); break;
    case 'astate': send((a) => a.cmd.audioState(s, Number(v))); break;
    case 'unity': send((a) => a.cmd.fader(s, 0)); break;
    case 'rec': send((a, d) => a.cmd.record(d, on, false), { global: true }); break;
    case 'recIso': send((a, d) => a.cmd.record(d, on, true)); break;
    case 'live':
      if (on || confirm('Stop the live stream?')) send((a) => a.cmd.live(on), { global: true });
      break;
    case 'sEnable': send((a) => a.cmd.streamEnable(i, on)); break;
    case 'macro': send((a) => a.cmd.macro(i)); break;
    case 'macroStop': send((a) => a.cmd.macroStop()); break;
    case 'outSrc': send((a) => a.cmd.outSource(Number(el.dataset.o), Number(v))); break;
    case 'mv': send((a) => a.cmd.multiview(Number(v))); break;
    default: break;
  }
});

document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.dataset.act === 'rate') el.nextElementSibling.textContent = `${Number(el.value).toFixed(1)}s`;
  if (el.dataset.act === 'pan' && el.parentElement.nextElementSibling) el.parentElement.nextElementSibling.textContent = `Pan ${el.value}`;
});
document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.act === 'rate') send((a, d) => a.cmd.rate(d, Number(el.value)));
  if (el.dataset.act === 'pan') send((a) => a.cmd.pan(Number(el.dataset.s), Number(el.value)));
});
// Keep range inputs from being re-rendered under the finger.
document.addEventListener('pointerdown', (e) => { if (e.target.matches('input[type=range]')) S.dragging = true; });
document.addEventListener('pointerup', () => { if (S.dragging && !faderDrag) { S.dragging = false; render(); } });

// Faders: touch-drag with a throttled stream of commands.
let faderDrag = null;
document.addEventListener('pointerdown', (e) => {
  const f = e.target.closest('[data-fader]');
  if (!f) return;
  e.preventDefault();
  f.setPointerCapture(e.pointerId);
  const rect = f.getBoundingClientRect();
  const thumb = $('.thumb', f);
  const startPos = dbToPos(Number(f.dataset.db));
  const onThumb = e.target === thumb;
  faderDrag = { f, rect, thumb, s: Number(f.dataset.fader), startY: e.clientY, startPos, onThumb, last: 0, db: Number(f.dataset.db) };
  S.dragging = true;
  if (!onThumb) moveFader(e.clientY, true);
});
document.addEventListener('pointermove', (e) => { if (faderDrag) moveFader(e.clientY, false); });
document.addEventListener('pointerup', () => {
  if (!faderDrag) return;
  const { s, db } = faderDrag;
  send((a) => a.cmd.fader(s, db));
  faderDrag = null;
  S.dragging = false;
  render();
});

function moveFader(y, jump) {
  const fd = faderDrag;
  const travel = fd.rect.height - 28;
  const pos = jump || !fd.onThumb
    ? 1 - (y - fd.rect.top - 14) / travel
    : fd.startPos - (y - fd.startY) / travel;
  const db = posToDb(pos);
  fd.db = db;
  fd.thumb.style.top = faderTop(db);
  const lbl = document.getElementById(`db-${fd.s}`);
  if (lbl) lbl.textContent = `${db <= FADER_MIN ? '-∞' : (db > 0 ? '+' : '') + db.toFixed(1)} dB`;
  const now = Date.now();
  if (now - fd.last > 80) { fd.last = now; send((a) => a.cmd.fader(fd.s, db)); }
}

$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  S.tab = b.dataset.tab;
  store.set('osee.tab', S.tab);
  render();
});
$('#add-device').addEventListener('click', () => deviceDialog(null));
$('#open-settings').addEventListener('click', () => settingsDialog());

// Keyboard shortcuts for a hardware keyboard on the iPad.
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select, dialog')) return;
  const d = activeDev();
  if (!d) return;
  const a = adapter(d);
  if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); send((ad) => (e.key === ' ' ? ad.cmd.auto() : ad.cmd.cut()), { global: true }); return; }
  const n = Number(e.key);
  if (n >= 1 && n <= 9) {
    const src = a.sources(d).filter((x) => !(d.hidden || []).includes(x.id))[n - 1];
    if (src) send((ad) => (e.shiftKey ? ad.cmd.pgm(src.id) : ad.cmd.pvw(src.id)));
  }
});

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

function openDialog(html, onReady) {
  const dlg = $('#dlg');
  dlg.innerHTML = `<div class="dlg">${html}</div>`;
  if (!dlg.open) dlg.showModal();
  dlg.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => closeDialog()));
  if (onReady) onReady(dlg);
}
function closeDialog() {
  const dlg = $('#dlg');
  S.consoleOpen = false;
  if (dlg.open) dlg.close();
}
$('#dlg').addEventListener('click', (e) => { if (e.target.id === 'dlg') closeDialog(); });

function deviceDialog(dev) {
  const isNew = !dev;
  const c = dev || { name: '', host: '', port: 19010, protocol: 'v2' };
  openDialog(`
    <header>${isNew ? 'Add switcher' : 'Edit switcher'}<button class="icon-btn" data-close>✕</button></header>
    <div class="body">
      ${isNew ? `<button class="btn blue" id="scan">🔍 Find switchers on the network</button><div id="found" class="grid"></div>` : ''}
      <label class="field">Name (optional)<input id="f-name" value="${esc(c.name)}" placeholder="e.g. Main stage"></label>
      <label class="field">IP address<input id="f-host" value="${esc(c.host)}" placeholder="192.168.1.80" inputmode="decimal" autocapitalize="off" autocorrect="off"></label>
      <label class="field">Port<input id="f-port" value="${esc(c.port)}" inputmode="numeric"></label>
      <label class="field">Firmware
        <select id="f-proto">
          <option value="v2" ${c.protocol !== 'v1' ? 'selected' : ''}>Current firmware – full control</option>
          <option value="v1" ${c.protocol === 'v1' ? 'selected' : ''}>Old firmware – basic switching only</option>
        </select></label>
      <p class="hint">Full control needs firmware 2.3+ on Deck / Duet, or 2.1+ on Duet 8 ISO. The switcher's IP address is on its screen under Settings → Network; the port is 19010.</p>
    </div>
    <footer>
      ${isNew ? '' : '<button class="btn" id="remove" style="color:var(--pgm)">Remove</button><button class="btn" id="resync">Reconnect</button>'}
      <span class="spacer"></span>
      <button class="btn" data-close>Cancel</button>
      <button class="btn blue" id="save">${isNew ? 'Add' : 'Save'}</button>
    </footer>`, (dlg) => {
    const body = () => ({ name: $('#f-name', dlg).value, host: $('#f-host', dlg).value, port: Number($('#f-port', dlg).value) || 19010, protocol: $('#f-proto', dlg).value });
    $('#save', dlg).addEventListener('click', async () => {
      try {
        const b = body();
        if (!b.host.trim()) { toast('Enter the IP address'); return; }
        const res = isNew ? await api('/api/devices', { method: 'POST', body: b }) : await api(`/api/devices/${dev.id}`, { method: 'PUT', body: b });
        S.active = res.id;
        store.set('osee.active', S.active);
        closeDialog();
        render();
      } catch (e) { toast(e.message); }
    });
    if (!isNew) {
      $('#remove', dlg).addEventListener('click', async () => {
        if (!confirm(`Remove ${dev.name || dev.host}?`)) return;
        await api(`/api/devices/${dev.id}`, { method: 'DELETE' }).catch((e) => toast(e.message));
        closeDialog();
      });
      $('#resync', dlg).addEventListener('click', () => { api(`/api/devices/${dev.id}/resync`, { method: 'POST' }); closeDialog(); });
    } else {
      $('#scan', dlg).addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = 'Searching (about 5 seconds)…';
        const box = $('#found', dlg);
        try {
          const found = await api('/api/discover');
          box.innerHTML = found.length ? found.map((f) => `<div class="found"><div class="grow"><b>${esc(f.name || 'GoStream')}</b><div class="hint">${esc(f.host)}:${esc(f.port)} · ${f.via === 'bonjour' ? 'Bonjour' : 'network scan'}</div></div>
            ${f.known ? '<span class="muted">Added</span>' : `<button class="btn blue" data-host="${esc(f.host)}" data-port="${esc(f.port)}" data-name="${esc(f.name)}">Use</button>`}</div>`).join('')
            : '<p class="hint">Nothing found. Make sure the switcher is on the same network, or type its IP address below.</p>';
          box.querySelectorAll('button[data-host]').forEach((b) => b.addEventListener('click', () => {
            $('#f-host', dlg).value = b.dataset.host;
            $('#f-port', dlg).value = b.dataset.port;
            if (!$('#f-name', dlg).value) $('#f-name', dlg).value = b.dataset.name;
          }));
        } catch (err) { box.innerHTML = `<p class="hint">${esc(err.message)}</p>`; }
        btn.disabled = false;
        btn.textContent = '🔍 Search again';
      });
    }
  });
}

function renameDialog(id) {
  const d = activeDev();
  if (!d) return;
  const current = (d.labels || {})[id] || '';
  const hidden = (d.hidden || []).includes(id);
  const isSource = S.tab === 'switch';
  openDialog(`
    <header>Rename<button class="icon-btn" data-close>✕</button></header>
    <div class="body">
      <label class="field">Label (leave empty for the default)<input id="r-name" value="${esc(current)}" maxlength="24"></label>
      ${isSource ? `<label class="check"><input type="checkbox" id="r-hide" ${hidden ? 'checked' : ''}> Hide this source from the buttons</label>` : ''}
      <p class="hint">Labels are saved in the bridge, so every iPad sees them.</p>
    </div>
    <footer>${isSource && (d.hidden || []).length ? '<button class="btn" id="r-showall">Show all hidden</button>' : ''}<span class="spacer"></span><button class="btn" data-close>Cancel</button><button class="btn blue" id="r-save">Save</button></footer>`, (dlg) => {
    const input = $('#r-name', dlg);
    input.focus();
    const save = (labels, hiddenList) => api(`/api/devices/${d.id}`, { method: 'PUT', body: { labels, hidden: hiddenList } }).then(() => closeDialog()).catch((e) => toast(e.message));
    $('#r-save', dlg).addEventListener('click', () => {
      const labels = { ...(d.labels || {}), [id]: input.value.trim() };
      let h = (d.hidden || []).filter((x) => x !== id);
      if (isSource && $('#r-hide', dlg).checked) h.push(id);
      save(labels, h);
    });
    const showAll = $('#r-showall', dlg);
    if (showAll) showAll.addEventListener('click', () => save(d.labels || {}, []));
  });
}

async function settingsDialog() {
  let info = {};
  try { info = await (await fetch('/api/info')).json(); } catch { /* offline */ }
  const urls = (info.addresses || []).map((a) => `http://${a}:${info.port}/`);
  const d = activeDev();
  openDialog(`
    <header>Settings<button class="icon-btn" data-close>✕</button></header>
    <div class="body">
      <div><b>Open on other iPads / phones</b><div class="hint">${urls.map((u) => `<div><code>${esc(u)}</code></div>`).join('') || 'unknown'}</div>
        <p class="hint">Tip: in Safari tap Share → Add to Home Screen to run it full-screen like an app.</p></div>
      <label class="field">Bridge password (leave empty for none)<input id="s-pass" type="password" placeholder="${info.needsPassword ? '•••••• (set)' : 'none'}"></label>
      <div class="row"><button class="btn" id="s-savepass">Set password</button></div>
      ${d ? `<hr style="border-color:var(--line);width:100%">
      <div><b>Console – ${esc(d.name || d.host)}</b><div class="hint">Send any GoStream command, e.g. id <code>pgmIndex</code>, value <code>[2]</code>.</div></div>
      <div class="row">
        <label class="field" style="flex:2">Command id<input id="c-id" autocapitalize="off" autocorrect="off"></label>
        <label class="field" style="flex:1">Type<select id="c-type"><option>set</option><option>get</option></select></label>
      </div>
      <label class="field">Value (JSON array, optional)<input id="c-val" placeholder="[1]" autocapitalize="off" autocorrect="off"></label>
      <div class="row"><button class="btn blue" id="c-send">Send</button><button class="btn" id="c-clear">Clear log</button></div>
      <div class="log" id="c-log"></div>` : ''}
    </div>
    <footer><button class="btn" data-close>Done</button></footer>`, (dlg) => {
    $('#s-savepass', dlg).addEventListener('click', async () => {
      const p = $('#s-pass', dlg).value;
      try {
        await api('/api/settings', { method: 'PUT', body: { password: p } });
        S.pass = p;
        store.set('osee.pass', p);
        toast(p ? 'Password set' : 'Password removed');
        connectEvents();
      } catch (e) { toast(e.message); }
    });
    if (!d) return;
    S.consoleOpen = true;
    renderConsoleLog();
    $('#c-send', dlg).addEventListener('click', () => {
      const id = $('#c-id', dlg).value.trim();
      if (!id) return;
      let value;
      const raw = $('#c-val', dlg).value.trim();
      if (raw) {
        try { value = JSON.parse(raw); } catch { toast('Value must be JSON, e.g. [1] or ["Mix"]'); return; }
        if (!Array.isArray(value)) value = [value];
      }
      const cmd = { id, type: $('#c-type', dlg).value, ...(value ? { value } : {}) };
      const log = S.logs.get(d.id) || [];
      log.push(`→ ${JSON.stringify(cmd)}`);
      S.logs.set(d.id, log);
      api(`/api/devices/${d.id}/send`, { method: 'POST', body: { cmds: [cmd] } }).then((r) => { if (!r.ok) toast('Not connected'); }).catch((e) => toast(e.message));
      renderConsoleLog();
    });
    $('#c-clear', dlg).addEventListener('click', () => { S.logs.set(d.id, []); renderConsoleLog(); });
  });
}

function renderConsoleLog() {
  const el = $('#c-log');
  const d = activeDev();
  if (!el || !d) return;
  const stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
  el.textContent = (S.logs.get(d.id) || []).join('\n');
  if (stick) el.scrollTop = el.scrollHeight;
}

function askPassword() {
  if ($('#dlg').open && $('#p-pass')) return;
  openDialog(`
    <header>Password</header>
    <div class="body"><label class="field">This bridge is password protected<input id="p-pass" type="password"></label></div>
    <footer><button class="btn blue" id="p-ok">Unlock</button></footer>`, (dlg) => {
    const go = () => { S.pass = $('#p-pass', dlg).value; store.set('osee.pass', S.pass); closeDialog(); connectEvents(); };
    $('#p-ok', dlg).addEventListener('click', go);
    $('#p-pass', dlg).addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  });
}

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}
function banner(msg) {
  const b = $('#banner');
  b.textContent = msg;
  b.classList.toggle('show', !!msg);
}

// Keep the screen from dimming mid-show where the browser allows it.
async function keepAwake() {
  try { if ('wakeLock' in navigator && document.visibilityState === 'visible') await navigator.wakeLock.request('screen'); } catch { /* not allowed */ }
}
document.addEventListener('visibilitychange', keepAwake);
document.addEventListener('click', keepAwake, { once: true });

connectEvents();
render();
