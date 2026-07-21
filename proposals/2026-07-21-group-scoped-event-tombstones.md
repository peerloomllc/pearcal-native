# 2026-07-21 — Group-scoped event tombstones (TODO #122)

## Goal

Stop an event from being destroyed on every other device when the user moves it
from one group to another.

## Tier

**T2.** Adds a field to an existing Autobase op and a new Hyperbee key shape.
No wire break, no auth or crypto change, no pairing change. Old peers ignore the
new field and keep today's behavior.

## The bug

Removing an event from a group and adding it to another is not a delete, but the
code treats it as one.

`src/ui/App.jsx:1026` diffs the group list on save and, for each group the user
deselected, calls `sync.deleteEvent(gid, …)`. That appends
`{ op:'del', type:'event', key:'events:{date}:{id}' }` to the OLD group's
Autobase (`syncDeleteEvent`, `src/bare.js:4674`).

On every device except the one that made the edit, that op applies with
`isRemote === true` and does three things:

1. `deleteFromLocal(...)` removes the local `events:{date}:{id}` row (`src/bare.js:5704`)
2. writes a tombstone at **`deleted:{eventId}`** — no group scope (`src/bare.js:5746`)
3. drops the event from the group view

The matching put into the NEW group is then permanently refused, because both
resurrection guards key off that global tombstone:

- `mirrorToLocal` — `src/bare.js:6170`
- `foregroundSync` — `src/bare.js:5042`

Ordering does not matter: whichever arrives second loses. The event survives only
on the authoring device.

Observed 2026-07-21 on the reporter's desktop: **112 `deleted:` tombstones against
40 surviving events** after attempting to migrate events from "Hudgins" to
"Hudgins 2". Single-device harness confirms the author keeps its copy (its own del
is self-authored, so `isRemote` is false and neither 1 nor 2 runs).

## Scope

**Changes**

- `syncDeleteEvent()` gains a trailing `scope` argument. When it is `'group'` the
  appended op carries `scope:'group'`.
- `src/ui/App.jsx:1028` — the removed-groups loop, and only that call site —
  passes `'group'`.
- `apply()`'s `del`/`event` branch: when `val.scope === 'group'`, write the
  tombstone at **`deleted:{groupId}:{eventId}`** instead of `deleted:{eventId}`,
  and instead of deleting the local row outright, remove `groupId` from the local
  event's `groups[]`. Delete the local row only if `groups[]` ends up empty.
- Both guards additionally consult `deleted:{groupId}:{eventId}` for the group
  they are mirroring, so a re-put from the group the user left is still blocked
  while a put from the new group is allowed.

**Does NOT change**

- "Delete for Everyone" (`src/ui/App.jsx:1113`), the recurrence-regeneration
  tombstones (`:1003`) and every shadow/busy-time cleanup (`:1096`, `:1125`,
  `:1152`, `:1164`, `:1215`, `:1228`). All eight keep writing the global
  `deleted:{eventId}` tombstone. Only the move path (`:1028`) is re-scoped.
- The tombstone retention sweeps (`src/bare.js:2731`, `:2847`) keep working on the
  global keyspace; group-scoped keys are additive and swept by the same prefix
  iteration.

## Compat

Purely additive in both directions.

- **Old peer, new op.** `scope` is an unknown field on a `del` op it already
  understands. It writes the global tombstone exactly as it does today, so a
  moved event still vanishes there. No corruption, no crash — the current bug,
  unchanged, until that peer updates.
- **New peer, old op.** No `scope` field means a genuine delete, which is the
  correct reading of every op any existing build emits.
- **Existing tombstones.** Untouched and still honored: the guards check the
  global key first, then the group-scoped one. No migration, no backfill.

Because old peers keep the old behavior, this fixes moves only once the user's own
devices are updated. That is acceptable: the failure it replaces is silent data
loss, and the fix cannot make an un-upgraded peer worse.

## Verify

1. `npm run verify` — 145 existing tests stay green.
2. Unit tests for the new predicate: global tombstone blocks all groups;
   group-scoped tombstone blocks only its own group; empty `groups[]` after
   removal deletes the row; non-empty does not.
3. Two headless `bare.js` peers on real Hyperswarm (the harness used for #228 and
   PR #231): peer B joins groups A and B, peer A creates an event in group A,
   waits for convergence, then moves it to group B. **Assert the event is present
   on BOTH peers afterwards, under group B only.** This test fails on `master`.
4. Regression: "Delete for Everyone" on a two-peer group still removes the event
   from both, and the deleted event does not come back after `foregroundSync`.
5. On-device: TCL and Pixel in a shared group, move an event between two groups,
   confirm it survives on both.

## Rollback

Revert the commit. The `scope` field stops being emitted and `deleted:{groupId}:{eventId}`
keys become inert — unknown keys are simply never read, and the global tombstone
path is restored verbatim. No data written by the new code needs undoing, though
events moved while it was live would revert to today's behavior on the next move.

## Open questions

1. **Should a group-scoped removal notify other members?** Today the move fires the
   same "X deleted an event" notification as a real delete, which is misleading.
   Suppressing it for `scope:'group'` is a small extra change and probably right,
   but it is a behavior change beyond the data-loss fix. Recommend: suppress.
2. **Should the already-lost events be recoverable?** The originals may still exist
   in the old group's Autobase history and on the blind seeder. A one-shot repair
   that clears global tombstones for events still present in some group view is
   possible but is its own change. Recommend: separate item, decide after this lands.
3. **Retention.** Group-scoped tombstones multiply per group. With the existing
   windowed retention this is almost certainly noise, but worth a look if a user
   has many groups.

## References

- TODO #122 (this), #123 (encryptionKey loss), PR #231 (ghost/husk + key preserve)
- `src/bare.js:4674` `syncDeleteEvent`, `:5704` local delete, `:5746` tombstone write,
  `:5042` + `:6170` resurrection guards
- `src/ui/App.jsx:1026-1029` the removed-groups diff
