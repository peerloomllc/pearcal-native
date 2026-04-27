# Linked Devices list — UX cleanup + light remove

## Goal
Tighten the Profile → Devices section: distinguish the Add Device button from device cards, surface "this device" prominently, show newly-paired devices in real time on the primary, and add a cosmetic "Remove from list" affordance for old/defunct devices.

## Tier
T2. Items 1–3 are T0/T1 (UI restyle, sort change, list synthesis from `personalBase.activeWriters`). Item 4 introduces a new personal-base op interpretation (`{ op: 'del', type: 'deviceMeta' }`) and one new local-only persisted field (`deviceMetaHidden:{writerKey}`).

## Scope

### 1. Add Device button visual distinction (T0)
Re-style `App.jsx:7002-7017` with an accent border + `Plus` icon prefix in accent color. Reads as a primary action; device cards stay neutral.

### 2. "This device" sorted first + visual indicator (T0)
- `bare.js listLinkedDevices` (`~line 1999`): change comparator to put `isThisDevice` first, then by `pairedAt` ascending.
- UI: accent left-border (3px) on the "this device" card, and always show "· this device" in subtitle (currently only shown when nickname is set).

### 3. Synthesize newly-paired writers in `listLinkedDevices` (T1)
Fresh secondaries don't author a `deviceMeta:` row until they call `setDeviceNickname` (per DECISIONS 2026-04-26 — boot-stamping caused an Autobase truncate-vs-prologue crash). Result: primary's list doesn't include the new device until secondary renames itself.

**Change:** `listLinkedDevices` iterates `personalBase.activeWriters` and emits a synthetic placeholder for any writer key without a `deviceMeta:` row. The existing UI listener for `pairingCompleted` (`App.jsx:6541`) already triggers a refresh — synthesis just needs to return the new row at that moment. No new appends. Sidesteps the truncate-bug area.

### 4. Light "Remove from list" (T2)
**Use case:** sold/factory-reset/lost device. Cosmetic cleanup — does NOT revoke writer access (TODO #95 v2 covers true revocation; T3, separate proposal).

**Personal-base op:** `{ op: 'del', type: 'deviceMeta', key: 'deviceMeta:{writerKey}' }`. Authored by any paired writer (paired devices are trust-equivalent; if one were malicious it could already do worse). Self-remove is blocked at the IPC layer (no UI button on `isThisDevice` card).

**Apply branch:** when a `del` op for `type: 'deviceMeta'` arrives, `db.del(val.key)` AND `db.put('deviceMetaHidden:{writerKey}', { ts })`. The hidden marker is needed because `listLinkedDevices` synthesises rows from `activeWriters` (item 3), so just deleting the row would resurrect it as a synthetic placeholder.

**Apply put branch:** clear any `deviceMetaHidden:{writerKey}` on a fresh `op: 'put'` for that writer. If a removed device comes back online and re-stamps its row (e.g., user changed their mind, factory-reset device returns), it un-hides naturally.

**Synthesis filter:** `listLinkedDevices` skips writers whose `deviceMetaHidden:` marker is set.

**IPC:** `removeDeviceFromList(writerKey)` validates 64-hex format, refuses self-removal, appends the del op.

## Compat
- Old peers ignore unknown `op: 'del'` on `type: 'deviceMeta'` (their apply only handles puts, with a `continue` at the top of the apply loop). Their device list stays unchanged until they upgrade. Mixed-install symptom: cosmetic device-list inconsistency during the transition. No data risk.
- `deviceMetaHidden:` is a local-only mirror key, never replicated through Autobase. Old peers never see it. Each peer derives its own marker from the same op.
- Items 1–3 are local-only changes; no wire impact.

## Verify
1. Pixel: open Profile → DEVICES, confirm Add Device button looks distinct from device card (accent border + Plus icon).
2. Pixel: confirm "This device" sorts first regardless of `pairedAt`, has accent left-border, subtitle shows "· this device" even before naming.
3. Pixel + TCL: from a fresh-paired state, watch Pixel's device list for TCL appearing within ~1 sec of `pairingCompleted` (synthesised row, no rename needed).
4. Pixel: tap "Remove" on a non-self row, confirm dialog, confirm row disappears on Pixel and on TCL within sync interval.
5. Old/defunct simulation: rename TCL → "OldPhone", remove on Pixel. Reboot Pixel → row stays gone (hidden marker persists). Reboot TCL → row stays gone on TCL. Re-rename on TCL → row reappears on both.

## Rollback
Single feature branch, ~3 commits (proposal, fixes 1–3, fix 4). Roll back per-commit if any layer regresses. Old peers ignoring del ops means rollback is safe; no data migration.

## Open questions
- Should the Remove confirm dialog mention "this does not revoke writer access" or stay terse? Lean: terse for v1, expand if users surface confusion. (Will revisit when #95 v2 ships true revocation.)
