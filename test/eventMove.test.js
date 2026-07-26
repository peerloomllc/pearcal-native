// Issue #264: editing an event's date hid it from the calendar until restart.
// These cover the pure decisions extracted to src/lib/eventMove.js.
// (bugfix/event-date-move)
const test = require('node:test')
const assert = require('node:assert/strict')
const {
  eventKey,
  movedFromDate,
  planEventWrite,
  personalAppendValue,
} = require('../src/lib/eventMove.js')

const ID = 'evt-1'
const OLD = '2026-07-24'
const NEW = '2026-07-25'

// ── eventKey ──────────────────────────────────────────────────────────────
test('eventKey matches the events:{date}:{id} row shape bare.js writes', () => {
  assert.equal(eventKey(NEW, ID), 'events:2026-07-25:evt-1')
})

// ── movedFromDate ─────────────────────────────────────────────────────────
test('movedFromDate returns the vacated date on a real move', () => {
  assert.equal(movedFromDate({ id: ID, date: NEW, _prevDate: OLD }), OLD)
})
test('movedFromDate returns null for an ordinary in-place save', () => {
  assert.equal(movedFromDate({ id: ID, date: NEW }), null)
})
test('movedFromDate returns null when _prevDate echoes the unchanged date', () => {
  // The editor sends _prevDate on every save, not only date changes.
  assert.equal(movedFromDate({ id: ID, date: NEW, _prevDate: NEW }), null)
})
test('movedFromDate tolerates missing fields and null events', () => {
  assert.equal(movedFromDate(null), null)
  assert.equal(movedFromDate({ _prevDate: OLD }), null)
  assert.equal(movedFromDate({ id: ID, _prevDate: OLD }), null)
})

// ── planEventWrite ────────────────────────────────────────────────────────
test('a move writes the new row and drops only the vacated one', () => {
  const plan = planEventWrite({ id: ID, date: NEW, _prevDate: OLD })
  assert.equal(plan.movedFrom, OLD)
  assert.equal(plan.putKey, 'events:2026-07-25:evt-1')
  assert.deepEqual(plan.delKeys, ['events:2026-07-24:evt-1'])
})
test('a move NEVER tombstones the event id', () => {
  // The regression itself: a delete-then-put left `deleted:evt-1` behind, which
  // blocked the just-written row from mirroring and deleted it outright on a
  // paired sibling device.
  const plan = planEventWrite({ id: ID, date: NEW, _prevDate: OLD })
  assert.deepEqual(plan.tombstoneKeys, [])
})
test('any save clears a stale tombstone for its id', () => {
  // Heals events already moved by an earlier build, whose leftover tombstone
  // still refuses every mirror of a row that is plainly alive locally.
  for (const ev of [{ id: ID, date: NEW, _prevDate: OLD }, { id: ID, date: NEW }]) {
    assert.equal(planEventWrite(ev).clearTombstoneKey, 'deleted:evt-1')
  }
})
test('an in-place save touches one key and deletes nothing', () => {
  const plan = planEventWrite({ id: ID, date: NEW })
  assert.equal(plan.movedFrom, null)
  assert.equal(plan.putKey, 'events:2026-07-25:evt-1')
  assert.deepEqual(plan.delKeys, [])
})
test('the deleted row is never also the row being written', () => {
  for (const ev of [
    { id: ID, date: NEW, _prevDate: OLD },
    { id: ID, date: NEW, _prevDate: NEW },
    { id: ID, date: NEW },
  ]) {
    const plan = planEventWrite(ev)
    assert.ok(!plan.delKeys.includes(plan.putKey))
  }
})

// ── personalAppendValue ───────────────────────────────────────────────────
test('a move carries _prevDate to siblings so they relocate their row', () => {
  const stored = { id: ID, date: NEW, title: 'Dentist' }
  assert.deepEqual(personalAppendValue(stored, OLD), { ...stored, _prevDate: OLD })
})
test('a non-move append carries no _prevDate at all', () => {
  const stored = { id: ID, date: NEW, title: 'Dentist' }
  const value = personalAppendValue(stored, null)
  assert.equal('_prevDate' in value, false)
  assert.deepEqual(value, stored)
})
test('personalAppendValue does not mutate the stored row', () => {
  // The same object is written to the local DB, which must stay _prevDate-free.
  const stored = { id: ID, date: NEW }
  personalAppendValue(stored, OLD)
  assert.equal('_prevDate' in stored, false)
})
