# PearCal iOS Port — Design Spec

**Date:** 2026-03-16
**Status:** Approved

## Overview

Port PearCal to iOS, targeting the App Store. The app shares a single codebase with the existing Android app. Development and testing are done on Linux using `xtool` + a USB-connected iPhone. Final App Store archive builds are done on a Mac with Xcode.

## Goals

- Full feature parity with the Android app
- Minimal changes to existing shared code (`app/index.tsx`, `src/ui/`, `src/bare.js`)
- Build/install workflow on Linux mirrors the existing Android ADB workflow
- Background sync via iOS Background App Refresh (best-effort, not real-time)

## Out of Scope

- Run-on-boot (no iOS equivalent; not needed — `UNUserNotificationCenter` persists scheduled notifications across restarts)
- Real-time background sync (iOS does not allow persistent foreground services)
- The "Syncing your calendar…" persistent notification (Android-only, not needed on iOS)

## Project Structure

`npx expo prebuild --platform ios` generates the `ios/` directory. It is committed to git. Custom Swift files live alongside Expo-generated files in `ios/PearCal/`:

```
ios/
  PearCal.xcodeproj/
  PearCal/
    AppDelegate.swift          # generated; modified to register BGTask + handle notification taps
    Info.plist                 # generated; modified for URL scheme, background modes, usage strings
    NotificationsModule.swift
    CameraModule.swift
    QRScannerModule.swift
    ShareModule.swift
    HapticModule.swift
    DeepLinkModule.swift
    LinkModule.swift
    BareBackgroundSync.swift
```

`android/` is untouched. Both platforms coexist in the same repo.

## Native Modules (Swift)

Each Kotlin module is replaced by a Swift equivalent that exposes the same `NativeModules.PearCalXxx` name, so `app/index.tsx` requires no changes for these modules.

| Module | iOS Framework | Notes |
|---|---|---|
| `NotificationsModule` | `UserNotifications` | `UNUserNotificationCenter` for schedule/cancel/postNow. Requests permission on first `schedule()` call. |
| `CameraModule` | `PHPickerViewController` / `UIImagePickerController` | Camera capture + gallery picker |
| `QRScannerModule` | `AVFoundation` + `Vision` | QR code scanning |
| `ShareModule` | `UIActivityViewController` | Native share sheet |
| `HapticModule` | `UIImpactFeedbackGenerator` / `UINotificationFeedbackGenerator` | Maps `light`/`medium`/`heavy` to impact styles |
| `DeepLinkModule` | `UIApplication.open()` | `openURL`, `canOpenLightning` (checks `lightning:` scheme), `openLightning` |
| `LinkModule` | `AppDelegate` URL handler | Queues `pear://` deep links received via URL scheme; `getPendingLink()` / `getPendingTab()` polled from JS |

**Notification tap → tab navigation:** `AppDelegate` implements `UNUserNotificationCenterDelegate`. On tap, it extracts the `tab` from the notification payload and writes it to `LinkModule`'s pending tab queue. `app/index.tsx` polls `getPendingTab()` every 500ms as it already does on Android.

**No `BootReceiver`:** Not needed. `UNUserNotificationCenter` persists scheduled notifications across device restarts automatically.

## Background Sync (BGTaskScheduler)

iOS Background App Refresh provides ~30 seconds of background CPU time, scheduled opportunistically by the OS (typically every few hours when charging and on Wi-Fi).

**Setup:**
- `Info.plist`: declares `BGTaskSchedulerPermittedIdentifiers` = `["com.pearcal.bgsync"]` and `UIBackgroundModes` = `["fetch"]`
- `AppDelegate`: registers the task handler at launch with `BGTaskScheduler.shared.register(...)`

**Handler flow:**
1. OS wakes the app in background and fires the handler
2. If the Bare worklet is not running, start it and wait for the `ready` event
3. Send `{ method: 'sync' }` to the worklet
4. On sync completion (or timeout), call `task.setTaskCompleted(success:)` and reschedule via `BGAppRefreshTask`
5. `task.expirationHandler` cleans up gracefully if iOS cancels mid-run

**User expectation:** Background sync is best-effort. Sync is reliable when the app is foregrounded; background sync is opportunistic.

## Changes to Shared Code

### `app/index.tsx`

| Location | Change |
|---|---|
| `PermissionsAndroid` block (line ~256) | Wrap in `if (Platform.OS === 'android')` — iOS permission requested in Swift on first schedule call |
| `exitApp` handler (line ~198) | Wrap in `if (Platform.OS === 'android')` — no-op on iOS |
| `BackHandler` subscription (line ~400) | Wrap in `if (Platform.OS === 'android')` — no hardware back button on iOS |
| Loading screen icon (line ~445) | Reference a shared `assets/icon.png` instead of the Android-specific path |

### `app.json`

Add an `ios` block:

```json
"ios": {
  "bundleIdentifier": "com.pearcal.app",
  "infoPlist": {
    "NSCameraUsageDescription": "Used to set your profile photo",
    "NSPhotoLibraryUsageDescription": "Used to set your profile photo",
    "BGTaskSchedulerPermittedIdentifiers": ["com.pearcal.bgsync"],
    "UIBackgroundModes": ["fetch"]
  },
  "scheme": "pear"
}
```

The `pear://` URL scheme is declared here; Expo writes it into `Info.plist` during prebuild.

## Build Workflow (Linux with xtool)

### UI-only changes

```bash
npx esbuild src/ui/main.jsx --bundle --format=iife --jsx=automatic \
  --define:process.env.NODE_ENV=\"production\" --outfile=assets/app-ui.bundle
xtool build -scheme PearCal -configuration Debug
ios-deploy --bundle ios/build/Debug-iphoneos/PearCal.app --id <device-udid>
```

### bare.js changes (rebuild UI after)

```bash
node_modules/.bin/bare-pack --linked src/bare.js -o assets/bare-universal.bundle
npx esbuild src/ui/main.jsx --bundle --format=iife --jsx=automatic \
  --define:process.env.NODE_ENV=\"production\" --outfile=assets/app-ui.bundle
xtool build -scheme PearCal -configuration Debug
ios-deploy --bundle ios/build/Debug-iphoneos/PearCal.app --id <device-udid>
```

### Release (on Mac)

Archive and export via Xcode for App Store Connect upload.

## Key Risks

- **`react-native-bare-kit` iOS support** — assumed functional on iOS; verify during initial prebuild and first worklet start
- **BGTask 30s window** — Hyperswarm peer discovery may not complete in time if no peers are immediately reachable; sync should be treated as best-effort
- **xtool compatibility** — build workflow assumes xtool can compile the Expo-generated Xcode project; verify after prebuild
