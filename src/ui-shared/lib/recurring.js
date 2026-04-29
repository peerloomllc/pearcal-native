// Recurring-event expansion. Pure function — given a series template
// with `recurrence` + `recurrenceEnd`, materialise occurrence records
// up to the 500-cap (the de-facto horizon — see TODO #82).

export function expandRecurring (ev) {
  if (!ev.recurrence || ev.recurrence === 'none' || !ev.recurrenceEnd) return [ev]
  const fmt = d => String(d.getFullYear()) + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0')
  const parse = s => { const [y,m,d] = s.split('-').map(Number); return new Date(y, m-1, d) }
  const end = parse(ev.recurrenceEnd)
  let cur = parse(ev.date)
  if (cur > end) return [ev]
  const recurrenceId = ev.id
  const out = []
  let i = 0
  while (cur <= end && i < 500) {
    out.push({ ...ev, id: i === 0 ? ev.id : ev.id + '_r' + i, date: fmt(cur), recurrenceId })
    if (ev.recurrence === 'daily')         cur.setDate(cur.getDate() + 1)
    else if (ev.recurrence === 'weekly')   cur.setDate(cur.getDate() + 7)
    else if (ev.recurrence === 'biweekly') cur.setDate(cur.getDate() + 14)
    else if (ev.recurrence === 'monthly')  cur.setMonth(cur.getMonth() + 1)
    else if (ev.recurrence === 'monthly-nth') {
      cur.setDate(1); cur.setMonth(cur.getMonth() + 1)
      const wd = ev.recurrenceWeekday ?? 0; const nth = ev.recurrenceNth ?? 1
      let count = 0
      while (true) {
        if (cur.getDay() === wd) { count++; if (count === nth) break }
        cur.setDate(cur.getDate() + 1)
      }
    }
    else if (ev.recurrence === 'yearly')   cur.setFullYear(cur.getFullYear() + 1)
    i++
  }
  return out
}
