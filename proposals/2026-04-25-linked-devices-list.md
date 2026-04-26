# 2026-04-25 — Linked devices list with per-device nicknames (TODO #95 v1)

## Goal

Show the user, under Profile → ADVANCED → DEVICES, every device paired to their identity, with each device able to set its own human-readable nickname. Read-only directory in v1.

## Tier

**T2.** New persisted Hyperbee keyspace (`deviceMeta:{writerKey}`) in the personal Autobase view, mirrored to local DB. New apply branch. Two new IPC methods. No wire-protocol change, no Hyperswarm topic change, no pair-handshake change.

Revocation (`removeWriter`, `blockedWriter:personal:{key}` extension) is **T3** and stays in TODO #95 as a follow-up. Keeping it out of v1 means we don't need to extend the personal-base apply rule with destructive ops on this pass.

## Scope

### In

- **Personal-base keyspace**: `deviceMeta:{writerKey}` in the personal-base Hyperbee view, value `{ writerKey, nickname, platform, pairedAt, updatedAt }`.
- **Apply branch** in `makePersonalApply` (`src/bare.js:1456`): on `{ op: 'put', type: 'deviceMeta', key, value }`, gate that **`node.from.key` (the Autobase-attested authoring writer) === the row's `writerKey`**. Using the Autobase-attested key — not a self-declared `author` field in the value — means a malicious sibling cannot lie about who they are. LWW by `updatedAt` against the local-DB mirror. **Skips `view.put`** — see "Apply gate ordering" in §Compat for rationale.
- **No self-write on boot.** The `deviceMeta:{localWriterKey}` row is appended lazily, only when the user explicitly sets a nickname (`setDeviceNickname` IPC). Until then, `listLinkedDevices` injects a synthetic "this device" placeholder so the UI always shows the local device. This avoids appending blocks during initial Autobase drain on already-paired secondaries (the original boot-seed approach correlated with crash reports tied to corrupt group state in the chain — see §Compat).
- **IPC methods** in `bare.js` dispatcher (`bare.js:146`):
  - `listLinkedDevices()` → reads `deviceMeta:*` from local DB, returns array sorted by `pairedAt`. Each row tagged `isThisDevice: writerKey === personalBase.local.key`.
  - `setDeviceNickname(nickname)` → appends a `deviceMeta` put for the **local** writer key only with the new nickname + bumped `updatedAt`. (Caller cannot set someone else's nickname; the apply gate would reject it anyway, but the IPC layer enforces it too as a usability safeguard.)
- **Platform string**: passed from RN to bare via `init` payload (existing IPC at `bare.js:127` already takes `dataDir`; extend to also carry `Platform.OS`). Cached in a module-local `_platform` and read by the seed routine.
- **UI** in `App.jsx` Profile → ADVANCED → DEVICES section (`App.jsx:7021`):
  - List below the existing "Add a device" button.
  - One row per device. Default label when nickname is empty: `"This device"` for the local writer, `<platform>` (e.g., "iOS device", "Android device") for siblings.
  - Tap on the local row → inline rename (uses an existing text-input pattern from the profile name editor).
  - Sibling rows are read-only; tapping shows nickname or default label; long-press is a no-op in v1.
  - Refresh on the existing personal-sync events that already trigger profile changes.

### Out

- **Revocation** (separate T3 proposal) — `{ removeWriter }` op, `blockedWriter:personal:{key}` extension, kick-revocation ripple to groups, undo-window UX.
- **Last-seen timestamp** — explicitly cut from #95 per the user.
- **Editing another device's nickname** — only-self-write keeps the apply gate clean and matches the threat model (a compromised paired device can already do anything, no point letting a benign sibling rename it remotely).
- **Per-device profile photo / icon** — keep v1 to text only. Platform string is enough for the visual hint.
- **Listing on single-device installs that never enabled multi-device** — UI hides the section when `personalBase` is null. The existing "Add a device" button stays visible (it's the entry point that creates the base).

## Compat

**Old peers** (no `deviceMeta` apply branch):
- They ignore unknown apply ops — `val.op === 'put' && val.type === 'deviceMeta'` falls through every existing branch and is silently skipped. View doesn't get the row, but the row is also written to local DB on the authoring device, so the local UI works. **Cross-device visibility requires both peers on the new code** — a v1.0.X (new) device's `deviceMeta` op only mirrors on v1.0.X+ siblings.
- This is acceptable: the feature only matters once you have ≥2 devices, and rolling out new builds to all of one's own devices is the user-controllable case (vs. group peers, which the user can't force-upgrade).

**Apply gate ordering**:
- The new `deviceMeta` branch goes **after** the existing branches, before the catch-all. No interaction with existing branches.

**Mirror to local DB**:
- Direct `deviceMeta:` keying (no NS abstraction) since `personalGroups:` and `identityProfile` already do it that way.

**Why skip `view.put`**:
- During initial integration testing, the boot-seed-on-paired-secondary path triggered an Autobase `INVALID_OPERATION: Truncation breaks prologue` crash deep inside the linearizer's drain → undo → truncate path. Root cause turned out to be corrupt state in a separate test group's Autobase, not the personal base — but the workaround (skip `view.put`) was kept because it's harmless: cross-device sync still works because Autobase replicates each writer's hypercore and runs apply on every peer for every node, so each peer's `db.put` converges independently. The only thing skipping `view.put` costs is the fast-path "fresh-paired secondary catches up via single Hyperbee view replay" — but the data is small (one row per device, ~5-10 max for any normal user), so chain replay is fine.

**Backwards-compat with newly-paired secondaries** (post-#95 ship):
- A paired secondary boots, opens personal base, and runs apply over every writer's ops as they replicate. Each existing `deviceMeta` op writes a row to the secondary's local DB. No view replay needed.

**Pair-time captures** (deferred — not needed for v1):
- The pair handshake could include `name` in the secondary's hello so the primary writes the secondary's row immediately. **Not needed**: the secondary's own boot-seed runs as soon as the personal base opens (same call site as today's `ensurePersonalBase` after pair). Keeping the pair wire untouched also means this proposal stays T2 instead of escalating to T3.

## Verification

1. Build + install on Pixel (53071FDAP00038), TCL (4H65K7MFZXSCSWPR), iPhone (00008030-0009714C2613402E).
2. Fresh-pair Pixel ↔ iPhone. Within ~5s of pair complete, both devices show 2 rows under Profile → ADVANCED → DEVICES (nickname empty, default label = `"This device"` / `"iOS device"`).
3. Set Pixel's nickname to "work phone". Within ~2s the iPhone row for Pixel updates to "work phone". TCL is still single-device — verify its DEVICES list has only 1 row (itself) and no orphans from a previous pair.
4. Pair TCL into the Pixel/iPhone identity. After pair complete, all three devices show 3 rows. Set TCL's nickname to "kitchen tablet". Verify Pixel + iPhone both see "kitchen tablet" within ~2s.
5. Force-close all three apps. Reopen. Verify rows survive (local-DB mirror works) and that the rename persists across cold boots.
6. **Apply gate test**: hand-craft an IPC call that tries to write `deviceMeta:{otherWriterKey}` from Pixel for the iPhone's row. Verify the apply branch rejects it (silently skips; no local-DB mutation; iPhone view unchanged).
7. **Single-device user**: factory-reset TCL to fresh-install state with a brand-new mnemonic, do not pair. Verify the DEVICES section shows only the "Add a device" button; no list, no errors. Once user enables multi-device by tapping "Add a device" (which creates the personal base), verify a single self-row appears.

`npm run verify` (lint + smoke) before merge.

## Rollback

- Single PR. Revert the merge if any issue surfaces in soak.
- Persisted side-effect on rollback: the `deviceMeta:*` keyspace remains in users' personal bases. Old-code installs simply ignore it (apply branch doesn't exist; rows still mirror to local DB on the authoring device but no UI consumes them). No data corruption, no migration needed.
- If a forward-incompatible follow-up is later needed, version the value shape (`v: 2`) — old apply ignores unknown shapes. v1 ships with no version field; default-treat-as-v1 on next change.

## Open questions

1. **Default label for siblings without a nickname**: `"iOS device"` / `"Android device"` (platform-only) vs. `"Tim's iOS device"` (pull from `identityProfile.name` + platform). Lean toward platform-only — `identityProfile.name` is the user's overall name, not device-specific, and showing the same name 3 times is noisy.
2. **Nickname length cap**: 32 chars feels right (matches the existing profile-name cap). Sanity-trim whitespace; reject empty after trim → revert to default label.
3. **Migration from already-paired installs**: when this PR lands, existing paired devices have a personal base but no `deviceMeta` rows. Each device self-seeds on first boot post-upgrade. Until all siblings boot the new build, the list is partial. Acceptable — converges as the user opens each device.
