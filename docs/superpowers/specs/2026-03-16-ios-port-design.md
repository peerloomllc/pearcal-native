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
    AppDelegate.swift          # generated; modified to register BGTask + handle notification taps + URL scheme
    Info.plist                 # generated; modified for background modes, usage strings, BGTask identifier
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

**New Architecture compatibility:** `app.json` has `newArchEnabled: true`. All Swift modules are implemented as legacy bridge modules using `RCT_EXPORT_MODULE` + `RCT_EXPORT_METHOD`, relying on the New Architecture interop layer. This avoids TurboModule codegen while remaining callable via `NativeModules`.

| Module | iOS Framework | Methods | Notes |
|---|---|---|---|
| `NotificationsModule` | `UserNotifications` | `schedule`, `cancel`, `postNow`, `getPermission` | `UNUserNotificationCenter`. Requests auth permission on first `schedule()` call. `getPermission` returns current auth status. Note: `restoreAll` is dispatched by `app/index.tsx` to `handleNotification()` in JS and is never forwarded to the native module — no native `restoreAll` method exists or is needed on either platform. |
| `CameraModule` | `UIImagePickerController` (camera), `PHPickerViewController` (gallery) | `capture` | `UIImagePickerController` with `sourceType = .camera` for live capture; `PHPickerViewController` for gallery picker. Returns base64 image string. |
| `QRScannerModule` | `AVFoundation` + `Vision` | `scan` | Camera-based QR scanning. Requires `NSCameraUsageDescription`. |
| `ShareModule` | `UIActivityViewController` | `share` | Native share sheet. |
| `HapticModule` | `UIImpactFeedbackGenerator` / `UINotificationFeedbackGenerator` | `impact` | Maps `light`/`medium`/`heavy` to impact styles. |
| `DeepLinkModule` | `UIApplication.open()` | `openURL`, `canOpenLightning`, `openLightning` | `canOpenLightning` checks `lightning:` scheme via `canOpenURL` — requires `LSApplicationQueriesSchemes: ["lightning"]` in `Info.plist`. |
| `LinkModule` | `AppDelegate` URL handler | `getPendingLink`, `getPendingTab` | Queues `pear://` deep links received via URL scheme; polled every 2s from JS. `getPendingTab` queued by notification tap handler (see below). |

**Notification tap → tab navigation:** `AppDelegate` implements `UNUserNotificationCenterDelegate`. On tap, it extracts the `tab` value from the notification payload and writes it to `LinkModule`'s pending tab queue. `app/index.tsx` polls `getPendingTab()` every 500ms as it already does on Android.

**No `BootReceiver`:** Not needed. `UNUserNotificationCenter` persists scheduled notifications across device restarts automatically.

## Background Sync (BGTaskScheduler)

iOS Background App Refresh provides ~30 seconds of background CPU time, scheduled opportunistically by the OS (typically every few hours when charging and on Wi-Fi).

**Setup:**
- `Info.plist`: `BGTaskSchedulerPermittedIdentifiers` = `["com.pearcal.bgsync"]` and `UIBackgroundModes` = `["fetch"]`. These keys are set directly in `Info.plist` after prebuild (or via an Expo config plugin), **not** via `app.json` `infoPlist` — Expo does not reliably propagate these through the managed config.
- `AppDelegate`: registers the task handler at launch with `BGTaskScheduler.shared.register(forTaskWithIdentifier: "com.pearcal.bgsync", ...)`

**Handler flow:**
1. OS wakes the full app process in background and fires the handler (React Native is initialized but the WebView is not rendered)
2. `BareBackgroundSync` accesses the shared `Worklet` instance via a module-level singleton (e.g. `WorkletHolder.shared`) that `app/index.tsx` populates when it starts the worklet
3. If the worklet is not running, start it and wait for the `ready` event (with a timeout)
4. Send `{ method: 'sync' }` to the worklet
5. On sync completion (or timeout), call `task.setTaskCompleted(success:)` and reschedule for the next cycle
6. `task.expirationHandler` stops the worklet cleanly if iOS cancels mid-run

**Worklet singleton:** A small `WorkletHolder.swift` exposes a shared instance holding the `Worklet` reference. `app/index.tsx` sets it via a native module call after starting the worklet. `BareBackgroundSync` reads from it.

**User expectation:** Background sync is best-effort. Sync is reliable when the app is foregrounded; background sync is opportunistic.

## Changes to Shared Code

### `app/index.tsx`

**All changes in this table must be applied before the first iOS build:**

| Location | Change |
|---|---|
| `PermissionsAndroid` block (line ~256) | **Prerequisite:** Wrap in `if (Platform.OS === 'android')` — iOS permission requested in Swift on first `schedule()` call |
| `exitApp` handler (line ~198) | **Prerequisite:** Wrap in `if (Platform.OS === 'android')` — `BackHandler.exitApp()` has no iOS equivalent and must not be called unconditionally |
| `BackHandler` subscription (line ~400) | **Prerequisite:** Wrap in `if (Platform.OS === 'android')` — no hardware back button on iOS |
| Loading screen icon (line ~445) | **Prerequisite:** Change `require('../android/app/src/main/ic_launcher-playstore.png')` to `require('../assets/images/icon.png')` — the Android-specific path will fail to compile on iOS |
| After worklet start | Call `WorkletHolder` native module to register the worklet instance for BGTask access |

### `app.json`

**The `ios` block below does not yet exist in `app.json` and must be added before running `npx expo prebuild --platform ios`.**

Add an `ios` block:

```json
"ios": {
  "bundleIdentifier": "com.pearcal",
  "buildNumber": "1",
  "infoPlist": {
    "NSCameraUsageDescription": "Used to set your profile photo",
    "NSPhotoLibraryUsageDescription": "Used to set your profile photo",
    "NSMicrophoneUsageDescription": "Required by AVCaptureSession for QR scanning and camera capture",
    "LSApplicationQueriesSchemes": ["lightning"]
  }
}
```

**Note:** `BGTaskSchedulerPermittedIdentifiers` and `UIBackgroundModes` are set directly in `Info.plist` after prebuild rather than via `infoPlist` here, due to unreliable Expo propagation of these keys.

The `pear://` URL scheme (`"scheme": "pearcal"`) is already declared at the top level of `app.json` and Expo writes it into `Info.plist` for both platforms during prebuild. No additional iOS-specific scheme declaration is needed.

## Build Workflow (Linux with xtool)

### UI-only changes

```bash
npx esbuild src/ui/main.jsx --bundle --format=iife --jsx=automatic \
  --define:process.env.NODE_ENV=\"production\" --outfile=assets/app-ui.bundle
xtool build -scheme PearCal -configuration Debug
ios-deploy --bundle <derived-data-path>/Debug-iphoneos/PearCal.app --id <device-udid>
```

### bare.js changes (rebuild UI after)

```bash
node_modules/.bin/bare-pack --linked src/bare.js -o assets/bare-universal.bundle
npx esbuild src/ui/main.jsx --bundle --format=iife --jsx=automatic \
  --define:process.env.NODE_ENV=\"production\" --outfile=assets/app-ui.bundle
xtool build -scheme PearCal -configuration Debug
ios-deploy --bundle <derived-data-path>/Debug-iphoneos/PearCal.app --id <device-udid>
```

**Note:** The exact build output path depends on `CONFIGURATION_BUILD_DIR` / `SYMROOT` in the Xcode project. Verify the correct path after the first successful build and update CLAUDE.md accordingly.

### Release (on Mac)

Archive and export via Xcode for App Store Connect upload. `buildNumber` must be incremented in `app.json` before each upload.

## Key Risks

- **`react-native-bare-kit` iOS support** — assumed functional on iOS; verify during initial prebuild and first worklet start
- **BGTask 30s window** — Hyperswarm peer discovery may not complete in time if no peers are immediately reachable; sync should be treated as best-effort
- **xtool compatibility** — build workflow assumes xtool can compile the Expo-generated Xcode project; verify after prebuild
- **New Architecture interop** — legacy bridge modules work via the interop layer on New Architecture, but verify each module is callable after first build
