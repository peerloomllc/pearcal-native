# 2026-04-24 — Phase 5: kick blocks all writer keys of an identity

## Goal

Make group member-kicks effective against every device the kicked identity controls (current and future), instead of only the writer key the owner happens to know about today.

## Tier

**T2.** New persisted Hyperbee keyspace (`blockedIdentity:`), tighter apply-time gate on `addWriter`, and a small extension to writer-announce post-verification. No wire-protocol break, no IPC shape change, no new Hyperswarm topic.

## Scope

### In

- New keyspace `blockedIdentity:{groupId}:{identityPublicKey}` — set whenever an identity appears in `group.removedMembers`. Set in apply (so it converges on every member, not just the device that initiated the kick).
- Apply's addWriter gate (`src/bare.js:3367`) extends: after the existing `blockedWriter` check, look up the writer's identity via `writerIdentity:{groupId}:{writerKey}` and refuse if `blockedIdentity:{groupId}:{identityPublicKey}` is set.
- Apply's group-put branch (where `removedMembers` is mirrored): scan `writerIdentity:{groupId}:*`, find every writer key bound to a removed identity, and write a `blockedWriter:{groupId}:{writerKey}` for each. Backfills the existing per-key gate on already-known sibling devices.
- Writer-announce verified branch (`src/bare.js:~4981`): after writing `writerIdentity`, check `blockedIdentity:{groupId}:{identityPublicKey}`. If set, write `blockedWriter:{groupId}:{writerKey}` for the freshly-announced writerKey before any addWriter op can race ahead.
- `approveRejoin` (`src/bare.js:2986`) clears `blockedIdentity:{groupId}:{identityPublicKey}` alongside the existing `blockedWriter` cleanup so reinstated identities aren't permanently barred.

### Out

- Removing already-admitted writers from the Autobase linearizer. Autobase doesn't support writer revocation cleanly; "blocked" remains "no future addWriter admission + apply-time filtering on a future hardening pass." Phase 5 only closes the new-writer admission gate.
- Filtering past ops authored by removed members. Today's `removedMembers`-self-kick on the kicked side and `isAuthoritative` LWW already shape this; not broadening here.
- Identity-level blocking outside groups (personal base already has `blockedWriter:personal:` from PR #131 — out of scope for this PR).

## Compat

**Old peers** (no `blockedIdentity` check):
- Apply's existing `blockedWriter` gate continues to work for any per-key blocks they have.
- They never *write* to `blockedIdentity`, never *read* from it. Mixed fleet has a weaker enforcement floor on un-upgraded peers; the rest of the group still enforces. Not a correctness break — a graceful degradation.

**New peers receiving old `removedMembers` updates:**
- The mirror logic flips on existing entries too — backfills `blockedIdentity` from any pre-existing `removedMembers` array on first apply pass after upgrade. Idempotent.

**Owner-recovery interaction (project_owner_recovery_landmines):**
- `approveRejoin` already clears `blockedWriter` and `pendingRejoin`. Extending it to clear `blockedIdentity` keeps the un-block path complete.
- Defensive check: a group's `ownerId` should never appear in its own `removedMembers`. Asserted in apply mirror — refuse to write `blockedIdentity` for `ownerId` even if the input array claims it.

**Migration:**
- One-shot scan in apply on first group-put after upgrade: any identity in `removedMembers` whose `blockedIdentity` isn't yet set gets one written. Idempotent; runs every apply but is cheap (membership lists are small).

## Verification

1. Pixel + TCL paired (multi-device identity X). Both members of a test group owned by a third device.
2. Owner kicks identity X. Pixel + TCL self-kick — already today's behaviour, regression-check.
3. On TCL, factory-reset, restore from mnemonic (same identity X), generate fresh random writer key W3.
4. TCL attempts to rejoin via invite link. Owner refuses (or doesn't act). Verify TCL's W3 is not admitted as a writer on any group member's apply gate (check `host.addWriter` is not called).
5. Owner approves rejoin. Verify `blockedIdentity` is cleared and TCL's W3 admits cleanly.
6. Mixed-version test: one group member on old code, one on new code, kick → new-code member enforces identity block, old-code member only enforces writerKey block. No crash, eventual convergence on the kick.
