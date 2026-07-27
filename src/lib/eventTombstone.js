// TODO #122 — group-scoped event tombstones.
//
// Removing an event from a group is not the same as deleting it. The UI's save
// path diffs the group list and issues a `del` op to every group the user
// deselected; historically that wrote a GLOBAL `deleted:{eventId}` tombstone,
// which then blocked the very copy the event had just been moved INTO. The
// event survived only on the device that made the edit.
//
// Pure decision logic lives here so it is unit-testable — bare.js touches
// BareKit/Pear at load and can't be required from tests. Same split as
// ownerGuard.js.

'use strict'

// Extract the event id from an "events:{date}:{eventId}" key. Cannot use
// split(':').pop() because shadow ids contain colons (e.g.
// "shadow:src:fwd:gid"), which would return the last colon segment ("gid")
// instead of the full shadow id. Skips the "events:" prefix and the
// "YYYY-MM-DD:" date segment.
//
// Lives here rather than in bare.js because the tombstone decisions depend on
// it: the del branch derives the id this way when WRITING a scoped tombstone,
// so a re-share must derive it the same way to clear the key that actually
// exists on disk (TODO #141). Keeping the two in one module is what lets a test
// pin them together.
function eventIdFromKey (key) {
  const first = key.indexOf(':')
  if (first < 0) return key
  const second = key.indexOf(':', first + 1)
  if (second < 0) return key.slice(first + 1)
  return key.slice(second + 1)
}

// Per-group tombstone key. Deliberately NOT under the `deleted:` prefix: the
// retention sweeps iterate that prefix and parse everything after it as an event
// id, so a groupId sitting in that position would be read back as one.
function groupDeletedKey (groupId, eventId) {
  return 'deletedInGroup:' + groupId + ':' + eventId
}

// Does this `del` op mean "unshared from this group" rather than "deleted"?
// Only event dels can be group-scoped; the field is absent on every op emitted
// by builds predating this change, which is exactly the "delete outright"
// reading those builds intended.
function isGroupScopedDelete (op) {
  return op?.scope === 'group' && op?.type === 'event'
}

// Should a mirrored put for `eventId` into `groupId` be refused?
// A global tombstone wins everywhere (the event is gone). A group-scoped one
// only blocks the group it was written for.
function shouldBlockMirror ({ globalTombstone, scopedTombstone }) {
  if (globalTombstone) return true
  return !!scopedTombstone
}

// TODO #141 - when may a re-share clear the group-scoped tombstone?
//
// The tombstone above is written once and, before this, deleted nowhere: three
// references existed in the whole codebase, the import, the read and the write.
// Worse, the write sits inside apply()'s `isRemote` guard, so the device that
// authored the unshare never wrote one while every OTHER member did. Re-share
// the event into that group later and the author sees it fine (putEvent writes
// the local row directly) while every other member's mirrorToLocal refuses the
// put permanently. The event never comes back for them.
//
// A put into group G IS a re-share into G, so applying one should lift the
// block. The only thing that must not happen is a STALE put - one authored
// before the unshare and linearised after it - resurrecting the event. Hence
// the comparison, which is the same last-write-wins rule the rest of apply()
// uses.
//
// `delAt` is the unshare's AUTHORED time, carried on the del op itself. It
// matters that it is not the tombstone's own `ts`: that is the applying
// device's clock at apply time, so comparing an author's `updatedAt` against it
// would be comparing two different machines' clocks. In the common case - one
// person unshares and later re-shares - `delAt` and `putUpdatedAt` come from
// the same device, so the comparison is exact.
//
// When the two cannot be compared (an op from a build predating `delAt`, or a
// put with no `updatedAt`) this deliberately CLEARS. The two failure modes are
// not symmetric: refusing to clear leaves an event permanently invisible on
// every device but one, which is the bug being fixed here and the same class as
// the data loss in #122, while clearing wrongly resurrects an unshared event,
// which is visible and one tap to undo. Prefer the visible failure.
function shouldClearScopedTombstone ({ tombstone, putUpdatedAt }) {
  if (!tombstone) return false
  const delAt = tombstone.delAt
  if (typeof delAt !== 'number' || typeof putUpdatedAt !== 'number') return true
  // `>=` not `>`: same-millisecond ties go to the re-share, per the asymmetry above.
  return putUpdatedAt >= delAt
}

// Groups left after unsharing from `groupId`. An empty result means the event has
// left every group it was shared into and the local row can be dropped.
function remainingGroupsAfterUnshare (groups, groupId) {
  return (groups ?? []).filter(g => g !== groupId)
}

module.exports = {
  eventIdFromKey,
  groupDeletedKey,
  isGroupScopedDelete,
  shouldBlockMirror,
  shouldClearScopedTombstone,
  remainingGroupsAfterUnshare,
}
