# In-app "Reset app data" — cross-platform local wipe

## Goal
Give users a guarded, in-app way to wipe PearCal's local data on the current device, on all platforms (iOS, Android, desktop), without hunting for a data directory or uninstall/reinstall. Two levels: **Reset data (keep identity)** — clear the calendar DB + group sync store but keep the mnemonic — and **Full reset** — also delete the identity so the device becomes a brand-new user. TODO #118.

## Tier
T2. No wire change — Hyperbee keys/values, IPC payloads on the network, invite links, pairing handshakes, and swarm topics are all untouched, so an old-code peer and a new-code peer talk identically and no migration is needed. Classified T2 (not T1) because it adds a new **IPC message shape** (`resetAppData`) and performs a destructive clear of persisted state, and because Full reset removes this device's writer/owner identity — a cross-peer-visible effect (the same effect an uninstall already has today, but now reachable from a button, so it deserves the proposal gate). It is **not** T3: it sends no group control message, changes no crypto/pairing/auth-gate, and is entirely process-local. Contrast with the self-destruct guards in `project_self_destruct_guards.md`, which authenticate *group-broadcast* destructive ops — reset broadcasts nothing.

## Background
Today the only full reset is deleting the data directory by hand, which is:
- **Undiscoverable on desktop** — buried in `~/.config/pearcal-electron` (Linux), `~/Library/Application Support/pearcal-electron` (macOS), `%APPDATA%\pearcal-electron` (Windows).
- **Effectively impossible on iOS** — there is no OS-level "clear data"; users must delete and reinstall the whole app.
- **Clunky on Android** — Settings → Apps → PearCal → Storage → Clear storage.

In-app reset is the only clean, cross-platform path, and it's valuable for support ("try a reset"), device hand-off, and recovering from corrupted local state. The compaction infra already exists (`reclaimStorage`, per-group purge in `src/bare.js`); this proposal adds a *full clear*, not a compaction.

## Scope

### Data map (what a reset removes)
| Platform | Calendar DB + group store | Identity (mnemonic) | Web/session state |
|----------|---------------------------|---------------------|-------------------|
| iOS      | `{documentDirectory}/pearcal/{core,store}` | iOS Keychain entry | n/a (WebView) |
| Android  | `{documentDirectory}/pearcal/{core,store}` | Android secure store (Keystore/EncryptedSharedPreferences) | n/a (WebView) |
| Desktop  | `{userData}/pearcal/{core,store}` | `{userData}/mnemonic.bin` | Electron Cookies/Local Storage/Session (`session.clearStorageData`) |

- **Reset (keep identity)** removes the calendar DB + group store only.
- **Full reset** additionally removes the identity via each platform's secure store, plus (desktop) clears Electron web storage.

### IPC
- New method `resetAppData({ keepIdentity: boolean })`.
  - **Mobile**: handled in `src/bare.js` — stop swarm, close all cores/Autobases/Corestore, `fs.rm({recursive})` the `pearcal/` dir (and, on `!keepIdentity`, call the native module to delete the Keychain/Keystore mnemonic), then signal RN to restart the worklet + reload the WebView.
  - **Desktop**: handled in `electron/src/main/` — stop the bare bridge/worklet, delete `{userData}/pearcal` (+ `mnemonic.bin` on full reset), `session.defaultSession.clearStorageData()`, then `app.relaunch(); app.exit(0)`.
- The worklet must be **fully stopped before deletion** — deleting cores out from under an open Hypercore/RocksDB handle risks the same "not fsynced" loss class noted in `project_hyperbee_force_stop_loss.md`. Order: quiesce → close handles → delete → restart.

### UI (App.jsx / ui-desktop)
- Add under Profile → Settings a **"Reset app data"** entry opening the existing `BottomSheet` (per `feedback` — never a custom overlay) with the two options and clear consequence copy.
- **Full reset requires a typed confirmation** (e.g. type `RESET`) and shows a **"Back up your recovery phrase first"** step with a reveal-mnemonic link, because deleting the mnemonic is irreversible and strands any group where this device is the sole data holder (unless a blind seeder has it).
- Wire the sheet's close into `backHandlerRef` via a `closeResetSheetRef` (per the established back-gesture pattern).

### Out of scope
- No remote/group-side effect: reset does **not** notify peers, does **not** leave groups on the network, does **not** revoke writers. It is a local wipe only (a reset owner simply stops appearing, exactly as an uninstalled device does).
- No cloud/seeder data deletion — a blind seeder that holds the group keeps its copy; that's desirable (it's how re-join recovers data).
- No "reset everything on all my paired devices" — single device only.

## Compat
- No wire change: keys, values, IPC network payloads, invite links, pairing, and swarm topics are byte-identical. New-code and old-code peers replicate and pair exactly as before.
- No persisted-schema change. The new `resetAppData` IPC method is device-local RN↔worklet / renderer↔main only; it never crosses the network.
- Mixed installs are safe both directions. A device that never calls reset is indistinguishable from today.

## Verify
Canonical gate first: `npm run verify` (helper unit tests green + `bundle:bare` + `bundle:ui` build clean). Then per-platform, install-over-top:
- **Desktop (Linux)**: create a group + events, run Reset (keep identity) → app relaunches, calendar empty, same identity, re-syncs the group from the seeder; then Full reset → relaunches as a new user (fresh identity), `~/.config/pearcal-electron` recreated clean.
- **Android (TCL)** + **iOS (iPhone / Simulator)**: same two-path check; confirm the mnemonic is gone from Keychain/Keystore after Full reset (a subsequent launch generates a new identity), and gone-but-present after keep-identity (same identity restored). iOS Simulator per `feedback_ios_simulator_hands_off_testing.md` for the console.
- Confirm no orphaned open file handles / crash on the delete→restart transition on each platform.
