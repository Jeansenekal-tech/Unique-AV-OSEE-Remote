// Auto-update for the macOS app (Windows uses electron-updater, see main/updates.js).
//
// Releases publish an `update-mac.json` manifest next to per-arch .zip/.dmg
// files (see scripts/make-update-manifest.mjs). The updater:
//   1. fetches the manifest and compares versions,
//   2. downloads the .zip for this Mac's architecture and verifies SHA-512,
//   3. unpacks it with `ditto`, then — after the app quits — swaps the app
//      bundle in place and relaunches.
// This works for both signed and unsigned builds (Squirrel.Mac, the stock
// Electron updater, refuses unsigned apps).
const { app, net, shell } = require('electron');
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MANIFEST = 'update-mac.json';
const CHECK_INTERVAL = 4 * 60 * 60 * 1000;

function parseVersion(v) {
  const [core, pre] = String(v).replace(/^v/, '').split('-');
  return { nums: core.split('.').map((n) => parseInt(n, 10) || 0), pre: pre || '' };
}

function isNewer(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if ((x.nums[i] || 0) !== (y.nums[i] || 0)) return (x.nums[i] || 0) > (y.nums[i] || 0);
  }
  if (x.pre === y.pre) return false;
  if (!x.pre) return true; // 1.2.0 > 1.2.0-beta
  if (!y.pre) return false;
  return x.pre > y.pre;
}

function joinUrl(base, name) {
  return `${base.replace(/\/+$/, '')}/${encodeURIComponent(name)}`;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)));
  });
}

class Updater {
  constructor({ defaultUrl, send, isBusy, log }) {
    this.defaultUrl = defaultUrl;
    this.send = send;
    this.isBusy = isBusy;
    this.log = log || (() => {});
    this.config = { auto: true, autoDownload: true, url: '' };
    this.state = { status: 'idle', current: app.getVersion() };
    this.timer = null;
    this.readyApp = null;
    this.installing = false;
  }

  get feedUrl() {
    return (this.config.url || this.defaultUrl || '').trim();
  }

  get supported() {
    return process.platform === 'darwin' && app.isPackaged;
  }

  set(patch) {
    this.state = { ...this.state, ...patch, current: app.getVersion() };
    this.send(this.status());
  }

  status() {
    return { ...this.state, feedUrl: this.feedUrl, supported: this.supported, config: this.config };
  }

  configure(cfg) {
    this.config = { ...this.config, ...cfg };
    clearInterval(this.timer);
    this.timer = null;
    if (this.config.auto && this.feedUrl) {
      this.timer = setInterval(() => this.check(false), CHECK_INTERVAL);
      if (!this.firstCheckDone) {
        this.firstCheckDone = true;
        setTimeout(() => this.check(false), 15000);
      }
    }
    return this.status();
  }

  async fetchManifest() {
    const url = joinUrl(this.feedUrl, MANIFEST);
    const res = await net.fetch(`${url}?t=${Date.now()}`, { cache: 'no-store', redirect: 'follow' });
    if (res.status === 404) throw new Error('No published release found at the update URL (a private GitHub repository can’t serve updates).');
    if (!res.ok) throw new Error(`Update server returned HTTP ${res.status}`);
    const m = await res.json();
    if (!m || !m.version || !Array.isArray(m.files)) throw new Error('Invalid update manifest');
    return m;
  }

  pickFile(manifest) {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    return manifest.files.find((f) => f.arch === arch && /\.zip$/i.test(f.name))
      || manifest.files.find((f) => f.arch === 'universal' && /\.zip$/i.test(f.name));
  }

  async check(manual = true) {
    if (!this.feedUrl) {
      this.set({ status: 'error', error: 'No update URL configured' });
      return this.status();
    }
    if (['checking', 'downloading'].includes(this.state.status)) return this.status();
    if (this.state.status === 'ready') return this.status();
    this.set({ status: 'checking', error: null, manual });
    try {
      const m = await this.fetchManifest();
      this.manifest = m;
      if (!isNewer(m.version, app.getVersion())) {
        this.set({ status: 'uptodate', latest: m.version, checkedAt: Date.now() });
        return this.status();
      }
      const file = this.pickFile(m);
      this.set({ status: 'available', latest: m.version, notes: m.notes || '', releaseDate: m.releaseDate, size: file?.size, checkedAt: Date.now() });
      if (this.config.autoDownload && this.supported && file) this.download();
    } catch (e) {
      this.log(`Update check failed: ${e.message}`);
      this.set({ status: 'error', error: e.message });
    }
    return this.status();
  }

  async download() {
    if (!this.supported) {
      // Development / non-Mac: just open the release page.
      if (this.manifest) shell.openExternal(this.feedUrl.replace(/\/download\/?$/, '')).catch(() => {});
      return this.status();
    }
    if (this.state.status === 'downloading' || this.state.status === 'ready') return this.status();
    const m = this.manifest || (await this.fetchManifest());
    const file = this.pickFile(m);
    if (!file) {
      this.set({ status: 'error', error: `No update package for ${process.arch}` });
      return this.status();
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osee-remote-update-'));
    const zipPath = path.join(dir, file.name);
    this.set({ status: 'downloading', progress: 0, latest: m.version });
    try {
      const res = await net.fetch(joinUrl(this.feedUrl, file.name), { redirect: 'follow', cache: 'no-store' });
      if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
      const total = Number(res.headers.get('content-length')) || file.size || 0;
      const hash = crypto.createHash('sha512');
      const out = fs.createWriteStream(zipPath);
      const reader = res.body.getReader();
      let got = 0;
      let lastSent = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        got += value.length;
        if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
        if (Date.now() - lastSent > 250) {
          lastSent = Date.now();
          this.set({ progress: total ? got / total : 0 });
        }
      }
      await new Promise((r, j) => out.end((err) => (err ? j(err) : r())));
      const digest = hash.digest('base64');
      if (file.sha512 && digest !== file.sha512) throw new Error('Downloaded update failed its integrity check');

      const extractDir = path.join(dir, 'app');
      fs.mkdirSync(extractDir);
      await run('/usr/bin/ditto', ['-x', '-k', zipPath, extractDir]);
      const bundle = fs.readdirSync(extractDir).find((n) => n.endsWith('.app'));
      if (!bundle) throw new Error('Update package does not contain an app');
      const newApp = path.join(extractDir, bundle);
      await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', newApp]).catch(() => {});
      fs.unlinkSync(zipPath);
      this.readyApp = newApp;
      this.workDir = dir;
      this.set({ status: 'ready', progress: 1 });
    } catch (e) {
      this.log(`Update download failed: ${e.message}`);
      this.set({ status: 'error', error: e.message });
    }
    return this.status();
  }

  currentBundle() {
    // …/Name.app/Contents/MacOS/Name  →  …/Name.app
    return path.resolve(path.dirname(process.execPath), '..', '..');
  }

  canReplace() {
    const bundle = this.currentBundle();
    try {
      fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
      fs.accessSync(bundle, fs.constants.W_OK);
      return !bundle.startsWith('/Volumes/') && !bundle.includes('/AppTranslocation/');
    } catch {
      return false;
    }
  }

  // Swap the bundle once this process exits; optionally relaunch.
  install({ relaunch = true, force = false } = {}) {
    if (!this.readyApp || this.installing) return { ok: false, message: 'No update ready' };
    if (!force && this.isBusy()) return { ok: false, message: 'Stop recording and streaming before updating.' };
    if (!this.canReplace()) {
      const dmg = (this.manifest?.files || []).find((f) => f.arch === (process.arch === 'arm64' ? 'arm64' : 'x64') && /\.dmg$/i.test(f.name));
      if (dmg) shell.openExternal(joinUrl(this.feedUrl, dmg.name)).catch(() => {});
      return { ok: false, message: 'The app can’t update itself from this location. Move it to the Applications folder – the new installer has been opened in your browser.' };
    }
    const script = path.join(os.tmpdir(), `osee-remote-install-${Date.now()}.sh`);
    fs.writeFileSync(script, `#!/bin/sh
APP="$1"; NEW="$2"; PID="$3"; RELAUNCH="$4"; WORK="$5"
while kill -0 "$PID" 2>/dev/null; do sleep 0.3; done
BAK="$APP.old-$$"
if mv "$APP" "$BAK"; then
  if /usr/bin/ditto "$NEW" "$APP"; then rm -rf "$BAK"; else rm -rf "$APP"; mv "$BAK" "$APP"; fi
fi
/usr/bin/xattr -dr com.apple.quarantine "$APP" 2>/dev/null
case "$WORK" in */osee-remote-update-*) rm -rf "$WORK" ;; esac
[ "$RELAUNCH" = "1" ] && /usr/bin/open "$APP"
rm -f "$0"
`, { mode: 0o755 });
    spawn('/bin/sh', [script, this.currentBundle(), this.readyApp, String(process.pid), relaunch ? '1' : '0', this.workDir], { detached: true, stdio: 'ignore' }).unref();
    this.installing = true;
    this.set({ status: 'installing' });
    return { ok: true };
  }
}

module.exports = { Updater, isNewer };
