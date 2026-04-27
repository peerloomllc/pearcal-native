# Pairing + personal-base hardening — Tier 1 audit fixes

## Goal
Close three pairing-flow + personal-base edge cases identified by the 2026-04-26 multi-device audit before adding a third platform (Mac Catalyst, TODO #55).

## Tier
T2. Adds one new local-only persisted field (`personalSeenGroup:{groupId}`); other changes are local-recovery and IPC hookups. No wire-protocol or message-shape changes.

## Scope

### Fix A — Roll back `personalMeta:bootstrap` when pair-grant open fails
In `_handlePairGranted` (`src/bare.js:~2295-2304`), the secondary writes `personalMeta:bootstrap` and `personalMeta:migrated` BEFORE calling `ensurePersonalBase`. If the open fails (disk pressure, Hypercore corruption, transient I/O), the bootstrap stays persisted. On next launch, `ensurePersonalBase` opens the primary's base read-only because no `addWriter` was granted (secondary never sent `personalWriter`) — every user write silently no-ops via the `if (!personalBase?.writable) return` guards in `personalBase*Append*` helpers.

**Change:** if `ensurePersonalBase` returns null after the writes, `db.del('personalMeta:bootstrap')` and `db.del('personalMeta:migrated')` before throwing. Outer catch already emits `pairingFailed`. User can retry pair cleanly.

### Fix B — `personalSeenGroup` marker gates `cleanupStalePersonalGroups` deletes
`cleanupStalePersonalGroups` (`src/bare.js:~1897`) deletes a `personalGroups:{id}` view entry when there's no matching local `groups:{id}`. On a freshly-paired secondary mid-replication, every group is "missing locally" temporarily — group autobases replicate independently of the personal base on different swarm topics, so the personal base's `personalGroups:` rows arrive ahead of the group records. The sweep then deletes them all, the `del` ops replicate back to siblings, and the entire identity loses every group pointer.

**Change:** stamp `personalSeenGroup:{groupId}` in local DB whenever a `personalGroups:{id}` op flows through personal-base `apply` (the existing `groupMembership` branch). Cleanup deletes only when EITHER `blockedFromGroup:{id}` is set OR (`personalSeenGroup:{id}` is set AND `groups:{id}` is missing). Fresh secondaries with no markers yet are immune — the sweep no-ops on first boot, then runs normally once mirror has caught up.

### Fix C — UI Back button cancels the pair session
The pair sub-screen's Back button (`src/ui/App.jsx:3522`) just resets local UI state. Bare's `_pairSession` keeps its swarm topic joined until the 15-min link expiry. If the user backs out and pairs to a different device or scans a freshly-regenerated link, the old topic stays open, `consumePairLink` rejects with "another pair session in progress", and the user sees a confusing failure.

**Change:** Back button calls `db.cancelPairing()` (already an IPC method, exposed in `src/ui/main.jsx:95`). Same hookup on the QR-scan-cancel path. Add cancellation on `OnboardingModal` unmount as a belt-and-suspenders for app-close / step-decrement scenarios.

### Out of scope (deferred)
- **Pairing audit #3** — detect `personalBase.writable` transition as a fallback completion signal in case primary's `replySend({ type: 'complete' })` is lost. Current behaviour: secondary times out at link expiry (≤15 min). Slow but not a stuck state.
- **Storage audit #2** — `migratePersonalData` crash-resume idempotency. Real risk on large installs; revisit as separate fix.
- **Identity audit #3** — `identityProfile` LWW non-atomic put. Revisit alongside any future LWW review.

## Compat
- Old peers run unchanged. No wire-shape changes; `addWriter` ops, pair messages, `personalGroups:` ops, and `personalMeta:bootstrap` shape are all unmodified.
- `personalSeenGroup:` is a local-only mirror key, never replicated through any Autobase. Old peers never see it. Mixed installs are safe — old code keeps running the original `cleanupStalePersonalGroups`; new code runs the safer variant. Both terminate; neither writes anything the other can't ignore.
- Fix A is a recovery improvement only. Old persisted half-paired-bootstrap orphans on already-installed devices remain recoverable manually (re-pair clears them).
- Fix C: `cancelPairing` is already an existing IPC method (`bare.js:2118`, `bare.js:235` dispatch). Wiring it into the Back button is a UI-only change.

## Verify
1. **Happy path regression** — pair Pixel → TCL successfully on master and on the fix branch. Tier 1 fixes must not regress.
2. **Pair-fail rollback (A)** — temporarily mock `ensurePersonalBase` to return null in `_handlePairGranted`. Confirm secondary's `personalMeta:bootstrap` is rolled back: run `await db.get('personalMeta:bootstrap')` after the failed pair, expect null/undefined. User can retry pair without manual intervention.
3. **Cleanup race (B)** — On TCL: pair to Pixel, kill TCL during the first replication burst (after `personalMeta:bootstrap` written but before group autobases finish their initial sync). On reboot: cleanupStalePersonalGroups must NOT delete `personalGroups:` entries because no `personalSeenGroup` markers exist yet. Once sibling auto-join completes, markers stamp, future kicks/leaves clean up correctly.
4. **Back-button cancel (C)** — On TCL: open pair sub-screen, back out, immediately re-open and consume a different link from Pixel. Both flows succeed without "another pair session in progress" error. Confirm bare-side log shows `_clearPairSession` ran.
5. **No regression on `Sweep Orphaned Data` button** — that button stays hidden (`{false && ...}` wrapper from `f63dc23`); B's fix is unrelated to the auditStorage / purgeOrphanDataRanges path.

## Rollback
Each fix is its own commit on `feature/pairing-personal-base-hardening`. Roll back individually if any fix regresses behaviour. No data migration to reverse — `personalSeenGroup` keys can be left in place (idempotent stamp) or batch-deleted with no side effects. `personalMeta:bootstrap` rollback in Fix A only fires on the failure path which previously persisted nothing useful anyway.

## Open questions
- Should re-enabling Sweep Orphaned Data ride this PR? **No** — that's a separate auditStorage hardening task, root cause still unidentified (per `f63dc23`).
- Should we add a no-progress timeout (e.g., 60s after first peer attempt) on the secondary side instead of relying on the 15-min link expiry? **Punt.** Fix C's cancel-on-back covers the user-active case; no-peer-detection requires hooking swarm events and adds surface area.
