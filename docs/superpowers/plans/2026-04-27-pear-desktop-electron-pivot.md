# PearCal Desktop — pivot to Electron (PearGuard pattern)

Supersedes phases 1–4 of `2026-04-27-pear-desktop.md`. Phase 5 (hardening +
parity QA) carries over with minor wording updates.

## Why pivot

The Pear-runtime path (Phases 1–3 of the prior plan) hit a wall at Phase 2.4:
`bare-pack` output (`desktop/bare-desktop.bundle` — 66 MB containing all of
`src/bare.js`'s P2P backend) cannot be loaded into Pear's bare worker. The
`.bundle` extension handler triggers a JSON walk-up that resolves to binary
content from Pear's own corestore. Two alternative load paths
(`Pear.worker.run('./bare-desktop.bundle')` directly; a `worker/` subproject
with `pear: { type: "terminal" }`) both fail too. See the prior plan's Phase
2 section for the full diagnostic trail.

The renderer-side workarounds we shipped (Phase 3.1: native module
replacements; 3.2a: deep-link receive; 3.2b: tray + custom title bar +
notifications) all exist *because* Pear's runtime imposed constraints — no
native window chrome, no shell-openExternal API, no native addon loading
over `pear://`, no auto-update model that fits our distribution. Most of
that complexity evaporates once we move off Pear.

**PearGuard Windows is the reference.** It uses the same Holepunch protocol
stack (Hypercore, Hyperbee, Hyperswarm, Hyperdht, sodium-native — direct npm
deps) but a **plain Electron runtime + Node main process**. A 36-line
`barekit-shim.js` installs `global.BareKit = { IPC: ... }` so the unmodified
`src/bare.js` runs in Electron's Node main process. Native binaries are
handled by `electron-rebuild` in `postinstall`. Packaging is `electron-builder`.

Net result: Phase 2.4 unblocks instantly, real P2P data flows, and most of
the Pear-specific renderer scaffolding gets deleted in favor of standard
Electron APIs.

## What survives, what gets replaced

| Concern | Pear path (current) | Electron path (new) |
|---|---|---|
| React UI (`src/ui/*`) | unchanged | unchanged |
| `src/bare.js` | runs in Pear bare worker (broken) | runs in Electron main via BareKit shim |
| `src/bare.js` IPC abstraction | `Pear.worker.pipe()` vs `BareKit.IPC` | shim provides `BareKit.IPC` directly |
| Renderer-side IPC bridge | inline `__pearDB.call` in `desktop/index.html` | preload script with `window.ReactNativeWebView.postMessage` (mobile contract) |
| Window chrome | custom 28px title bar, frameless | native `BrowserWindow` chrome |
| Tray + close-to-tray | `Pear.tray()` + `gui.hideable: true` | `Tray` + `mainWindow.on('close', e => { e.preventDefault(); hide() })` |
| Notifications | Web `Notification` + `setTimeout` in renderer | Electron `Notification` + `setTimeout` in main (or renderer; both work) |
| Open URL | `window.open` | `shell.openExternal(url)` |
| Share text | `navigator.clipboard` + toast | `clipboard.writeText` |
| Export `.ics` / recovery | Blob `<a download>` | `dialog.showSaveDialog` + `fs.writeFileSync` |
| Deep-link receive | `Pear.config.linkData` + `Pear.wakeups` | `app.on('open-url')` (macOS) + `second-instance` (Win/Linux) + `setAsDefaultProtocolClient('pearcal')` |
| Storage path | `Pear.config.storage` | `app.getPath('userData')` |
| Packaging | `cmake-pear` + `add_pear_appling()` | `electron-builder` (mature, cross-platform, signs+notarizes) |
| Auto-update | `pear stage` keys (we never reached this) | `electron-updater` (optional; can skip for v1) |

## Source tree (final)

```
pearcal-native/
├── electron/                          ← NEW Electron desktop subproject
│   ├── package.json                   electron + electron-builder + holepunch protocol deps
│   ├── src/
│   │   ├── main/
│   │   │   ├── index.js               main entrypoint: BrowserWindow, Tray, ipcMain, BareKit shim, requires src/bare.js
│   │   │   ├── bare-bridge.js         JSON-newline framing between ipcMain/ipcRenderer and the BareKit shim
│   │   │   ├── barekit-shim.js        copy of PearGuard's 36-line shim
│   │   │   ├── deep-link.js           setAsDefaultProtocolClient + open-url / second-instance routing
│   │   │   └── notifications.js       (optional split — could live inline in main)
│   │   └── renderer/
│   │       ├── index.html             loads ../../../src/ui bundle via <script src=…>
│   │       ├── preload.js             mirrors PearGuard's preload (window.ReactNativeWebView shim → ipcRenderer.invoke)
│   │       └── app-ui-electron.js     bundled output of src/ui/main.jsx (gitignored)
│   ├── build/                         icons, installer assets, entitlements.plist
│   │   ├── icon.icns                  (mac)
│   │   ├── icon.ico                   (win)
│   │   └── entitlements.mac.plist
│   ├── scripts/
│   │   └── bundle-ui.sh               esbuild src/ui/main.jsx → electron/src/renderer/app-ui-electron.js
│   └── README.md
├── src/
│   ├── bare.js                        no changes (runs unchanged under shim)
│   ├── ui/main.jsx                    no changes (existing `if (!window.__pearDB)` gate works fine; preload sets up the WebView shim that triggers main.jsx's RN postMessage path)
│   └── …
└── desktop/                           DELETED (the Pear-runtime version; lives in git history at c926826)
```

We delete `desktop/` outright — git preserves it. Do NOT try to maintain both
in parallel.

## Phase 0 — already done

Developer ID Application cert + notarytool keychain profile (`pearcal-notary`)
on the Mac Mini. Same artifacts feed `electron-builder` directly. See
`reference_macos_signing.md` and `reference_macos_notarization.md` memories.

## Phase E1 — Scaffold + Electron loads the UI

Goal: `npm start` opens a window with the calendar UI rendered. No bare.js
yet — UI talks to a stub `bare-call` handler.

### Tasks
1. `electron/package.json` with electron, electron-builder, electron-rebuild
   in devDeps; hypercore/hyperbee/hyperswarm/hyperdht/sodium-native/b4a in
   deps (same versions as `pearcal-native/package.json`).
2. `electron/src/main/index.js` — minimal main process: `app.whenReady()` →
   create `BrowserWindow({ webPreferences: { preload, contextIsolation: false, nodeIntegration: false } })` → `loadFile(renderer/index.html)`.
3. `electron/src/renderer/index.html` — loads `app-ui-electron.js` via
   `<script src=…>` (no Pear-style inline-only restriction; Electron's
   renderer is plain Chromium with module loading that just works).
4. `electron/src/renderer/preload.js` — copy of PearGuard's preload.js;
   provides `window.ReactNativeWebView.postMessage` and routes to
   `ipcRenderer.invoke('bare-call', …)`.
5. `electron/scripts/bundle-ui.sh` — esbuild `src/ui/main.jsx` →
   `electron/src/renderer/app-ui-electron.js` with `--format=iife`
   (matches the mobile bundle format; preload runs before, sets up
   `window.ReactNativeWebView`, then UI bundle inits).
6. Stub `ipcMain.handle('bare-call', () => null)` so the UI gets responses
   (UI won't render anything useful but won't crash).

### Verify gate
- `cd electron && npm install && npm start` opens a window.
- React UI renders (against stub responses, like the prior Pear stub).
- Native window chrome (X / minimize / maximize all work via OS).

## Phase E2 — Real `src/bare.js` running in main process

Goal: real P2P data. Calendar shows real events from the Hyperbee local DB,
swarm join/leave works, sync between two desktop instances works.

### Tasks
1. `electron/src/main/barekit-shim.js` — copy verbatim from
   `pearguard/windows/src/backend/barekit-shim.js`.
2. `electron/src/main/bare-bridge.js` — wires the shim to ipcMain:
   - `ipcMain.handle('bare-call', async (_e, { method, args }) => …)` —
     send a `{id, method, args}\n` line into the shim's `sendToBare`,
     await the matching `{id, result|error}\n` response from `onBareOut`.
   - For `event` frames from bare (no id), forward via
     `mainWindow.webContents.send('bare-event', msg)` (preload listens and
     dispatches to `window.__pearEvent`).
3. `electron/src/main/index.js` — install shim, then
   `require('../../../src/bare.js')`. Send the same `init` message bare.js
   expects: `{ method: 'init', dataDir: app.getPath('userData') + '/pearcal', platform: 'desktop' }`.
4. Verify all `bare-*` deps in `src/bare.js` resolve under Node:
   - `bare-fs` → likely needs replacement with `fs` (Node), OR works via
     bare-fs's Node-compatible mode if it has one. Discover during this
     phase; cross check against PearGuard's vendored bare.js for any patches.
   - `bare-path` → `path` (Node)
   - `bare-os` → `os` (Node)
   - `bare-events` → `events` (Node)
   - Most bare-* are thin wrappers; pick the lighter solution case-by-case.
   - **If extensive shimming is needed, vendor a Node-friendly copy of
     `src/bare.js` at `electron/vendor/bare.js` rather than mutating the
     shared source.** Mobile must not regress.

### Verify gate
- Open one desktop instance, create a profile, add an event. Restart the
  app — events persist (real Hyperbee on disk under `app.getPath('userData')/pearcal/`).
- Open a second desktop instance with a different `userData` dir, paste an
  invite link from the first. Group syncs.
- Open desktop ↔ Android (Pixel) and verify a third-party real-device sync.

## Phase E3 — Native module replacements

Direct ports of the Pear-runtime renderer-side intercepts to standard
Electron APIs. All happen in `main/index.js` via `ipcMain.handle('bare-call', …)`
intercepting the same method names before they reach bare.

| Method | Implementation |
|---|---|
| `openURL` / `openLightning` | `shell.openExternal(url)` |
| `canOpenLightning` | always emit `pear:canOpenLightning` event with `true` (unchanged) |
| `nativeShare` | `clipboard.writeText(text)` + `mainWindow.webContents.send('toast', '…copied to clipboard')` (renderer shows toast) |
| `exportIcs` / `exportRecoveryPhrase` | `dialog.showSaveDialog({ defaultPath: 'pearcal-events.ics' })` → `fs.writeFileSync(path, content)` |
| `haptic` | no-op |
| `exitApp` | `app.quit()` |
| `scheduleForEvent` / `cancelForEvent` / `restoreAll` | port the renderer-side notifications module from `desktop/index.html` to `main/notifications.js`; use Electron's `Notification` constructor; setTimeout in main process (alive across window-hide via the close-to-tray flag). `restoreAll` on cold launch can now actually walk `bare.listEvents()` and re-schedule (no longer a no-op). |

Plus tray + close-to-tray:
- `new Tray(iconPath)` with menu `{ Show, Quit }`.
- `mainWindow.on('close', e => { if (!isQuitting) { e.preventDefault(); mainWindow.hide() } })`.
- `app.on('before-quit', () => { isQuitting = true })` so tray Quit and OS shutdown actually close.

### Verify gate
- All Phase 3 verify items from the prior plan, plus:
- `restoreAll` on cold start re-schedules pending reminders from the real DB.
- `pearcal://join?…` clicked from a browser launches/focuses the desktop app
  and triggers join.

## Phase E4 — Package via electron-builder

Goal: signed-and-notarized installers for macOS, Linux, Windows on a `desktop-v*` git tag push.

### Tasks
1. `electron/package.json` `build` section — copy PearGuard's shape, adjust
   for cross-platform (it currently does Win only):
   - `mac`: `target: 'dmg'`, `category: 'public.app-category.productivity'`,
     `icon: build/icon.icns`, `entitlements: build/entitlements.mac.plist`,
     `hardenedRuntime: true`, `notarize: true`.
   - `linux`: `target: ['AppImage', 'deb']`, `icon: build/icon.png`,
     `category: 'Office'`.
   - `win`: `target: 'nsis'`, `icon: build/icon.ico`.
2. macOS signing/notarization config — point at the existing
   `pearcal-notary` keychain profile and `Developer ID Application: G79ALD29NA`
   identity (already provisioned in Phase 0).
3. URL scheme registration — declare `pearcal://` in
   `protocols: [{ name: 'PearCal', schemes: ['pearcal'] }]` so Mac
   `Info.plist` and Win registry both register correctly.
4. `app.setAsDefaultProtocolClient('pearcal')` in `main/index.js` for
   runtime registration on Win/Linux.
5. `app.on('open-url', (e, url) => …)` (macOS) and `app.on('second-instance', (e, argv) => …)` (Win/Linux — invite URL arrives via argv on a re-launch attempt) — both forward to the same `__pearHandleInvite` shim in the renderer.
6. GitHub Actions workflow: tag push → matrix build (mac/linux/win) →
   upload assets to GitHub Release. Mac job runs on the self-hosted Mac
   Mini for signing+notarization access.

### Verify gate
- `git tag desktop-v1.0.0 && git push --tags` produces signed `.dmg`,
  `.AppImage`, `.deb`, `.exe` on a GitHub Release.
- Fresh Mac with no PearCal: download → drag to Applications → first launch
  passes Gatekeeper, no "developer cannot be verified" prompt.
- Linux + Windows: download installer → install → launch → calendar UI.
- Click a `pearcal://join?…` link from a browser → installed app opens /
  focuses, Join Group sheet appears.

## Phase E5 — Hardening + parity QA

Same as the prior plan's Phase 5. Run full feature surface on a clean
installer per platform: events, recurrence, reminders, RSVPs, group
create/join/leave, profile, mnemonic restore, multi-peer sync (desktop ↔
iPhone, ↔ Pixel, ↔ desktop). DECISIONS.md entry per CONSTITUTION.md (T2:
new build pipeline + new distribution channel — pivot from Pear runtime to
Electron is the headline). README addendum. Close TODO #55 against this
plan; close #10 since electron-builder handles all three desktops in one
config.

## Risks (revised)

| Risk | Status |
|---|---|
| `src/bare.js` bare-* requires don't all resolve under Node | open — discover in Phase E2; vendor a copy if needed |
| `electron-rebuild` quirks per platform (sodium-native is the most likely) | open — PearGuard built it on Win, Mac+Linux are next |
| macOS notarization fails on first attempt due to entitlements | likely — iterate on entitlements.plist during Phase E4 |
| Bundle the React UI for Electron differs from mobile in subtle ways | low — same esbuild flags as the Pear path used; iife format |
| `app.on('open-url')` not registered until appling installed | known and correct; matches mobile cold-launch behavior |

## What we keep from the Pear-runtime work

- `src/bare.js` IPC abstraction (`_isDesktopPear` branch) — reused for the
  Electron path under a new flag, OR replaced if the BareKit shim makes
  the abstraction unnecessary.
- The plan + diagnostic notes in the prior plan — kept as historical
  context. The "blocked" framing on Phase 2.4 turned out to be accurate
  for the Pear runtime but not for the protocol stack.
- Memories about Pear renderer + native-addon constraints — kept as
  legacy notes. They describe accurate Pear behavior; they just don't
  apply to the Electron path.
- Phase 0 Developer ID + notarytool — feeds directly into electron-builder
  Mac signing.

## What we throw away

- All of `desktop/` (the Pear-runtime version).
- The custom title bar (Electron has native chrome).
- The `Pear.tray` integration (replaced by Electron `Tray`).
- The renderer-side native module intercepts (replaced by `ipcMain.handle`
  intercepts in main).
- The Phase 4 `cmake-pear` + appling pipeline (replaced by electron-builder).
- The bundle-load investigation (Phase 2.4 — moot for Electron path).
