// Computes today's events payload for the home-screen widget cache.
// Called from bare.js after every mutation; the payload is sent to RN,
// which writes it to the native widget cache location.

function pad (n) { return String(n).padStart(2, '0') }

function dateStringFor (d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function todayDateString () {
  return dateStringFor(new Date())
}

function tomorrowDateString () {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  return dateStringFor(d)
}

// A multi-day event is stored as ONE record under its START date carrying an
// `endDate`, so a span in progress lies outside today's key range. Bound how far
// back readSpanningEvents looks for one: a single range scan, wide enough for any
// realistic trip or holiday, rather than an unbounded walk to the first event ever.
const SPAN_LOOKBACK_DAYS = 370

// How many future events to put in the cache. The widgets each take a prefix of
// this sized to the space they have, so it only needs to cover the largest of
// them (an iOS .systemLarge or a resized Android widget), not the small ones.
const UPCOMING_LIMIT = 10

// How many days the cache covers, starting with today. Only the app can compute
// this payload (the events live in the worklet's Hyperbee), and the app may not
// run for days, so it hands the widgets a week at a time and they pick out the
// current day themselves at render. With one day only, the widget kept drawing
// yesterday's events under today's header until something opened the app.
const CACHE_DAYS = 8

function daysAheadDateString (n) {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return dateStringFor(d)
}

function daysAgoDateString (n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return dateStringFor(d)
}

function yesterdayDateString () {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  return dateStringFor(d)
}

// A timed event carries only wall-clock start/end against a single date, so an
// end that sorts *before* its start means the event runs past midnight into the
// next day (10pm-12am, a 23:00-07:00 shift).
function wrapsPastMidnight (value) {
  return !!(value.start && value.end && value.end < value.start)
}

function normalize (value) {
  // `colors` (2–3 hex entries) paints a segmented strip in the widget — used by
  // subscribed holidays like US federal days (red/white/blue). Emit it only when
  // there's a real strip; single-color events keep `color`, and older widget
  // binaries that don't read `colors` fall back to it. (TODO #104)
  const strip = Array.isArray(value.colors) && value.colors.length > 1
    ? value.colors.slice(0, 3)
    : null
  return {
    id: value.id,
    title: value.title || '',
    allDay: !!value.allDay,
    start: value.start || null,
    end: value.end || null,
    location: value.location || null,
    color: (value.colors && value.colors[0]) || value.color || null,
    colors: strip,
  }
}

function byDayOrder (a, b) {
  if (a.allDay && !b.allDay) return -1
  if (!a.allDay && b.allDay) return 1
  return (a.start || '').localeCompare(b.start || '')
}

async function readDayEvents (db, date, { profileId, isInvitedToEvent, ownedGroupIds, nowHHMM }) {
  const gt = 'events:' + date + ':'
  const lt = 'events:' + date + ':\xff'
  // Dedupe by id keeping highest updatedAt — see listEvents in bare.js for why.
  const byId = new Map()
  for await (const { value } of db.createReadStream({ gt, lt })) {
    if (value.isShadow) continue
    if (profileId && isInvitedToEvent && !isInvitedToEvent(value, profileId, ownedGroupIds)) continue
    if (nowHHMM && !value.allDay) {
      // A wrapping event's end string is less than every clock time, so pruning
      // on it would drop the event for its whole day. It stays live until the
      // day is over — never prune it here. (Yesterday's copy of it is picked up
      // separately by readCarriedEvents.)
      const cutoff = wrapsPastMidnight(value) ? null : (value.end || value.start)
      if (cutoff && cutoff < nowHHMM) continue
    }
    const prev = byId.get(value.id)
    if (!prev || (value.updatedAt ?? 0) >= (prev.updatedAt ?? 0)) byId.set(value.id, value)
  }
  return [...byId.values()].map(normalize).sort(byDayOrder)
}

// Multi-day events that started on an earlier day and are still running on one
// of the cached days. Only the start day gets a key (`events:{startDate}:{id}`);
// the span lives in the record's `endDate`, which a later day's key range never
// sees, so without this the widget showed such an event on day one and then
// dropped it for the rest of its run, while the app's own day view
// (`e.date <= d && (e.endDate || e.date) >= d`) kept showing it. (TODO #136)
//
// One range scan for the whole cache window, bucketed per day by `spansOn`, so
// a week's worth of days costs the same single scan one day used to.
async function readSpans (db, toDate, { profileId, isInvitedToEvent, ownedGroupIds }) {
  const gt = 'events:' + daysAgoDateString(SPAN_LOOKBACK_DAYS) + ':'
  const lt = 'events:' + toDate + ':\xff'
  const byId = new Map()
  for await (const { value } of db.createReadStream({ gt, lt })) {
    if (value.isShadow) continue
    // A real span, i.e. one that ends after the day it starts on.
    if (!value.endDate || value.endDate <= value.date) continue
    if (profileId && isInvitedToEvent && !isInvitedToEvent(value, profileId, ownedGroupIds)) continue
    const prev = byId.get(value.id)
    if (!prev || (value.updatedAt ?? 0) >= (prev.updatedAt ?? 0)) byId.set(value.id, value)
  }
  return [...byId.values()]
}

// The spans covering `date`, excluding any that start on it: those already come
// from readDayEvents and would otherwise be listed twice. `endDate` is
// inclusive, so a span ending on `date` still runs that day.
function spansOn (spans, date) {
  return spans.filter(v => v.date < date && v.endDate >= date).map(normalize)
}

// Yesterday's events that run past midnight and are *still* running right now.
// A 23:00-07:00 shift is live at 00:30 today, but it is keyed under the date it
// started, so today's key range alone would lose it the moment the day rolls
// over. (TODO #114)
async function readCarriedEvents (db, date, { profileId, isInvitedToEvent, ownedGroupIds, nowHHMM }) {
  const gt = 'events:' + date + ':'
  const lt = 'events:' + date + ':\xff'
  const byId = new Map()
  for await (const { value } of db.createReadStream({ gt, lt })) {
    if (value.isShadow) continue
    if (value.allDay || !wrapsPastMidnight(value)) continue
    if (!nowHHMM || value.end <= nowHHMM) continue  // already ended earlier today
    if (profileId && isInvitedToEvent && !isInvitedToEvent(value, profileId, ownedGroupIds)) continue
    const prev = byId.get(value.id)
    if (!prev || (value.updatedAt ?? 0) >= (prev.updatedAt ?? 0)) byId.set(value.id, value)
  }
  const out = [...byId.values()].map(v => ({ ...normalize(v), carried: true }))
  out.sort((a, b) => (a.start || '').localeCompare(b.start || ''))
  return out
}

// A carried event began yesterday, so it precedes everything that starts today —
// but all-day rows still head the list. The widgets read `carried` to label the
// row by when it *ends* ("Until 7:00 AM") rather than by a start time that is no
// longer today's.
function mergeCarried (events, carried) {
  if (carried.length === 0) return events
  const firstTimed = events.findIndex(e => !e.allDay)
  const cut = firstTimed === -1 ? events.length : firstTimed
  return [...events.slice(0, cut), ...carried, ...events.slice(cut)]
}

// Next `limit` events on or after `fromDate`, in chronological order, each
// carrying its `date` so the widget can show a weekday label (TODO #107).
// The keyspace is date-ordered (events:{date}:{id}), so the earliest dates
// stream first; we read a small surplus then sort to order within a day.
async function readUpcomingEvents (db, fromDate, limit, { profileId, isInvitedToEvent, ownedGroupIds }) {
  const gt = 'events:' + fromDate + ':'
  const lt = 'events:\xff'
  const byId = new Map()
  for await (const { value } of db.createReadStream({ gt, lt })) {
    if (value.isShadow) continue
    if (profileId && isInvitedToEvent && !isInvitedToEvent(value, profileId, ownedGroupIds)) continue
    const prev = byId.get(value.id)
    if (!prev || (value.updatedAt ?? 0) >= (prev.updatedAt ?? 0)) byId.set(value.id, value)
    if (byId.size >= limit * 4) break  // enough to cover the earliest day(s)
  }
  const out = [...byId.values()].map(v => ({ ...normalize(v), date: v.date }))
  out.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date)
    if (a.allDay && !b.allDay) return -1
    if (!a.allDay && b.allDay) return 1
    return (a.start || '').localeCompare(b.start || '')
  })
  return out.slice(0, limit)
}

function buildSlots (events) {
  const slots = []
  let i = 0
  while (i < events.length) {
    const a = events[i]
    const b = events[i + 1]
    if (b && !a.allDay && !b.allDay && !a.carried && !b.carried && a.start && a.start === b.start) {
      slots.push([i, i + 1])
      i += 2
    } else {
      slots.push([i])
      i += 1
    }
  }
  return slots
}

// One day of the cache: that day's own events, any multi-day span running
// through it and anything carried over from the night before, in the order the
// widgets draw them.
//
// `nowHHMM` is passed only for today. It prunes events that have already ended,
// which is meaningless for a day that has not started yet: a future day is
// cached whole.
async function computeDay (db, date, prevDate, spans, opts) {
  const own = await readDayEvents(db, date, opts)
  const carried = await readCarriedEvents(db, prevDate, {
    ...opts,
    // Nothing has ended yet on a day that has not begun, so keep every wrapping
    // event from the night before. readCarriedEvents drops them all when this is
    // empty, so a future day needs a real floor rather than no time at all.
    nowHHMM: opts.nowHHMM || '00:00',
  })
  const events = mergeCarried([...own, ...spansOn(spans, date)].sort(byDayOrder), carried)
  return { date, events, slots: buildSlots(events) }
}

async function computeTodayCache (db, { profileId, isInvitedToEvent, ownedGroupIds, use24h, widgetShowUpcoming } = {}) {
  const date = todayDateString()
  const now = new Date()
  const nowHHMM = `${pad(now.getHours())}:${pad(now.getMinutes())}`
  const who = { profileId, isInvitedToEvent, ownedGroupIds }
  const spans = await readSpans(db, daysAheadDateString(CACHE_DAYS - 1), who)
  // Today first, then the rest of the window. The widgets render whichever entry
  // matches the date they wake up on, so the day rolls over without the app.
  const days = []
  for (let i = 0; i < CACHE_DAYS; i++) {
    days.push(await computeDay(
      db,
      daysAheadDateString(i),
      daysAheadDateString(i - 1),
      spans,
      { ...who, nowHHMM: i === 0 ? nowHHMM : null },
    ))
  }
  const { events, slots } = days[0]
  let tomorrowFirst = null
  let upcoming = null
  if (widgetShowUpcoming) {
    // Surface the next few events across future days *alongside* today's — a
    // holiday (or any event) today no longer hides what's coming up. The widget
    // shows today's events first, then fills remaining space with these.
    const next = await readUpcomingEvents(db, tomorrowDateString(), UPCOMING_LIMIT, who)
    if (next.length > 0) upcoming = next
  } else if (events.length === 0) {
    // Setting off + empty today: keep the lightweight tomorrow-only preview.
    const tomorrow = days[1]?.events ?? []
    if (tomorrow.length > 0) tomorrowFirst = tomorrow[0]
  }
  // `events`/`slots`/`tomorrowFirst` repeat day one. They are what a widget
  // binary older than the cache file reads, and dropping them would blank the
  // widget between installing an update and the app's next write.
  return { date, generatedAt: Date.now(), events, slots, tomorrowFirst, upcoming, days, use24h: use24h ?? null }
}

module.exports = { computeTodayCache, todayDateString }
