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

// Multi-day events that started on an earlier day and are still running today.
// Only the start day gets a key (`events:{startDate}:{id}`); the span lives in the
// record's `endDate`, which today's key range never sees, so without this the
// widget showed such an event on day one and then dropped it for the rest of its
// run, while the app's own day view (`e.date <= d && (e.endDate || e.date) >= d`)
// kept showing it. Recurring events were unaffected because each occurrence is
// materialised as its own dated record. (TODO #136)
//
// One range scan over [today - SPAN_LOOKBACK_DAYS, today), so today's own records
// stay the job of readDayEvents and can't be picked up twice.
async function readSpanningEvents (db, date, { profileId, isInvitedToEvent, ownedGroupIds }) {
  const gt = 'events:' + daysAgoDateString(SPAN_LOOKBACK_DAYS) + ':'
  const lt = 'events:' + date + ':'
  const byId = new Map()
  for await (const { value } of db.createReadStream({ gt, lt })) {
    if (value.isShadow) continue
    // A real span that has not finished yet. `endDate` is inclusive, so an event
    // ending today is still live today.
    if (!value.endDate || value.endDate <= value.date) continue
    if (value.endDate < date) continue
    if (profileId && isInvitedToEvent && !isInvitedToEvent(value, profileId, ownedGroupIds)) continue
    const prev = byId.get(value.id)
    if (!prev || (value.updatedAt ?? 0) >= (prev.updatedAt ?? 0)) byId.set(value.id, value)
  }
  return [...byId.values()].map(normalize)
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

async function computeTodayCache (db, { profileId, isInvitedToEvent, ownedGroupIds, use24h, widgetShowUpcoming } = {}) {
  const date = todayDateString()
  const now = new Date()
  const nowHHMM = `${pad(now.getHours())}:${pad(now.getMinutes())}`
  const today = await readDayEvents(db, date, { profileId, isInvitedToEvent, ownedGroupIds, nowHHMM })
  const spanning = await readSpanningEvents(db, date, { profileId, isInvitedToEvent, ownedGroupIds })
  const carried = await readCarriedEvents(db, yesterdayDateString(), { profileId, isInvitedToEvent, ownedGroupIds, nowHHMM })
  // A span in progress is an all-day row for today, so it merges into the day list
  // and re-sorts to the top alongside today's own all-day events.
  const events = mergeCarried([...today, ...spanning].sort(byDayOrder), carried)
  const slots = buildSlots(events)
  let tomorrowFirst = null
  let upcoming = null
  if (widgetShowUpcoming) {
    // Surface the next few events across future days *alongside* today's — a
    // holiday (or any event) today no longer hides what's coming up. The widget
    // shows today's events first, then fills remaining space with these.
    const next = await readUpcomingEvents(db, tomorrowDateString(), 3, { profileId, isInvitedToEvent, ownedGroupIds })
    if (next.length > 0) upcoming = next
  } else if (events.length === 0) {
    // Setting off + empty today: keep the lightweight tomorrow-only preview.
    const tomorrow = await readDayEvents(db, tomorrowDateString(), { profileId, isInvitedToEvent, ownedGroupIds })
    if (tomorrow.length > 0) tomorrowFirst = tomorrow[0]
  }
  return { date, generatedAt: Date.now(), events, slots, tomorrowFirst, upcoming, use24h: use24h ?? null }
}

module.exports = { computeTodayCache, todayDateString }
