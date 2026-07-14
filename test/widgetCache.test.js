// Unit tests for the widget cache's day window (src/widget-cache.js).
//
// A timed event carries only wall-clock start/end against a single date, so an
// event that runs past midnight has an end that sorts *before* every clock time
// ("22:00" -> "00:00"). Two consequences, both covered here:
//   * pruning naively on `end < now` dropped such an event for its entire day;
//   * such an event is keyed under the day it *started*, so once the day rolls
//     over it falls outside today's key range while still running (TODO #114).
const test = require('node:test')
const assert = require('node:assert/strict')
const { mock } = require('node:test')
const { computeTodayCache } = require('../src/widget-cache')

const TODAY = '2026-07-14'
const YESTERDAY = '2026-07-13'

// Freeze the clock at a local wall-clock time on TODAY so `nowHHMM` is
// timezone-stable regardless of where the suite runs.
function freezeAt (h, m) {
  mock.timers.enable({ apis: ['Date'], now: new Date(2026, 6, 14, h, m, 0).getTime() })
}

function dbWith (events) {
  const rows = events.map(({ date = TODAY, ...e }) => ({
    key: `events:${date}:${e.id}`,
    value: { date, updatedAt: 1, ...e },
  }))
  return {
    createReadStream ({ gt, lt }) {
      const hits = rows.filter(r => r.key > gt && r.key < lt)
      return (async function * () { for (const r of hits) yield r })()
    },
  }
}

async function cacheAt (h, m, events) {
  freezeAt(h, m)
  try {
    return await computeTodayCache(dbWith(events), {})
  } finally {
    mock.timers.reset()
  }
}

async function idsAt (h, m, events) {
  return (await cacheAt(h, m, events)).events.map(e => e.id)
}

// --- pruning: an event that runs past midnight must survive its own day -------

test('an event ending at midnight survives all day (10pm-12am)', async () => {
  const ev = [{ id: 'midnight', title: 'Party', start: '22:00', end: '00:00' }]
  assert.deepEqual(await idsAt(13, 30, ev), ['midnight'], 'afternoon')
  assert.deepEqual(await idsAt(22, 30, ev), ['midnight'], 'while it is running')
  assert.deepEqual(await idsAt(23, 59, ev), ['midnight'], 'one minute before it ends')
})

test('an overnight event survives all day (11pm-7am)', async () => {
  const ev = [{ id: 'shift', title: 'Night shift', start: '23:00', end: '07:00' }]
  assert.deepEqual(await idsAt(13, 30, ev), ['shift'])
  assert.deepEqual(await idsAt(23, 30, ev), ['shift'])
})

test('an ordinary event is still pruned once it has ended', async () => {
  const ev = [{ id: 'past', title: 'Standup', start: '09:00', end: '10:00' }]
  assert.deepEqual(await idsAt(10, 1, ev), [], 'ended')
  assert.deepEqual(await idsAt(9, 30, ev), ['past'], 'still running')
  assert.deepEqual(await idsAt(8, 0, ev), ['past'], 'upcoming')
})

test('an event ending at 23:55 is kept until 23:55 (the user-reported comparison)', async () => {
  const ev = [{ id: 'late', title: 'Party', start: '22:00', end: '23:55' }]
  assert.deepEqual(await idsAt(13, 30, ev), ['late'])
  assert.deepEqual(await idsAt(23, 56, ev), [])
})

test('a zero-length event is not treated as wrapping past midnight', async () => {
  const ev = [{ id: 'zero', title: 'Marker', start: '09:00', end: '09:00' }]
  assert.deepEqual(await idsAt(8, 0, ev), ['zero'], 'upcoming')
  assert.deepEqual(await idsAt(9, 1, ev), [], 'passed')
})

test('all-day events are never pruned by time of day', async () => {
  const ev = [{ id: 'holiday', title: 'Holiday', allDay: true, start: '00:00', end: '00:00' }]
  assert.deepEqual(await idsAt(23, 30, ev), ['holiday'])
})

test('a wrapping event sorts alongside the rest of the day by start time', async () => {
  const ids = await idsAt(12, 0, [
    { id: 'midnight', title: 'Party', start: '22:00', end: '00:00' },
    { id: 'dinner', title: 'Dinner', start: '19:00', end: '20:00' },
    { id: 'allday', title: 'Holiday', allDay: true },
  ])
  assert.deepEqual(ids, ['allday', 'dinner', 'midnight'])
})

// --- carry-over: yesterday's event that is still running now (TODO #114) ------

const SHIFT = { id: 'shift', title: 'Night shift', start: '23:00', end: '07:00', date: YESTERDAY }

test("yesterday's overnight event is carried onto today while it is still running", async () => {
  assert.deepEqual(await idsAt(0, 30, [SHIFT]), ['shift'], 'just after midnight')
  assert.deepEqual(await idsAt(6, 59, [SHIFT]), ['shift'], 'one minute before it ends')
})

test("yesterday's overnight event drops off once it has ended", async () => {
  assert.deepEqual(await idsAt(7, 0, [SHIFT]), [], 'exactly at its end')
  assert.deepEqual(await idsAt(9, 0, [SHIFT]), [], 'later that morning')
})

test('a carried event is flagged so the widget can label it by its end time', async () => {
  const cache = await cacheAt(0, 30, [SHIFT])
  assert.equal(cache.events.length, 1)
  assert.equal(cache.events[0].carried, true)
  assert.equal(cache.events[0].end, '07:00')
})

test("yesterday's event that ended at midnight is not carried over", async () => {
  const ev = [{ id: 'party', title: 'Party', start: '22:00', end: '00:00', date: YESTERDAY }]
  assert.deepEqual(await idsAt(0, 30, ev), [], 'it ended exactly at midnight')
})

test("yesterday's ordinary and all-day events are never carried over", async () => {
  const ids = await idsAt(0, 30, [
    { id: 'dinner', title: 'Dinner', start: '19:00', end: '20:00', date: YESTERDAY },
    { id: 'holiday', title: 'Holiday', allDay: true, date: YESTERDAY },
  ])
  assert.deepEqual(ids, [])
})

test('a carried event leads the timed rows but still trails all-day rows', async () => {
  const cache = await cacheAt(0, 30, [
    SHIFT,
    { id: 'allday', title: 'Holiday', allDay: true },
    { id: 'breakfast', title: 'Breakfast', start: '08:00', end: '09:00' },
  ])
  assert.deepEqual(cache.events.map(e => e.id), ['allday', 'shift', 'breakfast'])
})

test('a carried event is never paired side-by-side with a same-start event', async () => {
  // Both read 23:00, but the carried one began yesterday — pairing them into one
  // slot would render them as concurrent events.
  const cache = await cacheAt(0, 30, [
    SHIFT,
    { id: 'tonight', title: 'Tonight', start: '23:00', end: '23:30' },
  ])
  assert.deepEqual(cache.events.map(e => e.id), ['shift', 'tonight'])
  assert.deepEqual(cache.slots, [[0], [1]], 'each event gets its own row')
})
