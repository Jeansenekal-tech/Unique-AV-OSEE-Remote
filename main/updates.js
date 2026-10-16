// Automatic updates from this repository's GitHub Releases.
//
//  * macOS: our own updater (main/updater-mac.js). It reads update-mac.json,
//    downloads the .zip for this Mac's architecture, checks its SHA-512 and
//    swaps the app bundle. It works for unsigned builds, which the stock
//    Electron updater refuses.
//  * Windows: electron-updater with the NSIS installer (latest.yml).
//
// Updates download quietly in the background; the user is asked before the
// app restarts, and a downloaded update installs on quit anyway.
'use strict';

const { app, dialog } = require('electron');
const { Updater } = require('./updater-mac');

const CHECK_INTERVAL = 4 * 60 * 60 * 1000;

class Updates {
  constructor({ feedUrl, getWindow, log = console.log }) {
    this.feedUrl = feedUrl;
    this.getWindow = getWindow;
    this.log = log;
    this.status = { status: 'idle' };
    this.prompted = '';
    this.manual = false;
    this.listeners = new Set();
  }

  get supported() {
    return app.isPackaged && (process.platform === 'darwin' || process.platform === 'win32');
  }

  box(opts) {
    const win = this.getWindow();
    return win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts);
  }

  onChange(fn) { this.listeners.add(fn); }

  emit(status) {
    this.status = status;
    for (const fn of this.listeners) fn(status);
  }

  start() {
    if (!this.supported) return;
    if (process.platform === 'darwin') this.startMac();
    else this.startWindows();
  }

  startMac() {
    this.mac = new Updater({
      defaultUrl: this.feedUrl,
      isBusy: () => false,
      log: this.log,
      send: (st) => {
        this.emit(st);
        if (st.status === 'ready') this.promptRestart(st.latest);
        if (this.manual && ['uptodate', 'error'].includes(st.status)) this.reportManual(st.status, st.latest, st.error);
      },
    });
    this.mac.configure({ auto: true, autoDownload: true });
  }

  startWindows() {
    const { autoUpdater } = require('electron-updater');
    this.win = autoUpdater;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.setFeedURL({ provider: 'generic', url: this.feedUrl });
    autoUpdater.logger = { info: () => {}, warn: this.log, error: this.log, debug: () => {} };
    autoUpdater.on('checking-for-update', () => this.emit({ status: 'checking' }));
    autoUpdater.on('update-available', (i) => this.emit({ status: 'downloading', latest: i.version, progress: 0 }));
    autoUpdater.on('download-progress', (p) => this.emit({ ...this.status, status: 'downloading', progress: p.percent / 100 }));
    autoUpdater.on('update-not-available', (i) => {
      this.emit({ status: 'uptodate', latest: i.version });
      if (this.manual) this.reportManual('uptodate', i.version);
    });
    autoUpdater.on('update-downloaded', (i) => {
      this.emit({ status: 'ready', latest: i.version });
      this.promptRestart(i.version);
    });
    autoUpdater.on('error', (e) => {
      this.emit({ status: 'error', error: e.message });
      if (this.manual) this.reportManual('error', '', e.message);
    });
    setTimeout(() => this.check(false), 15000);
    setInterval(() => this.check(false), CHECK_INTERVAL);
  }

  check(manual = true) {
    this.manual = manual;
    if (!this.supported) {
      if (manual) this.box({ message: 'Updates work in the installed app only.', detail: `This copy is running from source (version ${app.getVersion()}).` });
      return;
    }
    if (this.status.status === 'ready') { this.prompted = ''; this.promptRestart(this.status.latest); return; }
    if (this.mac) this.mac.check(manual);
    else this.win.checkForUpdates().catch((e) => this.log(`Update check failed: ${e.message}`));
  }

  reportManual(status, latest, error) {
    this.manual = false;
    if (status === 'uptodate') this.box({ message: 'You have the latest version.', detail: `Unique AV OSEE Remote ${app.getVersion()}` });
    else this.box({ type: 'warning', message: 'Could not check for updates', detail: error || 'Unknown error' });
  }

  async promptRestart(version) {
    if (this.prompted === version) return;
    this.prompted = version;
    this.manual = false;
    const { response } = await this.box({
      message: `Version ${version} is ready to install`,
      detail: 'Restart now to update, or keep working: it installs automatically the next time you quit.\n\nRestarting briefly disconnects the iPads; they reconnect by themselves.',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) this.install(true);
  }

  install(relaunch) {
    if (this.status.status !== 'ready') return false;
    if (this.mac) {
      const r = this.mac.install({ relaunch, force: true });
      if (r.ok) { if (relaunch) app.quit(); return true; }
      if (r.message) this.box({ type: 'warning', message: 'Update not installed', detail: r.message });
      return false;
    }
    if (relaunch) { app.isQuitting = true; this.win.quitAndInstall(false, true); }
    return true; // Windows also installs on quit (autoInstallOnAppQuit)
  }

  // Called when the app is quitting normally.
  installOnQuit() {
    if (this.mac && this.status.status === 'ready' && !this.mac.installing) this.mac.install({ relaunch: false, force: true });
  }
}

module.exports = { Updates };
