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

// Groups left after unsharing from `groupId`. An empty result means the event has
// left every group it was shared into and the local row can be dropped.
function remainingGroupsAfterUnshare (groups, groupId) {
  return (groups ?? []).filter(g => g !== groupId)
}

module.exports = {
  groupDeletedKey,
  isGroupScopedDelete,
  shouldBlockMirror,
  remainingGroupsAfterUnshare,
}
