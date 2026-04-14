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
  return {
    id: value.id,
    title: value.title || '',
    allDay: !!value.allDay,
    start: value.start || null,
    end: value.end || null,
    location: value.location || null,
    color: (value.colors && value.colors[0]) || value.color || null,
  }
}

async function readDayEvents (db, date, { profileId, isInvitedToEvent }) {
  const gt = 'events:' + date + ':'
  const lt = 'events:' + date + ':\xff'
  const out = []
  for await (const { value } of db.createReadStream({ gt, lt })) {
    if (profileId && isInvitedToEvent && !isInvitedToEvent(value, profileId)) continue
    out.push(normalize(value))
  }
  out.sort((a, b) => {
    if (a.allDay && !b.allDay) return -1
    if (!a.allDay && b.allDay) return 1
    return (a.start || '').localeCompare(b.start || '')
  })
  return out
}

async function computeTodayCache (db, { profileId, isInvitedToEvent } = {}) {
  const date = todayDateString()
  const events = await readDayEvents(db, date, { profileId, isInvitedToEvent })
  let tomorrowFirst = null
  if (events.length === 0) {
    const tomorrow = await readDayEvents(db, tomorrowDateString(), { profileId, isInvitedToEvent })
    if (tomorrow.length > 0) tomorrowFirst = tomorrow[0]
  }
  return { date, generatedAt: Date.now(), events, tomorrowFirst }
}

module.exports = { computeTodayCache, todayDateString }
