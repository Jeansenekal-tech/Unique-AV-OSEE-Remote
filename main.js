// Unique AV OSEE Remote – desktop app.
//
// Runs the OSEE Switcher Remote bridge (osee/server.js) so iPads on the same
// network can control OSEE GoStream switchers, shows the same controls in a
// window, and keeps running in the menu bar / system tray when the window is
// closed. Updates itself from GitHub Releases (main/updates.js).
'use strict';

const { app, BrowserWindow, Menu, Tray, dialog, shell, nativeImage, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const { OseeBridge } = require('./osee/server');
const { Updates } = require('./main/updates');
const pkg = require('./package.json');

const APP_NAME = 'Unique AV OSEE Remote';
const IS_MAC = process.platform === 'darwin';
const DEFAULT_PORT = 8090;

app.setName(APP_NAME);
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showMain());
}

let mainWindow = null;
let connectWindow = null;
let tray = null;
let bridge = null;
let settings = { port: DEFAULT_PORT, shownConnect: false, shownTrayHint: false };
app.isQuitting = false;

const updates = new Updates({
  feedUrl: pkg.updateUrl,
  getWindow: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null),
});

// --------------------------------------------------------------- settings
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() {
  try { settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; } catch { /* first run */ }
}
function saveSettings() {
  try { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch { /* read-only */ }
}

// ----------------------------------------------------------------- bridge
// Use the saved port; if another program has it (Streaming GuRu also serves
// the remote on 8090), try the next few.
async function startBridge() {
  const first = Number(settings.port) || DEFAULT_PORT;
  let lastError = null;
  for (let port = first; port < first + 10; port++) {
    const b = new OseeBridge({ port, configFile: path.join(app.getPath('userData'), 'osee-devices.json'), log: () => {} });
    try {
      await b.start();
      bridge = b;
      if (port !== settings.port) { settings.port = port; saveSettings(); }
      return;
    } catch (e) {
      lastError = e;
      await b.stop().catch(() => {});
    }
  }
  dialog.showErrorBox(APP_NAME, `Could not start the remote server: ${lastError ? lastError.message : 'no free port'}`);
  app.exit(1);
}

const localUrl = () => `http://localhost:${bridge.port}/`;

// ---------------------------------------------------------------- windows
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 700,
    minHeight: 500,
    title: APP_NAME,
    backgroundColor: '#0d0f12',
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  mainWindow.loadURL(localUrl());
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  // Closing the window keeps the server running for the iPads.
  mainWindow.on('close', (e) => {
    if (app.isQuitting) return;
    e.preventDefault();
    mainWindow.hide();
    if (IS_MAC && app.dock) app.dock.hide();
    if (!settings.shownTrayHint) {
      settings.shownTrayHint = true;
      saveSettings();
      dialog.showMessageBox({
        message: `${APP_NAME} is still running`,
        detail: `iPads can keep controlling your switchers. Use the ${IS_MAC ? 'menu bar' : 'system tray'} icon to open the window again or to quit.`,
      });
    }
  });
}

function showMain() {
  if (IS_MAC && app.dock) app.dock.show();
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
  else { mainWindow.show(); mainWindow.focus(); }
}

async function connectPage() {
  const urls = bridge.urls();
  const cards = await Promise.all(urls.map(async (u) => {
    const qr = await QRCode.toDataURL(u, { margin: 1, width: 260, color: { dark: '#000000', light: '#ffffff' } });
    return `<div class="card"><img src="${qr}" alt=""><code>${u}</code></div>`;
  }));
  return `<!doctype html><html><head><meta charset="utf-8"><title>Connect an iPad</title><style>
    body { margin: 0; padding: 24px; background: #0d0f12; color: #e8ecf1; font: 15px -apple-system, "Segoe UI", sans-serif; text-align: center; }
    h1 { font-size: 20px; margin: 0 0 6px; } p { color: #8b95a3; margin: 6px 0 18px; line-height: 1.4; }
    .cards { display: flex; flex-wrap: wrap; gap: 16px; justify-content: center; }
    .card { background: #161a20; border: 1px solid #2a313b; border-radius: 14px; padding: 14px; display: flex; flex-direction: column; gap: 10px; align-items: center; }
    .card img { width: 220px; height: 220px; border-radius: 8px; background: #fff; }
    code { font-size: 15px; color: #f2a51a; -webkit-user-select: text; user-select: text; }
    ol { text-align: left; display: inline-block; color: #c5ccd6; line-height: 1.6; margin: 18px 0 0; }
  </style></head><body>
    <h1>Connect an iPad</h1>
    <p>Put the iPad on the same network as this computer, then point its camera at the code<br>(or type the address into Safari).</p>
    <div class="cards">${cards.join('') || '<p>No network connection found. Connect this computer to the switchers’ network.</p>'}</div>
    <ol><li>In Safari tap <b>Share → Add to Home Screen</b> to run it full screen like an app.</li>
    <li>Tap <b>＋</b> to add your GoStream switchers (or find them on the network).</li>
    ${IS_MAC ? '' : '<li>If Windows asks, allow this app on <b>private networks</b> so the iPad can reach it.</li>'}</ol>
  </body></html>`;
}

async function showConnect() {
  if (connectWindow && !connectWindow.isDestroyed()) { connectWindow.focus(); return; }
  connectWindow = new BrowserWindow({
    width: 620, height: 640, title: 'Connect an iPad', backgroundColor: '#0d0f12',
    parent: mainWindow && mainWindow.isVisible() ? mainWindow : undefined,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  connectWindow.setMenuBarVisibility(false);
  connectWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(await connectPage())}`);
}

function copyAddress() {
  const u = bridge.urls()[0] || localUrl();
  clipboard.writeText(u);
}

// ------------------------------------------------------------ menus, tray
function loginItemEnabled() {
  try { return app.getLoginItemSettings().openAtLogin; } catch { return false; }
}
function setLoginItem(on) {
  app.setLoginItemSettings({ openAtLogin: on, openAsHidden: true, args: on ? ['--hidden'] : [] });
  buildMenus();
}

function buildMenus() {
  const remote = [
    { label: 'Connect an iPad…', accelerator: 'CmdOrCtrl+I', click: () => showConnect() },
    { label: 'Copy iPad Address', click: () => copyAddress() },
    { label: 'Open in Web Browser', click: () => shell.openExternal(localUrl()).catch(() => {}) },
    { type: 'separator' },
    { label: 'Open at Login', type: 'checkbox', checked: loginItemEnabled(), click: (item) => setLoginItem(item.checked) },
  ];
  const template = [
    ...(IS_MAC ? [{
      label: APP_NAME,
      submenu: [
        { role: 'about' },
        { label: 'Check for Updates…', click: () => updates.check(true) },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : [{
      label: 'File',
      submenu: [{ label: 'Check for Updates…', click: () => updates.check(true) }, { type: 'separator' }, { label: 'Quit', click: () => quit() }],
    }]),
    { role: 'editMenu' },
    { label: 'Remote', submenu: remote },
    {
      label: 'View',
      submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));

  if (!tray) {
    const icon = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png')).resize({ width: IS_MAC ? 18 : 16, height: IS_MAC ? 18 : 16 });
    tray = new Tray(icon);
    tray.setToolTip(APP_NAME);
    if (!IS_MAC) tray.on('click', () => showMain());
  }
  const st = updates.status;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `${APP_NAME} – ${bridge.urls()[0] || localUrl()}`, enabled: false },
    { label: 'Open Remote', click: () => showMain() },
    ...remote,
    { type: 'separator' },
    st.status === 'ready'
      ? { label: `Restart to Update (${st.latest})`, click: () => updates.install(true) }
      : { label: 'Check for Updates…', click: () => updates.check(true) },
    { label: 'Quit', click: () => quit() },
  ]));
}

function quit() {
  app.isQuitting = true;
  app.quit();
}

// ------------------------------------------------------------------ start
app.whenReady().then(async () => {
  loadSettings();
  await startBridge();
  app.setAboutPanelOptions({ applicationName: APP_NAME, applicationVersion: app.getVersion(), copyright: 'Unique AV' });
  if (IS_MAC && app.dock) app.dock.setIcon(nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png')));

  updates.onChange(() => buildMenus());
  buildMenus();

  const startHidden = process.argv.includes('--hidden') || (IS_MAC && app.getLoginItemSettings().wasOpenedAsHidden);
  if (startHidden) {
    if (IS_MAC && app.dock) app.dock.hide();
  } else {
    createMainWindow();
  }
  if (!settings.shownConnect && !startHidden) {
    settings.shownConnect = true;
    saveSettings();
    mainWindow.once('ready-to-show', () => setTimeout(showConnect, 400));
  }
  updates.start();

  app.on('activate', () => showMain());
});

app.on('before-quit', () => {
  app.isQuitting = true;
  updates.installOnQuit();
  if (bridge) bridge.stop();
});

// The server keeps running with no windows open; quit from the tray/menu.
app.on('window-all-closed', () => {});
