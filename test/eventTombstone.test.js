// TODO #122 — moving an event between groups must not destroy it. These test the
// pure decisions extracted to src/lib/eventTombstone.js.
// (bugfix/group-scoped-event-tombstones)
const test = require('node:test')
const assert = require('node:assert/strict')
const {
  groupDeletedKey,
  isGroupScopedDelete,
  shouldBlockMirror,
  shouldClearScopedTombstone,
  eventIdFromKey,
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

// ── shouldClearScopedTombstone (TODO #141) ────────────────────────────────
// The tombstone was write-once and delete-never, and written only on devices
// that did NOT author the unshare. So re-sharing an event into a group it had
// been unshared from came back for the editor and for nobody else, forever.

test('THE #141 REGRESSION: a re-share after the unshare lifts the block', () => {
  // The whole bug in one line. Without this the event never returns for any
  // member except the one who made the edit.
  assert.equal(shouldClearScopedTombstone({
    tombstone: { delAt: 1000, ts: 1000, groupId: GROUP_A },
    putUpdatedAt: 2000,
  }), true)
})

test('a STALE put authored before the unshare must NOT resurrect it', () => {
  // The case that makes the timestamp comparison necessary rather than just
  // deleting the key on any put: Autobase can linearise a put authored earlier
  // by another writer AFTER the del has already applied.
  assert.equal(shouldClearScopedTombstone({
    tombstone: { delAt: 2000, ts: 2000, groupId: GROUP_A },
    putUpdatedAt: 1000,
  }), false)
})

test('a same-millisecond tie goes to the re-share', () => {
  assert.equal(shouldClearScopedTombstone({
    tombstone: { delAt: 1500, ts: 1500 }, putUpdatedAt: 1500,
  }), true)
})

test('nothing to clear when no tombstone exists', () => {
  assert.equal(shouldClearScopedTombstone({ tombstone: null, putUpdatedAt: 1 }), false)
  assert.equal(shouldClearScopedTombstone({ tombstone: undefined, putUpdatedAt: 1 }), false)
})

test('an unorderable pair clears, because a lost event is the worse failure', () => {
  // A del from a build predating `delAt`, or a put with no updatedAt. Both are
  // real: `delAt` is new in this change, so every tombstone already on disk
  // lacks it. Clearing is the deliberate choice - see the comment on the
  // function. Refusing would leave those events invisible for good.
  assert.equal(shouldClearScopedTombstone({
    tombstone: { ts: 5000, groupId: GROUP_A },   // pre-#141 shape, no delAt
    putUpdatedAt: 1000,
  }), true)
  assert.equal(shouldClearScopedTombstone({
    tombstone: { delAt: 5000 }, putUpdatedAt: undefined,
  }), true)
})

test('the tombstone`s own ts is NOT used for ordering', () => {
  // `ts` is the applying device's clock at apply time; `delAt` is the author's.
  // Using ts would compare two machines' clocks. Pin it: a tombstone whose ts
  // is far in the future must not block a re-share that postdates the delAt.
  assert.equal(shouldClearScopedTombstone({
    tombstone: { delAt: 1000, ts: 9_999_999 },
    putUpdatedAt: 2000,
  }), true)
})

test('clearing is per group: the other group`s tombstone is untouched', () => {
  // Not a property of this function alone but of how it is keyed, so assert the
  // pairing that matters: the caller looks up by groupDeletedKey(group, event).
  assert.notEqual(groupDeletedKey(GROUP_A, EVENT), groupDeletedKey(GROUP_B, EVENT))
})

test('a cleared tombstone stops blocking the mirror', () => {
  // The two decisions have to compose: clearing is only meaningful because
  // shouldBlockMirror reads the absence.
  assert.equal(shouldBlockMirror({ globalTombstone: null, scopedTombstone: null }), false)
})

test('a GLOBAL delete still wins after a re-share clears the scoped one', () => {
  // Deleting for everyone must not become undoable by a stray put. The scoped
  // clear cannot touch the global key, and shouldBlockMirror checks global first.
  assert.equal(shouldBlockMirror({ globalTombstone: { ts: 1 }, scopedTombstone: null }), true)
})

// ── writer and clearer must derive the same id (TODO #141) ────────────────
// The del branch writes the tombstone keyed by eventIdFromKey(op.key); the
// re-share clears it the same way. mirrorToLocal, meanwhile, READS the block
// keyed by value.id. All three have to agree or the key written is not the key
// cleared, and the fix would silently do nothing for the shapes that disagree.

test('eventIdFromKey survives the colons in a shadow id', () => {
  // The reason split(':').pop() is wrong: it would return 'gid'.
  assert.equal(eventIdFromKey('events:2026-07-28:shadow:src:fwd:gid'), 'shadow:src:fwd:gid')
})

test('eventIdFromKey matches value.id for every event shape we store', () => {
  // Pins the assumption the clear depends on. If a future key layout breaks
  // this, the tombstone written on unshare stops matching the one cleared on
  // re-share and #141 comes back silently.
  const shapes = [
    { key: 'events:2026-07-28:evt-1',                 id: 'evt-1' },
    { key: 'events:2026-07-28:shadow:src:fwd:gid',    id: 'shadow:src:fwd:gid' },
    { key: 'events:2026-07-28:evt-1:2026-08-01',      id: 'evt-1:2026-08-01' },
  ]
  for (const { key, id } of shapes) assert.equal(eventIdFromKey(key), id, key)
})

test('eventIdFromKey is total: degenerate keys do not throw', () => {
  assert.equal(eventIdFromKey('evt-1'), 'evt-1')
  assert.equal(eventIdFromKey('events:evt-1'), 'evt-1')
})

test('the key cleared on re-share is the key written on unshare', () => {
  // End to end over the pair, on the shape most likely to break it.
  const opKey = 'events:2026-07-28:shadow:src:fwd:gid'
  const written = groupDeletedKey(GROUP_A, eventIdFromKey(opKey))
  const cleared = groupDeletedKey(GROUP_A, eventIdFromKey(opKey))
  assert.equal(written, cleared)
  assert.equal(written, 'deletedInGroup:ga:shadow:src:fwd:gid')
})
