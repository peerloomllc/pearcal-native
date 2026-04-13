// Computes today's events payload for the home-screen widget cache.
// Called from bare.js after every mutation; the payload is sent to RN,
// which writes it to the native widget cache location.

function todayDateString () {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

async function computeTodayCache (db, { profileId, isInvitedToEvent } = {}) {
  const date = todayDateString()
  const gt = 'events:' + date + ':'
  const lt = 'events:' + date + ':\xff'
  const events = []
  for await (const { value } of db.createReadStream({ gt, lt })) {
    if (profileId && isInvitedToEvent && !isInvitedToEvent(value, profileId)) continue
    events.push({
      id: value.id,
      title: value.title || '',
      allDay: !!value.allDay,
      start: value.start || null,
      end: value.end || null,
      color: (value.colors && value.colors[0]) || value.color || null,
    })
  }
  events.sort((a, b) => {
    if (a.allDay && !b.allDay) return -1
    if (!a.allDay && b.allDay) return 1
    return (a.start || '').localeCompare(b.start || '')
  })
  return { date, generatedAt: Date.now(), events }
}

module.exports = { computeTodayCache, todayDateString }
