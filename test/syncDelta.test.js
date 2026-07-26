// TODO #141(a) - the debounced sync-delta merge must respect ORDER, not always
// let a removal win. Pure logic in src/lib/syncDelta.js.
// (bugfix/sync-delta-merge-order)
const test = require('node:test')
const assert = require('node:assert/strict')
const { mergeSyncDelta } = require('../src/lib/syncDelta.js')

const ev = (id, extra = {}) => ({ id, title: id, ...extra })

// ── the regression this exists for ────────────────────────────────────────
test('a later change beats an earlier removal of the same id', () => {
  // The #264 shape: something removes an id, then the same window re-writes it.
  // The re-write is the newer truth and must survive.
  const out = mergeSyncDelta({ removedIds: ['e1'] }, { changedEvents: [ev('e1')] })
  assert.deepEqual(out.changedEvents, [ev('e1')])
  assert.equal(out.removedIds, undefined)
})
test('a later removal still beats an earlier change of the same id', () => {
  // The original behaviour, which was correct and must not regress.
  const out = mergeSyncDelta({ changedEvents: [ev('e1')] }, { removedIds: ['e1'] })
  assert.deepEqual(out.removedIds, ['e1'])
  assert.equal(out.changedEvents, undefined)
})

// ── unrelated ids are unaffected either way ───────────────────────────────
test('a removal does not touch changes to other ids', () => {
  const out = mergeSyncDelta(
    { changedEvents: [ev('keep'), ev('drop')] },
    { removedIds: ['drop'] }
  )
  assert.deepEqual(out.changedEvents, [ev('keep')])
  assert.deepEqual(out.removedIds, ['drop'])
})
test('a change does not resurrect an unrelated removed id', () => {
  const out = mergeSyncDelta(
    { removedIds: ['gone'] },
    { changedEvents: [ev('other')] }
  )
  assert.deepEqual(out.removedIds, ['gone'])
  assert.deepEqual(out.changedEvents, [ev('other')])
})

// ── the newer copy of an event wins ───────────────────────────────────────
test('two changes to one id keep the later one', () => {
  const out = mergeSyncDelta(
    { changedEvents: [ev('e1', { date: '2026-01-01' })] },
    { changedEvents: [ev('e1', { date: '2026-02-02' })] }
  )
  assert.equal(out.changedEvents.length, 1)
  assert.equal(out.changedEvents[0].date, '2026-02-02')
})
test('a repeated removal stays a single entry', () => {
  const out = mergeSyncDelta({ removedIds: ['e1'] }, { removedIds: ['e1'] })
  assert.deepEqual(out.removedIds, ['e1'])
})

// ── an id never comes out as both ─────────────────────────────────────────
test('no id is ever both changed and removed in one merge', () => {
  const cases = [
    [{ removedIds: ['x'] }, { changedEvents: [ev('x')] }],
    [{ changedEvents: [ev('x')] }, { removedIds: ['x'] }],
    [{ changedEvents: [ev('x')], removedIds: ['x'] }, { changedEvents: [ev('y')] }],
  ]
  for (const [a, b] of cases) {
    const out = mergeSyncDelta(a, b)
    const changedIds = (out.changedEvents ?? []).map(e => e.id)
    for (const id of (out.removedIds ?? [])) {
      assert.ok(!changedIds.includes(id), 'id ' + id + ' is in both for ' + JSON.stringify([a, b]))
    }
  }
})
test('within one delta a change outranks a removal of the same id', () => {
  // Should not arise in practice; pinned so the tie-break is a decision rather
  // than an accident of iteration order.
  const out = mergeSyncDelta({ changedEvents: [ev('x')], removedIds: ['x'] }, null)
  assert.deepEqual(out.changedEvents, [ev('x')])
})

// ── flags and degenerate inputs ───────────────────────────────────────────
test('boolean flags OR together', () => {
  const out = mergeSyncDelta({ groupChanged: true }, { rsvpsChanged: true, fullReload: true })
  assert.equal(out.groupChanged, true)
  assert.equal(out.rsvpsChanged, true)
  assert.equal(out.fullReload, true)
})
test('a null side returns the other unchanged', () => {
  const d = { changedEvents: [ev('e1')] }
  assert.equal(mergeSyncDelta(null, d), d)
  assert.equal(mergeSyncDelta(d, null), d)
})
test('empty deltas merge to an empty delta, not to junk keys', () => {
  assert.deepEqual(mergeSyncDelta({}, {}), {})
})
test('malformed changedEvents entries are skipped rather than throwing', () => {
  const out = mergeSyncDelta({ changedEvents: [null, {}, ev('ok')] }, {})
  assert.deepEqual(out.changedEvents, [ev('ok')])
})
