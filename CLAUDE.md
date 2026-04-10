# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

PearCal is a peer-to-peer calendar app for Android and iOS built with Expo (React Native). It uses a dual-runtime architecture: a React Native shell hosts a WebView that renders the UI, while a separate [Bare](https://github.com/nicolo-ribaudo/bare) runtime runs the P2P backend.

## Build & Deploy

### Android

Two test devices are connected via ADB:
- Device 1: `53071FDAP00038` — Pixel/GrapheneOS (owner)
- Device 2: `4H65K7MFZXSCSWPR` — TCL (joiner)

Always use `adb install -r` — **never uninstall** (preserves user data).

**UI-only changes** (`src/ui/App.jsx`, `src/ui/main.jsx`):
```bash
npx esbuild src/ui/main.jsx --bundle --format=iife --jsx=automatic \
  --define:process.env.NODE_ENV=\"production\" --outfile=assets/app-ui.bundle
cd android && ./gradlew assembleDebug && cd ..
adb -s 53071FDAP00038 install -r android/app/build/outputs/apk/debug/app-debug.apk
adb -s 4H65K7MFZXSCSWPR install -r android/app/build/outputs/apk/debug/app-debug.apk
```

**bare.js changes** (also rebuild UI after):
```bash
node_modules/.bin/bare-pack --linked src/bare.js -o assets/bare-universal.bundle
npx esbuild src/ui/main.jsx --bundle --format=iife --jsx=automatic \
  --define:process.env.NODE_ENV=\"production\" --outfile=assets/app-ui.bundle
cd android && ./gradlew assembleDebug && cd ..
adb -s 53071FDAP00038 install -r android/app/build/outputs/apk/debug/app-debug.apk
adb -s 4H65K7MFZXSCSWPR install -r android/app/build/outputs/apk/debug/app-debug.apk
```

**Release APK:**
```bash
cd android && ./gradlew assembleRelease && cd ..
/home/tim/Android/Sdk/build-tools/36.1.0/apksigner verify --verbose android/app/build/outputs/apk/release/app-release.apk
cp android/app/build/outputs/apk/release/app-release.apk ~/pearcal-release.apk
```
Keystore: `~/keystore.jks` — alias: `pearcal`

### iOS

iOS builds run on Mac Mini (`Tims-Mac-mini.local`) via SSH. Write code on Linux, sync to Mac, build remotely, package as `.ipa`, copy back, install via `ideviceinstaller` (iPhone connected to Linux via USB).

iPhone UDID: `00008030-0009714C2613402E`

**Signing keychain:** `~/Library/Keychains/buildkey.keychain` (no password). Must be unlocked once per Mac restart:
```bash
ssh Tims-Mac-mini.local 'security unlock-keychain -p "" ~/Library/Keychains/buildkey.keychain'
```

**Note on configuration:** Use `-configuration Release` for device installs — Debug builds try to connect to a Metro bundler at localhost:8081, which fails on physical devices without a running dev server. Release builds embed the JS bundle.

**Signing note:** `DEVELOPMENT_TEAM=G79ALD29NA` uses the wildcard provisioning profile already cached on the Mac. `-allowProvisioningUpdates` does NOT work over SSH (no Apple account in the SSH session).

**UI-only changes** (no Swift/native changes):
```bash
# 1. Bundle UI
npx esbuild src/ui/main.jsx --bundle --format=iife --jsx=automatic \
  --define:process.env.NODE_ENV=\"production\" --outfile=assets/app-ui.bundle
# 2. Sync, build, package, install
rsync -az --checksum --exclude='.git' --exclude='node_modules' --exclude='android' \
  /home/tim/peerloomllc/pearcal-native/ \
  Tims-Mac-mini.local:~/peerloomllc/pearcal-native/
ssh Tims-Mac-mini.local 'export PATH="/opt/homebrew/bin:$PATH" && export LANG=en_US.UTF-8 && \
  security unlock-keychain -p "" ~/Library/Keychains/buildkey.keychain && \
  cd ~/peerloomllc/pearcal-native && \
  xcodebuild -workspace ios/PearCal.xcworkspace -scheme PearCal -configuration Release \
    -destination "generic/platform=iOS" DEVELOPMENT_TEAM=G79ALD29NA \
    OTHER_CODE_SIGN_FLAGS="--keychain ~/Library/Keychains/buildkey.keychain" 2>&1 | tail -3 && \
  rm -rf /tmp/Payload && mkdir -p /tmp/Payload && \
  cp -r "$(ls -d ~/Library/Developer/Xcode/DerivedData/PearCal-*/Build/Products/Release-iphoneos/PearCal.app | head -1)" /tmp/Payload/ && \
  cd /tmp && ditto -c -k --sequesterRsrc --keepParent Payload PearCal-release.ipa && rm -rf Payload && echo "IPA ready"'
rsync -az Tims-Mac-mini.local:/tmp/PearCal-release.ipa /tmp/
ideviceinstaller install /tmp/PearCal-release.ipa
```

**bare.js changes** (rebuild both bundles, then build iOS):
```bash
node_modules/.bin/bare-pack --linked src/bare.js -o assets/bare-universal.bundle
node_modules/.bin/bare-pack --host ios-arm64 --linked src/bare.js -o assets/bare-ios.bundle
cp assets/bare-ios.bundle assets/bare-ios-sim.bundle
npx esbuild src/ui/main.jsx --bundle --format=iife --jsx=automatic \
  --define:process.env.NODE_ENV=\"production\" --outfile=assets/app-ui.bundle
# Then sync + build as above
```

**Swift/native module changes** (also runs `pod install` first):
```bash
rsync -az --checksum --exclude='.git' --exclude='node_modules' --exclude='android' \
  /home/tim/peerloomllc/pearcal-native/ \
  Tims-Mac-mini.local:~/peerloomllc/pearcal-native/
ssh Tims-Mac-mini.local 'export PATH="/opt/homebrew/bin:$PATH" && export LANG=en_US.UTF-8 && \
  security unlock-keychain -p "" ~/Library/Keychains/buildkey.keychain && \
  cd ~/peerloomllc/pearcal-native/ios && pod install && \
  cd .. && xcodebuild -workspace ios/PearCal.xcworkspace -scheme PearCal -configuration Release \
    -destination "generic/platform=iOS" DEVELOPMENT_TEAM=G79ALD29NA \
    OTHER_CODE_SIGN_FLAGS="--keychain ~/Library/Keychains/buildkey.keychain" 2>&1 | tail -3 && \
  rm -rf /tmp/Payload && mkdir -p /tmp/Payload && \
  cp -r "$(ls -d ~/Library/Developer/Xcode/DerivedData/PearCal-*/Build/Products/Release-iphoneos/PearCal.app | head -1)" /tmp/Payload/ && \
  cd /tmp && ditto -c -k --sequesterRsrc --keepParent Payload PearCal-release.ipa && rm -rf Payload && echo "IPA ready"'
rsync -az Tims-Mac-mini.local:/tmp/PearCal-release.ipa /tmp/
ideviceinstaller install /tmp/PearCal-release.ipa
```

**iOS bundle caching:** Expo's asset cache survives install-over-top. If iOS behaves differently than expected after a deploy, do a full uninstall first: `ideviceinstaller uninstall com.pearcal` (this wipes app data). Also always keep `bare-ios-sim.bundle` in sync with `bare-ios.bundle` and use `--checksum` with rsync.

**Note:** New Swift/`.m` files must be registered in `PearCal.xcodeproj/project.pbxproj` via the `xcodeproj` Ruby gem before building. See plan tasks for the helper script.

**Release (App Store):** Archive and export from Xcode on the Mac Mini. Increment `buildNumber` in `app.json` before each upload.

## Branch Strategy

Always create a branch before starting work — never commit directly to master.
- Feature branches: `feature/description`
- Bug fix branches: `bugfix/description`
- Merge via GitHub PR: `gh pr merge N --merge`
- After merge: `git checkout master && git pull github master`

## To-Do List

Open items tracked in `TODO.md`; completed items in `DONE.md` (both at repo root, unversioned, gitignored). When adding items, categorize by type, priority, and complexity.

### Completing a TODO item — required workflow:
1. List verification tests/steps and prompt the user for confirmation/results.
2. If verification passes and no additional work is needed, proceed to commits.
3. After commits, remove the item from `TODO.md` and add it to the top of the relevant date section in `DONE.md` as `- [x] Description — completed YYYY-MM-DD`, then show the remaining open TODO items.

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
| `src/invite.js` | Invite link builder/parser — shared between UI and bare contexts |
| `src/ui/bundle.js` | Bundled output stub (not edited directly) |

### Data Storage (Bare worklet)

- **Local DB**: `Hypercore` + `Hyperbee` at `{documentDirectory}/pearcal/core`
  - Keys: `profile`, `events:{date}:{id}`, `groups:{id}`, `members:{groupId}:{memberId}`
  - Tombstones: `deleted:{eventId}` (prevent sync resurrection of user-deleted events)
- **Group sync**: `Corestore` at `{documentDirectory}/pearcal/store` + one `Autobase` per group
  - Autobase view is also a `Hyperbee`; conflict resolution is last-write-wins by `updatedAt`
  - Group membership and events are mirrored from Autobase view back to local DB via `mirrorToLocal()`
- **Peer discovery**: `Hyperswarm`, one topic per group (derived from `groupKey`)

### Native Modules (Android — `android/app/src/main/java/com/pearcal/`, iOS — `ios/PearCal/`)

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
