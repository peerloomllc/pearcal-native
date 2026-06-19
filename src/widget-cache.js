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

async function readDayEvents (db, date, { profileId, isInvitedToEvent, ownedGroupIds, nowHHMM }) {
  const gt = 'events:' + date + ':'
  const lt = 'events:' + date + ':\xff'
  // Dedupe by id keeping highest updatedAt — see listEvents in bare.js for why.
  const byId = new Map()
  for await (const { value } of db.createReadStream({ gt, lt })) {
    if (value.isShadow) continue
    if (profileId && isInvitedToEvent && !isInvitedToEvent(value, profileId, ownedGroupIds)) continue
    if (nowHHMM && !value.allDay) {
      const cutoff = value.end || value.start
      if (cutoff && cutoff < nowHHMM) continue
    }
    const prev = byId.get(value.id)
    if (!prev || (value.updatedAt ?? 0) >= (prev.updatedAt ?? 0)) byId.set(value.id, value)
  }
  const out = [...byId.values()].map(normalize)
  out.sort((a, b) => {
    if (a.allDay && !b.allDay) return -1
    if (!a.allDay && b.allDay) return 1
    return (a.start || '').localeCompare(b.start || '')
  })
  return out
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
    if (b && !a.allDay && !b.allDay && a.start && a.start === b.start) {
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
  const events = await readDayEvents(db, date, { profileId, isInvitedToEvent, ownedGroupIds, nowHHMM })
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
