// TODO #122 — moving an event between groups must not destroy it. These test the
// pure decisions extracted to src/lib/eventTombstone.js.
// (bugfix/group-scoped-event-tombstones)
const test = require('node:test')
const assert = require('node:assert/strict')
const {
  groupDeletedKey,
  isGroupScopedDelete,
  shouldBlockMirror,
  remainingGroupsAfterUnshare,
} = require('../src/lib/eventTombstone.js')

const EVENT = 'evt-1'
const GROUP_A = 'ga'
const GROUP_B = 'gb'

// ── groupDeletedKey ───────────────────────────────────────────────────────
test('groupDeletedKey namespaces by group then event', () => {
  assert.equal(groupDeletedKey(GROUP_A, EVENT), 'deletedInGroup:ga:evt-1')
})
test('groupDeletedKey stays clear of the deleted: retention prefix', () => {
  // The sweeps iterate `deleted:` and parse the remainder as an event id; a
  // group-scoped key landing in there would be misread as one.
  assert.ok(!groupDeletedKey(GROUP_A, EVENT).startsWith('deleted:'))
})
test('groupDeletedKey is distinct per group for the same event', () => {
  assert.notEqual(groupDeletedKey(GROUP_A, EVENT), groupDeletedKey(GROUP_B, EVENT))
})

// ── isGroupScopedDelete ───────────────────────────────────────────────────
test('isGroupScopedDelete true only for scope:group event dels', () => {
  assert.equal(isGroupScopedDelete({ type: 'event', scope: 'group' }), true)
})
test('isGroupScopedDelete false when scope absent (pre-#122 op = real delete)', () => {
  assert.equal(isGroupScopedDelete({ type: 'event' }), false)
})
test('isGroupScopedDelete false for non-event types even when scoped', () => {
  assert.equal(isGroupScopedDelete({ type: 'rsvp', scope: 'group' }), false)
})
test('isGroupScopedDelete tolerates null/undefined ops', () => {
  assert.equal(isGroupScopedDelete(null), false)
  assert.equal(isGroupScopedDelete(undefined), false)
})

// ── shouldBlockMirror ─────────────────────────────────────────────────────
test('global tombstone blocks the mirror', () => {
  assert.equal(shouldBlockMirror({ globalTombstone: { ts: 1 }, scopedTombstone: null }), true)
})
test('scoped tombstone blocks its own group', () => {
  assert.equal(shouldBlockMirror({ globalTombstone: null, scopedTombstone: { ts: 1 } }), true)
})
test('no tombstone allows the mirror', () => {
  assert.equal(shouldBlockMirror({ globalTombstone: null, scopedTombstone: null }), false)
})
test('THE #122 REGRESSION: unshare from group A must not block group B', () => {
  // Caller passes the tombstone it looked up for the group being mirrored. The
  // unshare wrote deletedInGroup:ga:evt-1, so mirroring into gb finds nothing
  // and the moved copy survives. Before #122 this was a global key and returned
  // true here, deleting the event everywhere but the authoring device.
  assert.equal(shouldBlockMirror({ globalTombstone: null, scopedTombstone: null }), false)
})

// ── remainingGroupsAfterUnshare ───────────────────────────────────────────
test('remainingGroupsAfterUnshare keeps the other groups', () => {
  assert.deepEqual(remainingGroupsAfterUnshare([GROUP_A, GROUP_B], GROUP_A), [GROUP_B])
})
test('remainingGroupsAfterUnshare empties when it was the last group', () => {
  assert.deepEqual(remainingGroupsAfterUnshare([GROUP_A], GROUP_A), [])
})
test('remainingGroupsAfterUnshare is a no-op for an unrelated group', () => {
  assert.deepEqual(remainingGroupsAfterUnshare([GROUP_A], GROUP_B), [GROUP_A])
})
test('remainingGroupsAfterUnshare tolerates missing groups[]', () => {
  assert.deepEqual(remainingGroupsAfterUnshare(undefined, GROUP_A), [])
  assert.deepEqual(remainingGroupsAfterUnshare(null, GROUP_A), [])
})
test('remainingGroupsAfterUnshare removes duplicates of the same group', () => {
  assert.deepEqual(remainingGroupsAfterUnshare([GROUP_A, GROUP_A, GROUP_B], GROUP_A), [GROUP_B])
})
