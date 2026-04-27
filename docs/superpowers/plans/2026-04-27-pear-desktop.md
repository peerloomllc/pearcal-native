# PearCal Desktop via Pear Runtime — implementation plan

Replaces the Mac Catalyst path in TODO #55 (blocked by missing maccatalyst slices in `react-native-bare-kit@0.12.2`'s prebuilt XCFrameworks).

## Spike findings (2026-04-27)

Phase 0 (done) and Phase 1 (done — see "Status" below) confirmed:

1. **PearCal's existing React UI bundle renders unchanged in Pear's renderer** when rebuilt with `--format=esm`. Same React tree, no source code changes to `App.jsx`.
2. **`src/bare.js` runs in Pear's bare worker.** Pear is built on Bare; the only IPC port needed is `BareKit.IPC.write/on('data')` → `Pear.worker.pipe()`.
3. **Pear's runtime is `pear-electron`-incompatible at v0.9609 (rc channel).** `pear-rti` blows up because `Pear.constructor.RTI` is undefined. The newer pear-electron + pear-bridge + pear-pipe + RTI architecture is *not* in the installed Pear yet.
4. **The simple `type: "desktop"` model + `Pear.worker.run('./bare-worker.js')`** works on the installed Pear. We use that.
5. **External `<script src="./x.js" type="module">` crashes the renderer.** Pear wraps external module files through `node-bare-bundle` as CJS — top-level await throws and the renderer dies silently. **Inline `<script type="module">` works correctly**, so all renderer-side code lives in `desktop/index.html`. (Saved as memory: `feedback_pear_renderer_inline_modules.md`.)
6. **`cmake-pear` + `add_pear_appling()` is the canonical packaging path** — same one Holepunch uses for Keet's Mac/Windows/Linux installables.

Distribution: **GitHub Releases only**, signed-and-notarized macOS `.dmg`. Mac App Store is not a target (Pear's self-update model violates sandbox rules). Per scope decision saved 2026-04-27, **widgets and QR-scanning are out of scope on desktop**.

## Status

| Phase | Status |
|---|---|
| 0 — Prerequisites (Developer ID Application cert + notarytool profile) | ✅ Done 2026-04-27 |
| 1 — Pear app boots, calendar UI renders, real bare worker IPC over `Pear.worker.pipe` | ✅ Done 2026-04-27 |
| 2 — `src/bare.js` running over the worker pipe | 🔶 in progress (blocker — see Phase 2) |
| 3.1 — Renderer-side native module replacements (openURL, share, .ics, haptic, exitApp) | ✅ Done 2026-04-27 |
| 3.2a — Deep-link receive (Pear.wakeups + Pear.config.link) | ✅ Done 2026-04-27 (full E2E pending Phase 4 appling) |
| 3.2b — Notifications | not started |
| 4 — Appling + GitHub release pipeline | not started |
| 5 — Hardening + parity QA | not started |

## Architecture (final)

Two layers in Pear, with the same `{id, method, args}` JSON-newline IPC envelope as mobile:

```
Mobile (today)                         Desktop (this plan)
─────────────────────                  ─────────────────────
RN shell (app/index.tsx)        →      (gone — Pear is the shell)

WebView UI                      →      Pear renderer (Electron-backed)
  src/ui/main.jsx                        IPC bridge inline in desktop/index.html
  src/ui/App.jsx                         App.jsx unchanged

Bare worklet                    →      Pear bare worker
  src/bare.js                            src/bare.js with one IPC line abstracted

BareKit.IPC                     →      Pear.worker.pipe() (same JSON-newline envelope)
window.ReactNativeWebView       →      pipe.write() in renderer (inline)
```

The renderer-side facade (`window.__pearDB.call`, `window.__pearResponse`, `window.__pearEvent`) is preserved unchanged so `App.jsx` doesn't know it's running on desktop. `src/ui/main.jsx` was modified to skip its RN postMessage path when `window.__pearDB` is already pre-set by the host (one `if (!window.__pearDB)` gate).

## Source tree (final)

```
pearcal-native/
├── desktop/                          ← new top-level desktop subproject
│   ├── package.json                  simple `pear: { type: "desktop", gui: {...} }`
│   ├── index.html                    renderer entry — IPC bridge inline + dynamic import of UI bundle
│   ├── bare-worker.js                bare worker entry (Phase 1 stub; Phase 2 loads bare.js)
│   ├── app-ui-desktop.mjs            ← built artifact (gitignored)
│   └── README.md                     dev/build instructions  (Phase 5)
├── desktop-appling/                  ← separate, only built at release (Phase 4)
│   ├── package.json                  cmake-pear devDep
│   ├── CMakeLists.txt                add_pear_appling(...)
│   └── assets/darwin/icon.png
├── scripts/
│   ├── desktop-bundle.sh             ✅ bundles src/ui/main.jsx → desktop/app-ui-desktop.mjs (ESM)
│   ├── desktop-stage.sh              pear stage  (Phase 4)
│   ├── desktop-appling-build.sh      bare-make build → notarytool → create-dmg  (Phase 4)
│   └── desktop-release.sh            tag-driven pipeline  (Phase 4)
└── src/
    ├── ui/main.jsx                   ✅ gated `if (!window.__pearDB)` so desktop pre-set wins
    └── bare.js                        Phase 2: abstract `BareKit.IPC` ↔ `Pear.worker.pipe()`
```

## Phase 0 — Prerequisites ✅ COMPLETE

- ✅ Developer ID Application cert provisioned (`22F9540D333EBFB4245EE11170F68A61E6E22689`, Apple Team `G79ALD29NA`)
- ✅ `notarytool` keychain profile `pearcal-notary` stored on Mac Mini in `buildkey.keychain-db`
- See `reference_macos_signing.md` and `reference_macos_notarization.md` memories for full details.

## Phase 1 — Minimal Pear app + worker IPC ✅ COMPLETE

End state: `pear run --dev desktop/` opens a window, calendar UI renders, all `window.__pearDB.call(...)` requests round-trip through `Pear.worker.run/pipe` to a bare worker stub. Mobile builds (iOS / Android) unaffected.

### 1.1 — Scaffold

**`desktop/package.json`** (no deps — Pear's runtime provides everything):
```json
{
  "name": "pearcal-desktop",
  "version": "0.0.0",
  "main": "index.html",
  "pear": {
    "name": "pearcal",
    "type": "desktop",
    "gui": {
      "width": 1024, "height": 720,
      "minWidth": 720, "minHeight": 480,
      "backgroundColor": "#0f172a"
    }
  }
}
```

`pear.name` must be lowercase, single token (Pear's `validateAppName` rejects `PearCal`).

**`desktop/index.html`** (all renderer code inline; external `<script src=>` crashes the renderer):
```html
<script>
  // Spawn bare worker; install IPC bridge before UI bundle loads.
  const pipe = Pear.worker.run('./bare-worker.js')
  const _pending = new Map()
  let _nextId = 1
  let _buf = ''
  const _decoder = new TextDecoder('utf-8')
  pipe.on('data', (chunk) => {
    _buf += _decoder.decode(chunk, { stream: true })
    let i
    while ((i = _buf.indexOf('\n')) >= 0) {
      const line = _buf.slice(0, i); _buf = _buf.slice(i + 1)
      if (!line) continue
      const msg = JSON.parse(line)
      if (msg.event) window.dispatchEvent(new CustomEvent('pear:' + msg.event, { detail: msg.data }))
      else if (typeof msg.id === 'number') {
        const r = _pending.get(msg.id); if (r) { _pending.delete(msg.id); r(msg) }
      }
    }
  })
  const _enc = new TextEncoder()
  window.__pearDB = {
    call (method, ...args) {
      return new Promise((resolve, reject) => {
        const id = _nextId++
        _pending.set(id, msg => msg.error ? reject(new Error(msg.error)) : resolve(msg.result))
        pipe.write(_enc.encode(JSON.stringify({ id, method, args }) + '\n'))
      })
    }
  }
  window.__pearResponse = (msg) => { const r = _pending.get(msg.id); if (r) { _pending.delete(msg.id); r(msg) } }
  window.__pearEvent = (event, data) => window.dispatchEvent(new CustomEvent('pear:' + event, { detail: data }))
</script>
<script type="module">
  await import('./app-ui-desktop.mjs')
</script>
```

**`desktop/bare-worker.js`** (Phase 1 stub — replaced by `src/bare.js` bundle in Phase 2):
```js
const pipe = Pear.worker.pipe()
const STUB = { getProfile: { id: 'desktop-stub', name: 'Desktop User', color: '#3b82f6' }, listEvents: [], /* ... */ }
let _buf = ''
pipe.on('data', (chunk) => {
  _buf += chunk.toString('utf8')
  let i
  while ((i = _buf.indexOf('\n')) >= 0) {
    const line = _buf.slice(0, i); _buf = _buf.slice(i + 1)
    if (!line) continue
    const msg = JSON.parse(line)
    const result = (msg.method in STUB) ? STUB[msg.method] : null
    pipe.write(Buffer.from(JSON.stringify({ id: msg.id, result }) + '\n'))
  }
})
```

### 1.2 — Bundle script (`scripts/desktop-bundle.sh`)
```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
npx esbuild src/ui/main.jsx --bundle --format=esm --jsx=automatic \
  --define:process.env.NODE_ENV=\"production\" \
  --outfile=desktop/app-ui-desktop.mjs
```

### 1.3 — `src/ui/main.jsx` IPC gate

```js
// IPC bridge — installed only if a host (desktop's index.html) hasn't already wired one.
if (!window.__pearDB) {
  // …existing RN postMessage code unchanged…
}
```

### 1.4 — Verify gate ✅
- `pear run --dev desktop/` opens a window, calendar UI renders.
- App.jsx queries `getProfile`, `hasMnemonic`, etc. via `window.__pearDB.call` → JSON over pipe → bare worker stub → JSON response back. Round-trip working.
- Mobile builds smoke-tested: `npx esbuild ... --format=iife --outfile=/tmp/mobile-smoketest.bundle` succeeds (1.3MB, identical size).
- Verified on `feature/pear-desktop` branch.

## Phase 2 — `src/bare.js` over the worker pipe (1 day → 🔶 BLOCKED)

End state: full P2P calendar — create events, sync with another device. Desktop is just another peer on Hyperswarm.

### 2.1 — IPC abstraction in `src/bare.js` ✅ DONE 2026-04-27

`src/bare.js:22-27` now picks the IPC duplex at module load:
```js
const _isDesktopPear = typeof BareKit === 'undefined' && typeof Pear !== 'undefined'
const ipc = _isDesktopPear ? Pear.worker.pipe() : BareKit.IPC
const send = (msg) => ipc.write(Buffer.from(JSON.stringify(msg) + '\n'))
```

The handler at the second usage site (`ipc.on('data', chunk => ...)`) was renamed in lock-step. Mobile re-bundles via `bare-pack --linked` were re-smoke-tested; bundle size and structure unchanged.

### 2.2 — Bundle bare.js for desktop ✅ DONE 2026-04-27

`scripts/desktop-bundle.sh` now also produces `desktop/bare-desktop.bundle` (66MB):
```bash
node_modules/.bin/bare-pack --preset desktop src/bare.js -o desktop/bare-desktop.bundle
```

`--preset desktop` is required (vs `--linked`) because Pear's runtime has no
host-side linked-addon registry — addon prebuilds for darwin/linux/win32 must
be embedded in the bundle. The bundle is gitignored.

### 2.3 — Storage path ✅ DONE 2026-04-27 (renderer-driven init)

The renderer (`desktop/index.html`) sends an init message immediately after
spawning the worker:
```js
send({ method: 'init', dataDir: Pear.config.storage + '/pearcal', platform: 'desktop' })
```
The existing init dispatcher in `src/bare.js` parses this exactly like the
mobile shell's init — no branching needed in bare.js for storage path.

### 2.4 — 🔶 BLOCKER: loading bare-desktop.bundle inside the Pear worker

Two paths were tried; both fail for distinct reasons.

**Path A — `Pear.worker.run('./bare-worker.js')` + `require('./bare-desktop.bundle')`**

```
Uncaught SyntaxError: Unexpected token '', "<binary>" is not valid JSON
  at JSON.parse
  at Module._extensions..json   (line 911 of bare-module/index.js)
  at Module._extensions..js     (line 845 — lookupPackageScope walking up)
  at Module._extensions..bundle (line 964 — entered when require resolves the .bundle)
  at require                    (pear://dev/bare-worker.js)
```

A monkey-patched `JSON.parse` in `bare-worker.js` captured exactly two calls:

1. The bundle's own header JSON (succeeds — `{"version":0,"id":"6e9b66...`, 122806 bytes), called from `Bundle.from` in `node_modules/bare-bundle/index.js:384` via `Module._extensions..bundle:943`
2. **1042 bytes** of binary content, starting `0x14 0x27 0x00 0x21 0x00 0x07 ...`, called from `Module._extensions..json:911` via `..js:845` (lookupPackageScope walking up)

Critically, **the 1042-byte byte sequence does not exist anywhere in `bare-desktop.bundle` on disk** (verified via `Buffer.indexOf` over the whole file). It's not a bundled file, not the bundle header itself, not a binary addon. The shape (lots of embedded `0x00`, small numeric values like `0x14 0x27 0x21 0x07 0x35 0x52`) is consistent with **compact-encoding output** — exactly what Hypercore/Hyperbee blocks look like serialized. So Pear's runtime is feeding the `.json` handler content from its own corestore/Hyperbee state, not from `bundle.read()`.

Tested mitigations that don't help (the binary garbage stays identical):

- Replacing the bundle's `/package.json` with sentinel content → no effect
- Adding a `/src/package.json` stub to short-circuit the walk-up → no effect
- Stripping all of `bundle.resolutions` to force pure URL walk-up → no effect
- Stubs at both `/src/package.json` AND `/package.json` simultaneously → no effect
- Killing the entire Pear sidecar before each retry → no effect
- Confirming Keet was not running (potential cross-app sidecar contamination hypothesis) → ruled out, same garbage with no Keet running and `/home/tim/.config/pear/pear.sock` removed (pkill doesn't clean it up — see `feedback_pear_run_in_background.md`)

A `Buffer.prototype.toString` monkey-patch did NOT fire during the failure, suggesting bare-module's source-handling path uses a different Buffer/Uint8Array implementation than the one inherited by `bare-worker.js`'s prototype, or the `.toString()` is happening in a separate JS isolate. `require('bare-module')` from the worker entry fails with `MODULE_NOT_FOUND`, so there's no way to hook `Module._extensions['.json']` from outside the bundle.

Best next step: file a minimal repro against Holepunch's `bare-pack` + `pear-runtime` so the maintainers can identify whether Pear's drive-bundler is auto-mounting `.bundle` file subpaths into `bundle.sources` (which would explain why `pear://dev/bare-desktop.bundle/<anything>` resolves to corestore-shaped binary instead of the bundle's mounted internal contents).

**Path B — `Pear.worker.run('./bare-desktop.bundle')` directly**

The worker process spawns with the .bundle as its arg — but the bundle's
top-level code never executes. A diagnostic write at the top of `src/bare.js`
(via `bare-fs.writeFileSync` to `/tmp/`) leaves no file. The worker process
exists but appears to enter Pear's `type: "desktop"` branch (which spawns
Electron) instead of `type: "terminal"` (which would `Module.load(bundle.entrypoint)`).

`/state.js:47` decides type as `pkg?.pear?.type || (/\.(c|m)?js$/.test(state.main) ? 'terminal' : 'desktop')`. Since `desktop/package.json` declares `pear: { type: "desktop" }`, the worker inherits desktop type from the parent project.

A `desktop/worker/` subdirectory with its own `package.json` declaring
`pear: { type: "terminal" }` was tried (Path C). The worker did spawn and
hit `run.js:132`'s terminal-mode `Module.load(bundle.entrypoint)`, but then
fell into the same Path A binary-JSON error inside the `.bundle` extension
handler.

### 2.5 — Workaround in place

`desktop/bare-worker.js` is reverted to the Phase 1 stub (canned responses
for `getProfile`, `listEvents`, etc.) so the renderer keeps painting against
non-empty data while Phase 2 unblocks. Phase 2.1–2.3 deliverables are still
wired up — the renderer sends `init`, the IPC abstraction in `src/bare.js`
is correct, the bundle script produces a bundle. Only the bundle-load step
in `bare-worker.js` is replaced with the stub.

### 2.6 — Next investigation

- Verify Pear's `pear://` protocol's `exists()` / `read()` for URLs like
  `pear://dev/bare-desktop.bundle/<subpath>` — confirm whether they return
  the .bundle file's bytes for any subpath. If yes, the workaround is to
  load the bundle through a non-pear protocol (e.g., add `file://` source
  via `bare-fs.readFileSync` and call `Module.load` directly with a custom
  protocol — but `bare-fs` isn't accessible from the worker entry without
  bundling itself, which is the same problem).
- Try `pear-electron`'s newer worker model when Pear runtime updates from
  rc/0.9609 to a release that ships the `pear-bridge` + RTI architecture.
  The `pear-electron` example template uses `Pear.worker.run(import.meta.resolve('./worker/bare.bundle'))` plus a `bare-bundle:` protocol — the URL scheme appears to bypass the issue.
- File a Holepunch bug report with the minimal reproduction (a fresh
  `pear-desktop` template + a `bare-pack --preset desktop` of any module
  with a top-level package.json walk-up).

## Phase 3 — Native module replacements

Per the desktop scope decision, only a subset gets ported. Split into 3.1
(renderer-only intercepts, all done) and 3.2 (Notifications + deep-link
receive, both touch the worker and require more design).

### 3.1 — Renderer-side intercepts ✅ DONE 2026-04-27

Mobile's `app/index.tsx:446-481` intercepts these methods before they reach
bare. On desktop the equivalent lives in `desktop/index.html`'s `__pearDB.call`
switch — no IPC round trip, no worker dependency.

| Mobile method | Desktop implementation |
|---|---|
| `openURL` | `window.open(url, '_blank')` — Pear's renderer routes every scheme through the OS shell (https/mailto/geo/lightning/bitcoin verified manually). |
| `openLightning` | same as `openURL`. |
| `canOpenLightning` | always emits `pear:canOpenLightning` event with `true` (no install detection on desktop). |
| `nativeShare(title, text)` | `navigator.clipboard.writeText(text)` + bottom toast. Linux desktop has no native share sheet; clipboard is the natural fit. |
| `exportIcs(content)` | Blob `<a download>` → `pearcal-events.ics`. Pear's renderer triggers the OS download manager normally. |
| `exportRecoveryPhrase(content)` | Blob `<a download>` → `pearcal-recovery.txt`. |
| `haptic` | no-op. |
| `exitApp` | `Pear.exit()` (falls back to `window.close()` if the call throws). |

#### Resolved open questions
- **`Pear.app.opener` does not exist in installed Pear (v0.9609 rc).** Top-level
  `Pear` exposes only `{argv, checkpoint, config, exit, identity, key, message,
  messages, reload, restart, teardown, updated, updates, versions, wakeups,
  worker}`. `Pear.app`, `Pear.shell`, and the `pear-electron` RTI are all
  undefined. **`window.open(url, '_blank')` is the working substitute** — Pear's
  Electron renderer delegates to the OS shell for every URL scheme tested
  (https, mailto, geo, lightning).
- **Bare modules requiring native addons cannot be `dlopen`'d over `pear://` URLs in dev mode.** A worker entry doing `require('bare-subprocess')` fails with `MODULE_NOT_FOUND` (the resolver only sees `bare:` builtins for top-level imports), and a relative-path require like `require('./node_modules/bare-subprocess/index.js')` resolves the JS but then fails with `UNSUPPORTED_PROTOCOL: Unsupported protocol 'pear:' for addon`. Native addons require a real filesystem path for the dynamic linker. This kills any "shell out from the worker" plan in dev mode and is the same family of issue as the Phase 2.4 bundle-load blocker. Saved as memory `feedback_pear_native_addon_protocol.md`.

### 3.2a — Deep-link receive ✅ DONE 2026-04-27

`desktop/index.html` registers both Pear deep-link paths and routes them
through the existing `window.__pearHandleInvite(url)` (set up by
`src/ui/main.jsx`, with a built-in buffer for invites that arrive pre-mount):

- **Cold launch** — `Pear.config.linkData || Pear.config.link` is read on
  startup. Filtered through `_looksLikeInvite()` so the dev applink
  (`file:///…/desktop`, which is what `Pear.config.link` defaults to in dev)
  doesn't get treated as an invite.
- **Warm receipt** — `Pear.wakeups((wakeup) => …)` is registered. Wakeup
  shape isn't documented, so the handler defensively reads `wakeup.link ||
  wakeup.linkData || wakeup.url`, also accepts a bare string.

Verified in dev that injecting a fake `pearcal://join?…` URL through
`__pearHandleInvite` correctly surfaces App.jsx's Join Group bottom sheet —
i.e. the desktop→UI delivery path is intact.

**Not verifiable in dev:** an actual `pearcal://` URL clicked from Safari /
the OS won't reach Pear in dev mode. The OS scheme registration lives in
the appling's Info.plist and only takes effect after Phase 4 packaging.
Wiring is correct for that future state and a no-op until then.

### 3.2b — Notifications (not started)

| Mobile module | Planned desktop equivalent | Open issues |
|---|---|---|
| `NotificationsModule` | Web Notification API in renderer + `setTimeout` for scheduling | Renderer-only setTimeout loses state when the window closes. Background firing needs `Pear.tray` integration — design call: do we ship "fires only while app is open" as the v1 limitation, or wait for tray plumbing? |

`CameraModule` / `QRScannerModule` remain **skipped per scope** — invite UX
uses QR-render-only, paste, and link click.

### Verify gate
- ✅ Click external link → opens in browser / mail app / wallet.
- ✅ `.ics` export downloads via OS save manager.
- ✅ Share-app / share-invite → text on clipboard.
- ✅ Injected `pearcal://join` → Join Group sheet (3.2a — full E2E pending Phase 4).
- ❌ Reminders fire as desktop notifications. (3.2b)
- ⏸ `pearcal://…` from Safari opens / focuses the running PearCal desktop and triggers join. (Wiring done — needs Phase 4 appling for the OS scheme registration.)

## Phase 4 — Appling packaging + GitHub release pipeline (1–2 days)

End state: `git tag desktop-v1.0.0 && git push --tags` produces a signed-and-notarized `PearCal.dmg` published as a GitHub Release asset.

### 4.1 — Stage to a Pear key
```bash
cd desktop && pear stage pearcal-desktop .
# captures the key in a long-lived channel
pear release pearcal-desktop  # at release time
```

### 4.2 — Appling subproject

`desktop-appling/CMakeLists.txt`:
```cmake
cmake_minimum_required(VERSION 3.31)
find_package(cmake-pear REQUIRED PATHS node_modules/cmake-pear)
project(pearcal_appling C CXX ASM)
add_pear_appling(
  pearcal_appling
  ID pearcal
  NAME PearCal
  VERSION 1.0.0
  AUTHOR "Timothy Hudgins"
  DESCRIPTION "Peer-to-peer calendar."
  MACOS_IDENTIFIER com.pearcal.desktop
  MACOS_CATEGORY public.app-category.productivity
  MACOS_SIGNING_IDENTITY "22F9540D333EBFB4245EE11170F68A61E6E22689"  # Phase 0
  MACOS_SIGNING_KEYCHAIN "$ENV{HOME}/Library/Keychains/buildkey.keychain-db"
)
```

### 4.3 — Build script (`scripts/desktop-appling-build.sh`)
```bash
PEAR_KEY="$(cat desktop/pear-key.txt)"
cd desktop-appling
npm install
npx bare-make generate
npx bare-make build
# Output: build/Release/PearCal.app

xcrun notarytool submit \
  --keychain-profile pearcal-notary \
  --keychain ~/Library/Keychains/buildkey.keychain-db \
  --wait \
  build/Release/PearCal.app
xcrun stapler staple build/Release/PearCal.app

npx create-dmg build/Release/PearCal.app build/
# → build/PearCal 1.0.0.dmg
```

### 4.4 — GitHub Actions

New workflow `.github/workflows/desktop-release.yml`:
- Trigger: `push: tags: ['desktop-v*']`
- Runs on self-hosted Mac Mini (signing requires keychain access).
- Secrets needed: `MACOS_NOTARY_API_KEY` (base64'd `.p8`), `MACOS_NOTARY_KEY_ID`, `MACOS_NOTARY_ISSUER_ID`.

### 4.5 — Verify gate
- Tag push produces a `.dmg` on GitHub Releases.
- A Mac with no Pear installed can: download → drag to Applications → double-click → calendar UI renders, no Gatekeeper "developer cannot be verified" prompt.
- `pearcal://` URL from Safari opens the installed app.

## Phase 5 — Hardening + parity QA (2–3 days)

- Run full feature surface on a clean `.dmg`: events, recurrence, reminders, RSVPs, group create/join/leave, profile, mnemonic restore, multi-peer sync (desktop ↔ iPhone, ↔ Pixel, ↔ desktop).
- DECISIONS.md entry per `CONSTITUTION.md` (T2 change: new build pipeline + new distribution channel).
- README addendum: "Desktop" section linking to latest release `.dmg`.
- TODO.md: close #55 against this plan; re-scope #10 (Win/Linux: Phases 1–3 reusable; only Phase 4 needs `WINDOWS_*` / `LINUX_*` add-ons in the appling).

## Risks (revised)

| Risk | Status |
|---|---|
| BareKit can't run in Pear renderer | Resolved — bare worker via `Pear.worker.run()` works |
| Top-level await in external modules crashes renderer | Resolved — keep all renderer code inline in `index.html` |
| `pear-electron`'s RTI is missing in installed Pear | Resolved — we don't use pear-electron at all |
| `bare-pack` output format doesn't load via `Pear.worker.run()` | Open — verify in Phase 2 |
| `Pear.app.opener` missing in spike probe | Open — confirm in Phase 3 or find alternative |
| Notarization fails on first attempt due to entitlements | Likely — iterate on entitlements list during Phase 4 |
