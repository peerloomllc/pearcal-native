# 2026-07-18 — Authenticate `groupDeleted` (TODO #117 item d)

## Tier
**T3** — security-critical auth gate on a **destructive** path + a new cross-peer
Autobase record. Old-code peers won't understand the new record. Proposal +
rollback + RCA readiness required.

## The vector
`groupDeleted` is an **owner-only** action (UI: `App.jsx:1341` sends it only when
`action === 'delete' && isOwner`; non-owners take the `leave`/`memberLeft` path).
But the receive handler (`bare.js:7126`) acts on an **unauthenticated plaintext**
control message with no corroboration:

```js
if (parsed.groupDeleted) {
  const gid = parsed.groupDeleted
  await deleteGroup(gid)   // purges the group's local DB — irreversible
  await leaveGroup(gid)
  ...
}
```

Any peer on the writer-announce channel can forge `{ groupDeleted: <anyGroupId> }`
and make a victim purge that group locally. This is the same class as the
`memberLeft` vector fixed in #199, but worse: no self-vs-other check, and it
destroys the whole group. #198 (connection-layer) already blocks keyless peers
from **encrypted** groups; **legacy (unencrypted) groups remain fully exposed.**

Unlike `memberLeft` — which fixed itself by corroborating against the existing
`removedMembers` view record — `syncDeleteGroup` (`bare.js:4690`) writes **nothing**
to the shared base today (only a local `deletedGroup:` tombstone + the plaintext
broadcast). So there is no authoritative signal to corroborate against yet; we
must add one.

## Design (Approach A — authoritative, owner-authenticated deletion record)

Mirror #199's philosophy: corroborate the destructive action against encrypted
Autobase state a keyless peer cannot forge.

1. **Owner writes an authoritative deletion op.** `syncDeleteGroup` (owner path)
   appends `{ op: 'deleteGroup', groupId, ts }` to the group's Autobase **before**
   the local purge. It replicates through the encrypted base and reaches offline
   members via the blind seeder / other peers, exactly like `removedMembers`.
   The plaintext broadcast is kept as a fast-path **nudge** (and for old peers).

2. **`apply()` authenticates the op by the real author.** On a `deleteGroup` op,
   verify `node.from.key` (the Autobase-attested author — `bare.js:2418`, not the
   spoofable `value.*`) equals the **owner's** writerKey, resolved from the view's
   owner member record. If authentic: write a `deleted: true` tombstone onto the
   group view record (LWW by `ts`) and trigger the local `deleteGroup` +
   `leaveGroup` + `groupDeleted` UI event. A non-owner writer's `deleteGroup` op is
   **rejected** (logged), same shape as the `promoteOwner` / `deviceMeta` gates.
   → Deletion now propagates **authoritatively**, no plaintext required.

3. **Corroborate-on-receive (the actual security fix).** The plaintext handler
   (`7126`) becomes: `base.update()`, read the view; honor the delete **only** if
   the view shows the group authoritatively deleted (`deleted:true`). Readable &
   not deleted → **ignore** (forged). Unreadable view → best-effort fall-through
   (legacy; #198 covers the encrypted case at the connection layer). Extract the
   decision to `src/lib/ownerGuard.js` as `shouldHonorGroupDeleted(...)` with unit
   tests — same pattern as `shouldIgnoreSelfMemberLeft`.

### Owner→writerKey resolution
apply() needs the owner's writerKey to check `node.from.key`. Options, cheapest
first: (a) the owner's member record already carries a `writerKey` binding (the
identity-proof machinery at `7133+` stamps it) — use it; (b) fall back to the
`promotionLog` / first-writer if absent. Confirm (a) is populated for the owner
before relying on it; else the op must carry an identity proof like the announce
does.

## Backwards-compat (the T3 cost)
- **New owner → old member:** old member ignores the base op it doesn't understand
  but still acts on the plaintext nudge → deletes. ✓
- **New owner → new member:** base op authenticates → deletes; plaintext
  corroborates. ✓
- **Old owner → new member:** old owner sends only the plaintext (no base op). New
  member corroborates against a readable view with no `deleted` flag → **ignores**
  → the group is NOT deleted on the new member. ✗ (regression for legacy groups.)

The last case is the accepted cost. Mitigation levers (pick in the sign-off):
- **Accept it** — consistent with the encryption-rollout stance (small user base,
  groups recreatable; legacy groups are being phased out via rekey). New members
  keep a group the old owner deleted until they leave manually.
- **Grace window** — honor an uncorroborated plaintext delete only for legacy
  (`!encryptionKey`) groups for a short migration period, logged; drop later.
- **Sender-identity check** instead of a base record for legacy — verify the
  plaintext arrived on the owner's authenticated connection. Heavier; the
  plaintext handler doesn't carry sender identity today.

## Verify
- Unit: `ownerGuard.test.js` — `shouldHonorGroupDeleted` (forged→ignore,
  authoritative-deleted→honor, unreadable→fall-through) + apply's owner-auth
  (owner op honored, non-owner op rejected).
- On-device (T3): owner deletes an **encrypted** group → propagates to Android +
  iOS members (base op path). A forged plaintext `groupDeleted` from a co-member
  is **ignored** (drive via a second device / crafted message). Offline member
  gets the deletion from the seeder on reconnect.

## Rollback
Additive op + a new view field + a receive-side guard. Revert restores the
unconditional plaintext delete. No key/topic change; the `deleted` tombstone is a
new LWW field on the existing group record (ignored by old code).

## References
[[project_owner_recovery_landmines]], [[project_hyperbee_force_stop_loss]], #199
(`memberLeft` guard + `ownerGuard.js`), #198 (connection-layer encrypted gate),
`bare.js` apply `node.from.key` author-attestation (deviceMeta/promoteOwner gates).
