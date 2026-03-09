# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

PearCal is a peer-to-peer calendar app for Android built with Expo (React Native). It uses a dual-runtime architecture: a React Native shell hosts a WebView that renders the UI, while a separate [Bare](https://github.com/nicolo-ribaudo/bare) runtime runs the P2P backend.

## Commands

```bash
# Start Expo dev server
npm start

# Build and run on Android device/emulator
npm run android

# Build the WebView UI bundle (src/ui/ → assets/app-ui.bundle)
npm run bundle:ui

# Build the Bare backend bundle (src/bare.js → assets/bare-universal.bundle)
npm run bundle:bare
```

**Important:** After editing any file under `src/`, you must rebuild the relevant bundle before the changes take effect. `src/ui/` → `bundle:ui`, `src/bare.js` or other `src/*.js` → `bundle:bare`.

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

### Native Modules (Android — `android/app/src/main/java/com/pearcal/`)

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
