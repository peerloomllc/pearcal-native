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


// --- multi-day spans: one record on the start date, live until endDate (#136) -

// Stored once under its start date; only `endDate` says it is still running. The
// user-reported case: "begins on a day and ends a day or more later, the widget
// ignores this date" - while the same thing entered as a recurring event worked,
// because recurrence materialises a separate record per occurrence date.
const TRIP = { id: 'trip', title: 'Ski Trip', allDay: true, date: '2026-07-12', endDate: '2026-07-16' }

test('a multi-day event shows on a day in the middle of its span', async () => {
  assert.deepEqual(await idsAt(10, 0, [TRIP]), ['trip'])
})

test('a multi-day event shows on its final day and drops off after it', async () => {
  const endsToday = { ...TRIP, endDate: TODAY }
  assert.deepEqual(await idsAt(10, 0, [endsToday]), ['trip'], 'endDate is inclusive')
  const endedYesterday = { ...TRIP, endDate: YESTERDAY }
  assert.deepEqual(await idsAt(10, 0, [endedYesterday]), [], 'the span is over')
})

test('a multi-day event still shows exactly once on its start day', async () => {
  // Today's key range already yields it; the span scan must not add a second copy.
  const startsToday = { ...TRIP, date: TODAY, endDate: '2026-07-18' }
  assert.deepEqual(await idsAt(10, 0, [startsToday]), ['trip'])
})

test('an earlier single-day event is not mistaken for a span', async () => {
  const ids = await idsAt(10, 0, [
    { id: 'past', title: 'Last week', allDay: true, date: '2026-07-10' },
    { id: 'sameday', title: 'Same day', allDay: true, date: '2026-07-10', endDate: '2026-07-10' },
    { id: 'bogus', title: 'Backwards', allDay: true, date: '2026-07-10', endDate: '2026-07-09' },
  ])
  assert.deepEqual(ids, [], 'no endDate, an equal endDate and a backwards one are all single-day')
})

test('a spanning event is not resurrected from beyond the lookback window', async () => {
  // Guards the one range scan from becoming an unbounded walk to the first event
  // ever stored. A span older than SPAN_LOOKBACK_DAYS is out of scope by design.
  const ancient = { id: 'ancient', title: 'Ancient', allDay: true, date: '2020-01-01', endDate: '2030-01-01' }
  assert.deepEqual(await idsAt(10, 0, [ancient]), [])
})

test('a spanning event leads the day alongside the other all-day rows', async () => {
  const cache = await cacheAt(10, 0, [
    { id: 'standup', title: 'Standup', start: '09:30', end: '17:00' },
    TRIP,
    { id: 'holiday', title: 'Holiday', allDay: true },
  ])
  assert.deepEqual(cache.events.map(e => e.id), ['holiday', 'trip', 'standup'])
})

test('a shadow copy of a spanning event is ignored', async () => {
  assert.deepEqual(await idsAt(10, 0, [{ ...TRIP, isShadow: true }]), [])
})

test('a spanning event is never pruned by the time of day', async () => {
  assert.deepEqual(await idsAt(23, 59, [TRIP]), ['trip'], 'still live late on an intermediate day')
})

// --- upcoming: enough for the largest widget to draw from (#137) --------------

test('more than three upcoming events reach the cache', async () => {
  // The widgets each take a prefix sized to their own space, so the cache has to
  // carry enough for the largest of them. It used to stop at 3, which capped every
  // widget at 3 no matter how much room it had.
  const future = []
  for (let d = 15; d <= 27; d++) {
    future.push({ id: 'e' + d, title: 'Day ' + d, allDay: true, date: '2026-07-' + d })
  }
  const cache = await cacheAt(10, 0, future)
  assert.equal(cache.upcoming, null, 'off by default, the setting gates it')

  mock.timers.enable({ apis: ['Date'], now: new Date(2026, 6, 14, 10, 0, 0).getTime() })
  try {
    const on = await computeTodayCache(dbWith(future), { widgetShowUpcoming: true })
    assert.equal(on.upcoming.length, 10, 'capped at UPCOMING_LIMIT, not 3')
    assert.deepEqual(on.upcoming.slice(0, 3).map(e => e.id), ['e15', 'e16', 'e17'], 'still chronological')
  } finally {
    mock.timers.reset()
  }
})

// --- the cached day window: the widget picks its own day (#174) ---------------
//
// Only the app can build this payload, and the app can go days without running.
// The widget used to be handed one day and drew it whatever the date was, so
// after midnight it showed yesterday's events under today's header until
// something opened the app. It now gets a week and selects the matching day.

test('the cache carries eight consecutive days, starting with today', async () => {
  const cache = await cacheAt(10, 0, [])
  assert.equal(cache.days.length, 8)
  assert.deepEqual(cache.days.map(d => d.date), [
    '2026-07-14', '2026-07-15', '2026-07-16', '2026-07-17',
    '2026-07-18', '2026-07-19', '2026-07-20', '2026-07-21',
  ])
})

test('day one repeats the top-level events, so an older widget still draws', async () => {
  const cache = await cacheAt(10, 0, [
    { id: 'a', title: 'Standup', start: '11:00', end: '11:30' },
    { id: 'b', title: 'Lunch', start: '12:00', end: '13:00' },
  ])
  assert.deepEqual(cache.days[0].events, cache.events)
  assert.deepEqual(cache.days[0].slots, cache.slots)
  assert.equal(cache.days[0].date, cache.date)
})

test('each day carries its own events and no other day\'s', async () => {
  const cache = await cacheAt(10, 0, [
    { id: 'today', title: 'Today', start: '11:00', end: '12:00' },
    { id: 'tue', title: 'Tuesday', start: '09:00', end: '10:00', date: '2026-07-16' },
  ])
  assert.deepEqual(cache.days[0].events.map(e => e.id), ['today'])
  assert.deepEqual(cache.days[1].events.map(e => e.id), [])
  assert.deepEqual(cache.days[2].events.map(e => e.id), ['tue'])
})

test('a future day is cached whole, not pruned by the time of day', async () => {
  // 09:00 tomorrow has not happened at 23:00 tonight. Pruning on the clock is
  // only right for today, and applying it across the window would have emptied
  // tomorrow before it arrived.
  const cache = await cacheAt(23, 0, [
    { id: 'early', title: 'Early', start: '09:00', end: '10:00', date: '2026-07-15' },
    { id: 'gone', title: 'Gone', start: '09:00', end: '10:00' },
  ])
  assert.deepEqual(cache.days[0].events.map(e => e.id), [], 'today still prunes what has ended')
  assert.deepEqual(cache.days[1].events.map(e => e.id), ['early'])
})

test('a multi-day span appears on every day it covers', async () => {
  const cache = await cacheAt(10, 0, [
    { id: 'trip', title: 'Trip', allDay: true, date: '2026-07-15', endDate: '2026-07-17' },
  ])
  const has = i => cache.days[i].events.some(e => e.id === 'trip')
  assert.equal(has(0), false, 'has not started')
  assert.equal(has(1), true, 'its own start day, from the day read')
  assert.equal(has(2), true, 'an intermediate day, from the span read')
  assert.equal(has(3), true, 'the last day, endDate is inclusive')
  assert.equal(has(4), false, 'over')
})

test('an overnight event carries onto the next cached day', async () => {
  const cache = await cacheAt(10, 0, [
    { id: 'shift', title: 'Night shift', start: '22:00', end: '07:00', date: '2026-07-16' },
  ])
  assert.deepEqual(cache.days[2].events.map(e => e.id), ['shift'], 'the day it starts')
  const next = cache.days[3].events
  assert.deepEqual(next.map(e => e.id), ['shift'], 'still running the morning after')
  assert.equal(next[0].carried, true, 'labelled by when it ends, not when it started')
})

test('the tomorrow preview comes from the cached day, not a separate read', async () => {
  const cache = await cacheAt(10, 0, [
    { id: 'tmw', title: 'Dentist', start: '09:00', end: '10:00', date: '2026-07-15' },
  ])
  assert.equal(cache.events.length, 0)
  assert.equal(cache.tomorrowFirst.id, 'tmw')
})
