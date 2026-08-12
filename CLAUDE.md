# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

PearCal is a peer-to-peer calendar app for Android and iOS built with Expo (React Native). It uses a dual-runtime architecture: a React Native shell hosts a WebView that renders the UI, while a separate [Bare](https://github.com/nicolo-ribaudo/bare) runtime runs the P2P backend.

## Build & Deploy

### Android

Two test devices are connected via ADB:
- Device 1: `53071FDAP00038` - Pixel/GrapheneOS (owner). Wifi only, and its IP and
  port change on every reconnect. Resolve it with
  `/home/tim/peerloomllc/adb-find.sh pixel`, which discovers the current address
  over mDNS and prints it. Never hardcode the address.
- Device 2: `4H65K7MFZXSCSWPR` - TCL (joiner). USB, so the serial is stable.

Always use `adb install -r` - **never uninstall** (preserves user data).

**UI-only changes** (`src/ui/App.jsx`, `src/ui/main.jsx`):
```bash
npx esbuild src/ui/main.jsx --bundle --format=iife --jsx=automatic \
  --define:process.env.NODE_ENV=\"production\" --outfile=assets/app-ui.bundle
cd android && ./gradlew assembleDebug && cd ..
adb -s "$(/home/tim/peerloomllc/adb-find.sh pixel)" install -r android/app/build/outputs/apk/debug/app-debug.apk
adb -s 4H65K7MFZXSCSWPR install -r android/app/build/outputs/apk/debug/app-debug.apk
```

**bare.js changes** (also rebuild UI after):
```bash
node_modules/.bin/bare-pack --linked --defer fs --defer path src/bare.js -o assets/bare-universal.bundle
npx esbuild src/ui/main.jsx --bundle --format=iife --jsx=automatic \
  --define:process.env.NODE_ENV=\"production\" --outfile=assets/app-ui.bundle
cd android && ./gradlew assembleDebug && cd ..
adb -s "$(/home/tim/peerloomllc/adb-find.sh pixel)" install -r android/app/build/outputs/apk/debug/app-debug.apk
adb -s 4H65K7MFZXSCSWPR install -r android/app/build/outputs/apk/debug/app-debug.apk
```

**Release APK:**
```bash
cd android && ./gradlew assembleRelease && cd ..
/home/tim/Android/Sdk/build-tools/36.1.0/apksigner verify --verbose android/app/build/outputs/apk/release/app-release.apk
cp android/app/build/outputs/apk/release/app-release.apk ~/pearcal-release.apk
```
Keystore: `~/keystore.jks` - alias: `pearcal`

### iOS

iOS builds run on Mac Mini (`Tims-Mac-mini.local`) via SSH. Write code on Linux, sync to Mac, build remotely, package as `.ipa`, copy back, install via `ideviceinstaller` (iPhone connected to Linux via USB).

iPhone UDID: `00008030-0009714C2613402E`

**Signing keychain:** `~/Library/Keychains/buildkey.keychain` (no password). Must be unlocked once per Mac restart:
```bash
ssh Tims-Mac-mini.local 'security unlock-keychain -p "" ~/Library/Keychains/buildkey.keychain'
```

**Note on configuration:** Use `-configuration Release` for device installs - Debug builds try to connect to a Metro bundler at localhost:8081, which fails on physical devices without a running dev server. Release builds embed the JS bundle.

**Signing note:** `DEVELOPMENT_TEAM=G79ALD29NA` uses the wildcard provisioning profile already cached on the Mac. `-allowProvisioningUpdates` does NOT work over SSH (no Apple account in the SSH session).

**All three flows are now one script.** It rebuilds the bundles, syncs, builds on
the Mac, packages the `.ipa`, copies it back and installs over USB:

```
./scripts/ios-dev-install.sh --version 1.0.72
```

Add `--pods` after ANY `package.json` change (see the addon-drift note below), and
`--no-install` to stop at a built `.ipa` in `/tmp`. `--version` sets the marketing
version; give a distinct one whenever asking Tim to retest, since a build
reporting the same version as the unfixed one has wasted on-device rounds before.

**Syncing to the Mac is `./scripts/mac-sync.sh`, and nothing else.** Excludes live
in `scripts/mac-sync-excludes.txt`, shared by that script, `screenshots.sh`,
`release.sh` and `electron/scripts/build-mac.sh`. Do not hand-write an rsync to
the Mac: four call sites each kept their own exclude list, the repo grew
`electron/dist`, `seeder-launcher/dist` and 4.4 GB of loose installers that none
of them knew about, and every sync then walked 18 GB to deliver 18 MB with
`--checksum` hashing all of it on both ends. It did not error, it just stopped
finishing (TODO #168). A pre-flight now refuses to start a sync over 250 MB and
names the directory that grew; `test/macSyncExcludes.test.js` fails if any
directory in the repo passes 100 MB unexcluded.

`--checksum` stays on. rsync's default size+mtime check once skipped a rebuilt
bundle and shipped a stale IPA; it is only affordable because the exclude list
keeps the candidate set at ~34 MB.

**`set -o pipefail` is load-bearing** inside the remote build and the script keeps
it: without it the chained `tail` swallows xcodebuild's non-zero exit code, and
the next step happily repackages a stale `PearCal.app` out of DerivedData,
silently shipping an old build.

**iOS bundle caching:** Expo's asset cache survives install-over-top. If iOS behaves differently than expected after a deploy, do a full uninstall first: `ideviceinstaller uninstall com.pearcal` (this wipes app data). Keeping `bare-ios-sim.bundle` in sync with `bare-ios.bundle` and using `--checksum` are both handled by `ios-dev-install.sh` and `mac-sync.sh`.

**Bare native-addon version drift (iOS boot crash `ADDON_NOT_FOUND`):** the bare bundle is `bare-pack`ed on Linux (uses Linux `node_modules`), but iOS links its native addons (`bare-os`, `bare-fs`, …) as xcframeworks generated by `pod install` on the Mac (from the Mac's `node_modules`). `rsync` syncs source only, not `node_modules`, so the two machines drift. If they diverge, the bundle demands e.g. `bare-os.3.9.3.framework` while the app ships `3.6.2` → `ADDON_NOT_FOUND` → unhandled rejection → `Bare.exit` → immediate crash on every launch (even a fresh install; dies before `Init DB`). **After ANY dependency change (`package.json`), the next iOS build MUST run `npm install` + `pod install` on the Mac first** - which is what `./scripts/ios-dev-install.sh --pods` does; the plain invocation skips both. Order matters: rsync FIRST, then `pod install` (rsync clobbers the Mac's fresh `Podfile.lock` otherwise → `Check Pods Manifest.lock` fails, exit 65). Debug via the iOS Simulator on the Mac (`xcrun simctl … log stream --predicate 'process=="PearCal"'`) - Release console output is visible there, unlike on a physical device.

**Note:** New Swift/`.m` files must be registered in `PearCal.xcodeproj/project.pbxproj` via the `xcodeproj` Ruby gem before building. See plan tasks for the helper script.

**Release (App Store):** Archive and export from Xcode on the Mac Mini. Increment `buildNumber` in `app.json` before each upload.

## Branch Strategy

Always create a branch before starting work - never commit directly to master.
- Feature branches: `feature/description`
- Bug fix branches: `bugfix/description`
- Open a PR with `gh pr create`, then stop. Tim reviews and merges (see root `CLAUDE.md`).
- After Tim merges: `git checkout master && git pull github master`

## To-Do List

Open items tracked in `TODO.md`; completed items in `DONE.md` (both at repo root, unversioned, gitignored). When adding items, categorize by type, priority, and complexity.

### Completing a TODO item - required workflow:
1. List verification tests/steps and prompt the user for confirmation/results.
2. If verification passes and no additional work is needed, proceed to commits.
3. After commits, remove the item from `TODO.md` and add it to the top of the relevant date section in `DONE.md` as `- [x] Description - completed YYYY-MM-DD`, then show the remaining open TODO items.

## Patching Rules

- Use `cat > /tmp/patchN.js << 'EOF' ... EOF` + `node /tmp/patchN.js` for in-place file edits
- For patches containing backticks or JSX template expressions, use Python with triple-quoted strings (`python3 /tmp/patch.py`)
- Always verify patch output shows "Patched" / exit 0 before building
- Use `python3 -c "print(repr(open('file').read()[idx:idx+200]))"` to find exact byte strings when patches fail

## Architecture

### Three-Layer Runtime

```
┌─────────────────────────────────────┐
│  React Native (Expo) Shell          │  app/index.tsx
│  - Loads bundles from assets/       │
│  - Owns native module bridge        │
│  - Manages worklet lifecycle        │
├─────────────────────────────────────┤
│  WebView (React UI)                 │  src/ui/App.jsx + src/ui/main.jsx
│  - Full calendar UI in a WebView    │
│  - Communicates via postMessage     │
├─────────────────────────────────────┤
│  Bare Worklet (P2P Backend)         │  src/bare.js
│  - Hypercore / Hyperbee local DB    │
│  - Autobase per shared group        │
│  - Hyperswarm peer discovery        │
└─────────────────────────────────────┘
```

### IPC Message Flow

All cross-layer calls are JSON-over-newline, dispatched by `method` name:

- **WebView → RN**: `window.ReactNativeWebView.postMessage(JSON.stringify({ id, method, args }))`
- **RN → Bare worklet**: `_worklet.IPC.write(b4a.from(JSON.stringify(msg) + '\n'))`
- **Bare → RN**: `BareKit.IPC.write(Buffer.from(JSON.stringify(msg) + '\n'))`
- **RN → WebView**: `webViewRef.current.injectJavaScript('window.__pearResponse(...); true;')`
- **RN → WebView (events)**: `webViewRef.current.injectJavaScript('window.__pearEvent("name", data); true;')`

Most method calls (`getProfile`, `putEvent`, `joinGroup`, etc.) route transparently through RN to the Bare worklet. A handful are handled directly in RN: notification scheduling (`scheduleForEvent`, `cancelForEvent`), haptic feedback, QR scanning, camera, and deep links.

### Key Source Files

| File | Role |
|------|------|
| `app/index.tsx` | RN shell: loads bundles, starts worklet, owns all IPC routing |
| `app/join.tsx` | Handles `pearcal://` deep link invite URLs |
| `src/bare.js` | Bare worklet: DB, Autobase groups, Hyperswarm, all data logic |
| `src/ui/main.jsx` | WebView bootstrap: sets up `window.__pearDB`, `window.__pearSync`, renders `<App>` |
| `src/ui/App.jsx` | Full React calendar UI (runs entirely inside the WebView) |
| `src/invite.js` | Invite link builder/parser - shared between UI and bare contexts |
| `src/ui/bundle.js` | Bundled output stub (not edited directly) |

### Data Storage (Bare worklet)

- **Local DB**: `Hypercore` + `Hyperbee` at `{documentDirectory}/pearcal/core`
  - Keys: `profile`, `events:{date}:{id}`, `groups:{id}`, `members:{groupId}:{memberId}`
  - Tombstones: `deleted:{eventId}` (prevent sync resurrection of user-deleted events)
- **Group sync**: `Corestore` at `{documentDirectory}/pearcal/store` + one `Autobase` per group
  - Autobase view is also a `Hyperbee`; conflict resolution is last-write-wins by `updatedAt`
  - Group membership and events are mirrored from Autobase view back to local DB via `mirrorToLocal()`
- **Peer discovery**: `Hyperswarm`, one topic per group (derived from `groupKey`)

### Native Modules (Android - `android/app/src/main/java/com/pearcal/`, iOS - `ios/PearCal/`)

| Module | Purpose |
|--------|---------|
| `NotificationsModule` | Schedule/cancel exact alarms via `AlarmManager` |
| `CameraModule` | Camera capture + gallery picker |
| `QRScannerModule` | QR code scanning |
| `ShareModule` | Native share sheet |
| `HapticModule` | Haptic feedback |
| `DeepLinkModule` | `openURL`, Lightning invoice intent |
| `LinkModule` | Receive and queue pending `pear://` deep links |

### Invite Link Protocol

Format: `pear://pearcal/join?group={base64(groupId)}&name={name}&key={groupKey}&inviter={publicKey}`

Android intercepts these via an intent filter (scheme `pearcal`). The native `LinkModule` queues them; `app/index.tsx` polls every 2 seconds and injects them into the WebView via `window.__pearHandleInvite()`.

### Group Sync Protocol

When a peer connects over Hyperswarm, the `pearcal/writer-announce` Protomux channel exchanges `{ groupId, writerKey, memberId }`. The group owner calls `base.append({ addWriter: writerKey })` to grant write access. Removed members are tracked in `removedMembers[]` and a `blockedWriter:` key; blocked writers receive a `{ blocked: true }` message and are removed locally.

## TypeScript / Path Aliases

`@/*` maps to the repo root. The `app/` directory uses TypeScript (`.tsx`). `src/` uses plain JavaScript (`.js`, `.jsx`).
