# Unique AV OSEE Remote

Control **OSEE GoStream** switchers from an iPad: **GoStream Deck, Deck Plus, Duet, Duet SDI and Duet 8 ISO**.

The switchers use a TCP protocol that Safari can't use directly, so this app runs on a Mac or Windows PC on the same network. It talks to the switchers and serves the touch interface to any iPad, tablet or phone that opens its address. The same controls are also shown in the app's own window.

## Install

Download the latest version from the **Releases** page:

* **Mac:** `Unique-AV-OSEE-Remote-<version>-arm64.dmg` for Apple Silicon (M1–M4), `-x64.dmg` for Intel. Drag the app to **Applications**. The builds are unsigned unless signing secrets are set, so the first time, right-click the app and choose **Open**, or run:
  ```sh
  xattr -dr com.apple.quarantine "/Applications/Unique AV OSEE Remote.app"
  ```
* **Windows:** `Unique-AV-OSEE-Remote-Setup-<version>.exe`. If SmartScreen warns about an unknown publisher, choose **More info → Run anyway**. When Windows Firewall asks, allow **private networks** so iPads can connect.

## Connect an iPad

1. Start the app. The **Connect an iPad** window shows a QR code and address, for example `http://192.168.1.20:8090/`. Open it again from **Remote → Connect an iPad…** or the menu bar / tray icon.
2. Point the iPad camera at the code, or type the address into Safari. Tap **Share → Add to Home Screen** to run it full screen like an app.
3. Tap **＋** and **Find switchers on the network**, or type the switcher's IP address (shown on the switcher under *Settings → Network*). The port is 19010.

Closing the window keeps the server running so iPads stay connected; quit from the menu bar / tray icon. **Remote → Open at Login** starts it hidden when the computer starts.

Full control needs firmware **2.3 or newer** on Deck/Duet, or **2.1 or newer** on the Duet 8 ISO. Older firmware gets basic switching (choose *Old firmware* when adding the switcher).

## What you can do

* **Switcher:** Program and Preview buses, CUT, AUTO, FTB, Mix/Dip/Wipe with rate, preview transition, and every upstream key and DSK (NEXT and ON AIR).
* **Audio:** a touch fader per input (−75 to +10 dB), OFF/ON/AFV and pan.
* **Record & Stream:** record (and ISO record on the Duet 8 ISO), go live, and enable or disable each of the 3 stream destinations.
* **Macros:** run and stop the switcher's macros.
* **Outputs:** HDMI/USB output routing, multiview layout, model, firmware and video format.
* **Several switchers:** each gets a tab. Tap ⛓ on two or more to link them; CUT, AUTO, FTB, record and go-live then fire on all of them.
* Hold a source button to rename or hide it (shared by every iPad). Optional password, raw command console and keyboard shortcuts (Space = AUTO, Enter = CUT, 1–9 = preview, ⇧1–9 = program) in ⚙ Settings.

## Automatic updates

The app checks GitHub Releases 15 seconds after starting and then every 4 hours, and downloads new versions in the background. When one is ready it asks whether to restart now; if you choose **Later**, it installs the next time you quit. **Check for Updates…** is in the app menu (Mac), the File menu (Windows) and the tray menu.

* Mac: the app reads `update-mac.json`, downloads the `.zip` for its architecture, verifies the SHA-512 checksum and swaps the app bundle. This works for unsigned builds. The app must be in a folder it can write to, such as Applications.
* Windows: electron-updater reads `latest.yml` and runs the new installer.

Updates are read from `https://github.com/<owner>/<repo>/releases/latest/download`, set in `package.json` (`updateUrl` and `build.publish`). **The repository must be public**, because the app downloads releases without a GitHub login.

## Publishing a release

On GitHub, go to **Actions → Build → Run workflow**, type the new version (for example `1.0.1`) and optionally what's new, then **Run workflow**. In about 10 minutes it:

1. runs the tests,
2. builds the Apple Silicon and Intel `.dmg`/`.zip` and the Windows `.exe`,
3. publishes a GitHub Release with those files plus `update-mac.json` and `latest.yml`.

Installed copies pick it up within 4 hours, or straight away with *Check for Updates…*. Pushing a `v*` tag does the same. Every push also builds test installers, under *Actions → (run) → Artifacts*.

Optional signing secrets: `MAC_CERT_P12_BASE64`, `MAC_CERT_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` (Mac, also notarises), and `WIN_CERT_PFX_BASE64`, `WIN_CERT_PASSWORD` (Windows).

## Without the app

The server also runs on its own with Node.js 18+ (no `npm install` needed), for example on a Raspberry Pi:

```sh
node osee/server.js                       # http://<this-computer>:8090/
node osee/server.js --port 9000 --password secret --config ~/osee-devices.json
node osee/sim.js --model duet8iso         # a simulated switcher on port 19010 (deck, duet, duet8iso)
```

## Development

```sh
npm install
npm start          # run the app
npm test           # protocol + bridge tests (against the simulator) and updater tests
npm run dist:mac   # build on a Mac
npm run dist:win   # build on Windows
```

```
main.js               Electron app: server, window, tray, Connect-an-iPad window, menus
main/updates.js       Auto-update (Mac: main/updater-mac.js, Windows: electron-updater)
osee/gostream.js      OSEE GoStream TCP protocol (framing, CRC-16, state sync, reconnect)
osee/server.js        Bridge: HTTP + server-sent events for the web interface, device list
osee/discovery.js     Finds switchers (Bonjour _oseectrl._tcp + port 19010 subnet scan)
osee/sim.js           Simulated GoStream switcher
osee/public/          The touch web interface
scripts/              Release manifest generator, ad-hoc Mac signing
```

The GoStream protocol details come from the Bitfocus Companion `osee-gostream` module.
