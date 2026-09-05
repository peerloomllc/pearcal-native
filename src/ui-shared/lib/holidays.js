// Public-holiday date tables, computed fully offline (no API calls). Shared
// between the mobile UI (src/ui) and the desktop UI (src/ui-desktop) so both
// subscribe to the exact same dates. Each get*Holidays(year) returns
// [{ title, date: 'YYYY-MM-DD' }].

function pad (n) { return String(n).padStart(2, '0') }
function ymd (y, m, d) { return `${y}-${pad(m)}-${pad(d)}` }

// Date math that goes through a real Date so month and year boundaries carry.
// Building `ymd(y, m, d - 1)` by hand produced strings like '2022-01-00' when a
// holiday on the 1st shifted backwards.
function shift (y, m, d, delta) {
  const dt = new Date(y, m - 1, d + delta)
  return ymd(dt.getFullYear(), dt.getMonth() + 1, dt.getDate())
}
function parseYmd (s) {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}
function dayOfWeek (s) { return parseYmd(s).getDay() }
function isWeekend (s) { const g = dayOfWeek(s); return g === 0 || g === 6 }
function nextDay (s) {
  const dt = parseYmd(s)
  dt.setDate(dt.getDate() + 1)
  return ymd(dt.getFullYear(), dt.getMonth() + 1, dt.getDate())
}

// UK "substitute day" rule, which Canadian federal practice also follows: a
// holiday landing on a weekend moves FORWARD to the next weekday that no other
// holiday already occupies. Never backwards - that is a US-only convention, and
// applying it here is what put Boxing Day on 25 Dec 2026 (Sat 26 Dec → Fri 25).
// Holidays already on a weekday never move, so they claim their dates first and
// a substitute steps over them (Christmas Sun 25 Dec 2022 → Tue 27, because
// Boxing Day keeps Mon 26).
function applySubstitutes (list) {
  const out = list.map(h => ({ ...h }))
  const taken = new Set(out.filter(h => !isWeekend(h.date)).map(h => h.date))
  const moved = out.filter(h => isWeekend(h.date))
    .sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0)
  for (const h of moved) {
    let d = h.date
    do { d = nextDay(d) } while (isWeekend(d) || taken.has(d))
    taken.add(d)
    h.date = d
  }
  return out.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0)
}

// Computus (Anonymous Gregorian algorithm) → { month, day } of Easter Sunday.
export function computeEaster (year) {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return { month, day }
}

export function getUSFederalHolidays (year) {
  // US federal observed date: Sat→Fri, Sun→Mon. This backwards shift is a US
  // convention only; Canada and the UK move forwards instead.
  function observed (y, m, d) {
    const dow = new Date(y, m - 1, d).getDay()
    if (dow === 6) return shift(y, m, d, -1)
    if (dow === 0) return shift(y, m, d, 1)
    return ymd(y, m, d)
  }
  // Nth weekday of month: e.g. nthWeekday(year,1,1,3) = 3rd Monday of Jan
  function nthWeekday (y, m, weekday, n) {
    let d = 1
    const first = new Date(y, m - 1, 1).getDay()
    d += (weekday - first + 7) % 7
    d += (n - 1) * 7
    return ymd(y, m, d)
  }
  // Last weekday of month
  function lastWeekday (y, m, weekday) {
    const last = new Date(y, m, 0).getDate()
    const lastDow = new Date(y, m - 1, last).getDay()
    const d = last - ((lastDow - weekday + 7) % 7)
    return ymd(y, m, d)
  }
  return [
    { title: "New Year's Day",               date: observed(year, 1,  1)  },
    { title: 'Martin Luther King Jr. Day',   date: nthWeekday(year, 1, 1, 3) },
    { title: "Presidents' Day",              date: nthWeekday(year, 2, 1, 3) },
    { title: 'Memorial Day',                 date: lastWeekday(year, 5, 1)   },
    { title: 'Juneteenth',                   date: observed(year, 6, 19) },
    { title: 'Independence Day',             date: observed(year, 7,  4) },
    { title: 'Labor Day',                    date: nthWeekday(year, 9, 1, 1) },
    { title: 'Columbus Day',                 date: nthWeekday(year, 10, 1, 2)},
    { title: 'Veterans Day',                 date: observed(year, 11, 11) },
    { title: 'Thanksgiving Day',             date: nthWeekday(year, 11, 4, 4)},
    { title: 'Christmas Day',                date: observed(year, 12, 25) },
  ]
}

export function getCanadaHolidays (year) {
  function nthWeekday (y, m, weekday, n) {
    const first = new Date(y, m - 1, 1).getDay()
    let d = 1 + (weekday - first + 7) % 7 + (n - 1) * 7
    return ymd(y, m, d)
  }
  const { month: em, day: ed } = computeEaster(year)
  const easter = new Date(year, em - 1, ed)
  function easterOffset (days) {
    const d = new Date(easter); d.setDate(d.getDate() + days)
    return ymd(d.getFullYear(), d.getMonth() + 1, d.getDate())
  }
  function victoriaDay () {
    const dow = new Date(year, 4, 24).getDay()
    return ymd(year, 5, 24 - ((dow - 1 + 7) % 7))
  }
  return applySubstitutes([
    { title: "New Year's Day",                            date: ymd(year, 1,  1)       },
    { title: 'Good Friday',                               date: easterOffset(-2)       },
    { title: 'Victoria Day',                              date: victoriaDay()          },
    { title: 'Canada Day',                                date: ymd(year, 7,  1)       },
    { title: 'Labour Day',                                date: nthWeekday(year, 9, 1, 1) },
    { title: 'National Day for Truth and Reconciliation', date: ymd(year, 9, 30)       },
    { title: 'Thanksgiving',                              date: nthWeekday(year, 10, 1, 2) },
    { title: 'Remembrance Day',                           date: ymd(year, 11, 11)      },
    { title: 'Christmas Day',                             date: ymd(year, 12, 25)      },
    { title: 'Boxing Day',                                date: ymd(year, 12, 26)      },
  ])
}

export function getBitcoinHolidays (year) {
  return [
    { title: 'Genesis Block Day',      date: ymd(year,  1,  3) },
    { title: 'Hal Finney Day',         date: ymd(year,  1, 12) },
    { title: 'Bitcoin Pizza Day',      date: ymd(year,  5, 22) },
    { title: 'Bitcoin Whitepaper Day', date: ymd(year, 10, 31) },
  ]
}

// Mexico's statutory rest days, from Article 74 of the Ley Federal del Trabajo.
// The 2006 reform pinned three of them to a Monday, so they float rather than
// sitting on the date they commemorate: Constitution Day marks 5 February but is
// taken on the first Monday of the month. Mexico has no substitute-day rule, so
// a holiday landing on a weekend stays there and `applySubstitutes` is
// deliberately not applied here.
export function getMexicoHolidays (year) {
  function nthWeekday (y, m, weekday, n) {
    const first = new Date(y, m - 1, 1).getDay()
    const d = 1 + (weekday - first + 7) % 7 + (n - 1) * 7
    return ymd(y, m, d)
  }
  const list = [
    { title: "New Year's Day",           date: ymd(year, 1, 1)            },
    { title: 'Constitution Day',         date: nthWeekday(year, 2, 1, 1)  },
    { title: "Benito Juárez's Birthday", date: nthWeekday(year, 3, 1, 3)  },
    { title: 'Labour Day',               date: ymd(year, 5, 1)            },
    { title: 'Independence Day',         date: ymd(year, 9, 16)           },
    { title: 'Revolution Day',           date: nthWeekday(year, 11, 1, 3) },
    { title: 'Christmas Day',            date: ymd(year, 12, 25)          },
  ]
  // Federal election day, the first Sunday of June. The 2014 reform put every
  // federal election on that day, three years apart from 2015, with one written
  // in exception: it moved the 2018 election to the first Sunday of July.
  if (year >= 2015 && (year - 2015) % 3 === 0) {
    list.push({ title: 'Election Day', date: nthWeekday(year, year === 2018 ? 7 : 6, 0, 1) })
  }
  // Handover of federal executive power, once every six years. A 2024
  // constitutional change moved it from 1 December to 1 October, taking effect
  // with that year's handover.
  if (year >= 2024 && (year - 2024) % 6 === 0) {
    list.push({ title: 'Inauguration Day', date: ymd(year, 10, 1) })
  } else if (year < 2024 && (year - 2018) % 6 === 0) {
    list.push({ title: 'Inauguration Day', date: ymd(year, 12, 1) })
  }
  return list.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0)
}

export function getUKHolidays (year) {
  function nthWeekday (y, m, weekday, n) {
    const first = new Date(y, m - 1, 1).getDay()
    let d = 1 + (weekday - first + 7) % 7 + (n - 1) * 7
    return ymd(y, m, d)
  }
  function lastWeekday (y, m, weekday) {
    const last = new Date(y, m, 0).getDate()
    const lastDow = new Date(y, m - 1, last).getDay()
    return ymd(y, m, last - ((lastDow - weekday + 7) % 7))
  }
  const { month: em, day: ed } = computeEaster(year)
  const easter = new Date(year, em - 1, ed)
  function easterOffset (days) {
    const d = new Date(easter); d.setDate(d.getDate() + days)
    return ymd(d.getFullYear(), d.getMonth() + 1, d.getDate())
  }
  return applySubstitutes([
    { title: "New Year's Day",          date: ymd(year, 1, 1)          },
    { title: 'Good Friday',             date: easterOffset(-2)         },
    { title: 'Easter Monday',           date: easterOffset(1)          },
    { title: 'Early May Bank Holiday',  date: nthWeekday(year, 5, 1, 1)},
    { title: 'Spring Bank Holiday',     date: lastWeekday(year, 5, 1)  },
    { title: 'Summer Bank Holiday',     date: lastWeekday(year, 8, 1)  },
    { title: 'Christmas Day',           date: ymd(year, 12, 25)        },
    { title: 'Boxing Day',              date: ymd(year, 12, 26)        },
  ])
}

// Subscribable holiday calendars. `color`/`desc` override the per-event
// defaults ('#CF3535' / 'Public Holiday') when present; `colors` (2–3 entries)
// paints a segmented strip instead of a solid color. US uses the flag's
// Old Glory red / white / Old Glory blue.
export const HOLIDAY_COUNTRIES = [
  { code: 'us',  flag: '🇺🇸', label: 'United States', fn: getUSFederalHolidays, color: '#B22234', colors: ['#B22234', '#FFFFFF', '#3C3B6E'] },
  { code: 'ca',  flag: '🇨🇦', label: 'Canada',         fn: getCanadaHolidays   },
  { code: 'uk',  flag: '🇬🇧', label: 'United Kingdom', fn: getUKHolidays       },
  { code: 'mx',  flag: '🇲🇽', label: 'Mexico',         fn: getMexicoHolidays, color: '#006847', colors: ['#006847', '#FFFFFF', '#CE1126'] },
  { code: 'btc', flag: '₿',  label: 'Bitcoin',        fn: getBitcoinHolidays, color: '#F7931A', desc: 'Bitcoin Holiday' },
]

// Stable ID for a holiday calendar event — shared between platforms so the
// same holiday never double-imports across devices.
export function holidayEventId (h) {
  return 'holiday-' + h.date + '-' + holidaySlug(h.title)
}

function holidaySlug (title) { return title.replace(/\s+/g, '-').toLowerCase() }

const HOLIDAY_ID_RE = /^holiday-(\d{4})-\d{2}-\d{2}-(.+)$/

// Every event ID `fn`'s calendar produces across `years`.
export function holidayCalendarIds (fn, years) {
  const ids = new Set()
  for (const y of years) for (const h of fn(y)) ids.add(holidayEventId(h))
  return ids
}

// Stored holiday events belonging to `fn`'s calendar over `years` that `keepIds`
// does not claim. Matched on the title slug and year, NOT on the whole ID: the
// ID embeds the observed date, so correcting a date (Boxing Day off 25 Dec)
// orphans the event already on disk and an exact-ID lookup can never find it
// again. `keepIds` carries what other still-active calendars need, so a holiday
// two countries share is never swept out from under the other one.
export function strayHolidayEvents (events, fn, years, keepIds = new Set()) {
  const slugs = new Set()
  for (const y of years) for (const h of fn(y)) slugs.add(holidaySlug(h.title))
  return (events ?? []).filter(e => {
    if (e?.creatorId !== 'system' || keepIds.has(e.id)) return false
    const m = HOLIDAY_ID_RE.exec(e.id ?? '')
    return !!m && years.includes(Number(m[1])) && slugs.has(m[2])
  })
}

// Bring already-stored holiday events onto the dates the calendars now compute,
// for the countries in `activeCodes`. Pure: returns { deletes, puts } for the
// caller to apply.
//
// This only ever MOVES an event whose observed date was corrected. It does not
// re-add a holiday that is simply absent, because the user may have deleted that
// one deliberately and a launch-time pass would resurrect it every time. Once
// the dates line up nothing is stray, so the plan comes back empty and repeat
// runs cost nothing - which is what makes it safe on every device and shell.
export function planHolidayRepair (events, activeCodes, years, now = 0, countries = HOLIDAY_COUNTRIES) {
  const active = countries.filter(c => (activeCodes ?? []).includes(c.code))
  if (!active.length) return { deletes: [], puts: [] }
  const keepIds = new Set()
  for (const c of active) for (const id of holidayCalendarIds(c.fn, years)) keepIds.add(id)
  const existing = new Set((events ?? []).map(e => e.id))
  const deletes = []
  const puts = []
  const handled = new Set()
  for (const c of active) {
    // Keyed on the year the calendar was generated FOR, which is not always the
    // year in the resulting date: US New Year's Day 2022 is observed 31 Dec 2021.
    const target = new Map()
    for (const y of years) for (const h of c.fn(y)) target.set(y + '|' + holidaySlug(h.title), h)
    for (const ev of strayHolidayEvents(events, c.fn, years, keepIds)) {
      if (handled.has(ev.id)) continue
      const m = HOLIDAY_ID_RE.exec(ev.id)
      const h = target.get(m[1] + '|' + m[2])
      if (!h) continue  // no date to move it to; leave it alone rather than guess
      handled.add(ev.id)
      deletes.push(ev)
      const id = holidayEventId(h)
      if (existing.has(id)) continue  // corrected date already present; just drop the stray
      existing.add(id)
      // Carry the stored event's own fields over, so a reminder or colour the
      // user set on the holiday survives the move.
      puts.push({ ...ev, id, date: h.date, title: h.title, updatedAt: now })
    }
  }
  return { deletes, puts }
}
