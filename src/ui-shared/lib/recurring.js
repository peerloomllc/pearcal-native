// Recurring-event expansion. Pure function — given a series template
// with `recurrence` + `recurrenceEnd` (or `repeatForever`), materialise
// occurrence records up to the 500-cap. When `repeatForever` is true,
// `recurrenceEnd` is ignored and a synthetic 12-month horizon from the
// start date is used; the bare worklet's `extendForeverSeries` boot hook
// re-extends the tail. See TODO #82 Phase 3.

export const FOREVER_INITIAL_WINDOW_MONTHS = 12

const _fmt = d => String(d.getFullYear()) + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0')
const _parse = s => { const [y,m,d] = s.split('-').map(Number); return new Date(y, m-1, d) }

// Step a Date in place by one cadence unit. Mutates `cur`. Pulled out so
// the boot-time tail-extension reuses the same step logic.
//
// The "Custom…" recurrence option (TODO #102) stores its cadence as one of the
// existing units (daily/weekly/monthly/yearly) plus `recurrenceInterval` (N),
// so "every 10 days" is recurrence:'daily', interval:10. Absent/<1 intervals
// fall back to 1, so events authored before the field existed — and peers on
// older builds — behave exactly as before. `biweekly` keeps its fixed 14-day
// step (a convenience preset that predates the interval field).
export function stepRecurrenceDate (cur, ev) {
  const n = Math.max(1, Math.floor(Number(ev.recurrenceInterval)) || 1)
  if (ev.recurrence === 'daily')         cur.setDate(cur.getDate() + n)
  else if (ev.recurrence === 'weekly')   cur.setDate(cur.getDate() + 7 * n)
  else if (ev.recurrence === 'biweekly') cur.setDate(cur.getDate() + 14)
  else if (ev.recurrence === 'monthly')  cur.setMonth(cur.getMonth() + n)
  else if (ev.recurrence === 'monthly-nth') {
    cur.setDate(1); cur.setMonth(cur.getMonth() + 1)
    const wd = ev.recurrenceWeekday ?? 0; const nth = ev.recurrenceNth ?? 1
    let count = 0
    while (true) {
      if (cur.getDay() === wd) { count++; if (count === nth) break }
      cur.setDate(cur.getDate() + 1)
    }
  }
  else if (ev.recurrence === 'yearly')   cur.setFullYear(cur.getFullYear() + n)
}

export function expandRecurring (ev) {
  if (!ev.recurrence || ev.recurrence === 'none') return [ev]
  if (!ev.recurrenceEnd && !ev.repeatForever) return [ev]
  const start = _parse(ev.date)
  const end = ev.repeatForever
    ? new Date(start.getFullYear(), start.getMonth() + FOREVER_INITIAL_WINDOW_MONTHS, start.getDate())
    : _parse(ev.recurrenceEnd)
  let cur = new Date(start)
  if (cur > end) return [ev]
  const recurrenceId = ev.id
  const out = []
  let i = 0
  while (cur <= end && i < 500) {
    out.push({ ...ev, id: i === 0 ? ev.id : ev.id + '_r' + i, date: _fmt(cur), recurrenceId })
    stepRecurrenceDate(cur, ev)
    i++
  }
  return out
}

// Date-formatting helpers exported for callers that need to align dates
// with expandRecurring's output (e.g. extendForeverSeries in bare.js).
export const fmtDate = _fmt
export const parseDate = _parse
