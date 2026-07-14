// Unit tests for the widget cache's "already finished" prune (src/widget-cache.js).
//
// A timed event carries only wall-clock start/end against a single date, so an
// event that runs past midnight has an end that sorts *before* every clock time
// ("22:00" -> "00:00"). Pruning naively on `end < now` dropped such events from
// the widget for their entire day.
const test = require('node:test')
const assert = require('node:assert/strict')
const { mock } = require('node:test')
const { computeTodayCache, todayDateString } = require('../src/widget-cache')

// Freeze the clock at a local wall-clock time so `nowHHMM` is timezone-stable.
function freezeAt (h, m) {
  mock.timers.enable({ apis: ['Date'], now: new Date(2026, 6, 14, h, m, 0).getTime() })
}

function dbWith (events) {
  const date = todayDateString()
  const rows = events.map(e => ({ key: `events:${date}:${e.id}`, value: { date, updatedAt: 1, ...e } }))
  return {
    createReadStream ({ gt, lt }) {
      const hits = rows.filter(r => r.key > gt && r.key < lt)
      return (async function * () { for (const r of hits) yield r })()
    },
  }
}

async function idsAt (h, m, events) {
  freezeAt(h, m)
  try {
    const cache = await computeTodayCache(dbWith(events), {})
    return cache.events.map(e => e.id)
  } finally {
    mock.timers.reset()
  }
}

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
