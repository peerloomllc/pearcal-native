// The two backup lines under the seeder list (TODO #176, #181), shared by the
// phone and desktop Settings so they say the same thing. `st` is keyringStatus.
// Each is null when there is nothing to say; `warn` marks a calendar that is
// not fully on the seeder.

export function calendarListLine (st) {
  if (!st || !(st.paired > 0)) return null
  if (st.seeders > 0) {
    const where = st.seeders === st.paired
      ? (st.paired === 1 ? 'your seeder' : `all ${st.paired} of your seeders`)
      : `${st.seeders} of your ${st.paired} seeders`
    return `Your calendar list is backed up to ${where}.`
  }
  if (!st.at) return 'Backing up your calendar list…'
  const why = Object.values(st.refused || {})
  if (why.includes('not-paired')) return "Your calendar list isn't backed up: your seeder doesn't recognise this device any more. Pair it again to fix this."
  if (why.includes('full')) return "Your calendar list isn't backed up: your seeder has no room for another list from this device."
  return "Your calendar list isn't backed up yet. Your seeder may be offline or need an update."
}

export function calendarsLine (st) {
  const c = st?.calendars
  if (!st || !(st.paired > 0) || !c || !(c.total > 0)) return null
  if (c.complete === c.total) return { text: c.total === 1 ? 'Your calendar is fully on your seeder.' : `All ${c.total} calendars are fully on your seeder.`, warn: false }
  if (c.incomplete.length) return { text: `Not fully on your seeder yet: ${c.incomplete.join(', ')}. Your seeder copies the rest when a device that has those events is online.`, warn: true }
  if (c.complete > 0) return { text: `${c.complete} of ${c.total} calendars are fully on your seeder. Still checking: ${c.checking.join(', ')}.`, warn: false }
  return { text: 'Checking your calendars on your seeder…', warn: false }
}

// Personal events, private notes and reminders (#176 step 5).
export function personalLine (st) {
  const p = st?.personal
  if (!st || !(st.paired > 0) || !p) return null
  if (!(p.seeders > 0)) return p.at ? null : 'Backing up your personal events, notes and reminders…'
  const dropped = p.dropped > 0 ? ` ${p.dropped} of the oldest past events did not fit and are left out.` : ''
  return 'Your personal events, notes and reminders are backed up too.' + dropped
}
