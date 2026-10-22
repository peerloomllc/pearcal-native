// Birthdays (TODO #182, decided 2026-10-22): each birthday is a personal
// all-day event repeating yearly with no end, marked `birthday`, so it syncs
// to linked devices, is in the 12-word backup, gets reminders and can be
// shared into a group like any event. Settings keeps the list.
//
//   event.birthday = { name, month, day, year }   year may be null
//
// Repeating events are stored one row per occurrence (recurring.js), so each
// row's title is set for its own year: "Ana turns 34" when the birth year is
// known, "Ana's birthday" when not. Peers on older builds just see the title.

const pad = (n) => String(n).padStart(2, '0')
const DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

export function birthdayTitle (b, date) {
  if (!b?.name) return ''
  const year = Number(String(date || '').slice(0, 4))
  const age = b.year ? year - b.year : 0
  return age > 0 ? `${b.name} turns ${age}` : `${b.name}'s birthday`
}

// An occurrence row with its title set for its year. Anything else unchanged.
export function withBirthdayTitle (ev) {
  if (!ev?.birthday) return ev
  return { ...ev, title: birthdayTitle(ev.birthday, ev.date) }
}

// Checks what was typed. Returns { birthday } or { error }.
export function parseBirthday ({ name, month, day, year }, today = new Date()) {
  const n = String(name || '').trim().slice(0, 100)
  const m = Number(month)
  const d = Number(day)
  const y = year === '' || year == null ? null : Number(year)
  if (!n) return { error: 'Enter a name.' }
  if (!Number.isInteger(m) || m < 1 || m > 12) return { error: 'Pick a month.' }
  if (!Number.isInteger(d) || d < 1 || d > DAYS[m - 1]) return { error: 'That day is not in that month.' }
  if (y !== null) {
    if (!Number.isInteger(y) || y < 1900 || y > today.getFullYear()) return { error: 'Enter a year between 1900 and this year, or leave it empty.' }
    if (m === 2 && d === 29 && !(y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0))) return { error: `${y} had no 29 February.` }
  }
  return { birthday: { name: n, month: m, day: d, year: y } }
}

// The event to save for a new birthday: it starts this year, so the
// calendar shows this year's birthday even if it has passed. A 29 February
// birthday starts in the last leap year; in other years the yearly repeat
// lands it on 1 March.
export function birthdayEvent (b, today = new Date()) {
  let y = today.getFullYear()
  if (b.month === 2 && b.day === 29) while (!(y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0))) y--
  const date = `${y}-${pad(b.month)}-${pad(b.day)}`
  return {
    id: 'bday-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title: birthdayTitle(b, date),
    date,
    allDay: true,
    start: '', end: '',
    recurrence: 'yearly',
    repeatForever: true,
    groups: [],
    birthday: { ...b },
  }
}

// One entry per birthday for Settings, soonest first: the series id, the
// birthday and its next date on or after today.
export function listBirthdays (events, today = new Date()) {
  const t = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`
  const bySeries = new Map()
  for (const ev of events || []) {
    if (!ev?.birthday || ev.isShadow) continue
    const sid = ev.recurrenceId || ev.id
    const cur = bySeries.get(sid)
    const next = ev.date >= t
    if (!cur) { bySeries.set(sid, { id: sid, birthday: ev.birthday, next: next ? ev.date : null, last: ev.date }); continue }
    if (next && (!cur.next || ev.date < cur.next)) cur.next = ev.date
    if (ev.date > cur.last) cur.last = ev.date
  }
  const out = [...bySeries.values()].map((x) => {
    const next = x.next || x.last
    return { id: x.id, birthday: x.birthday, next, title: birthdayTitle(x.birthday, next) }
  })
  return out.sort((a, b) => (a.next < b.next ? -1 : a.next > b.next ? 1 : a.birthday.name.localeCompare(b.birthday.name)))
}
