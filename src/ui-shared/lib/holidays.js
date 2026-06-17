// Public-holiday date tables, computed fully offline (no API calls). Shared
// between the mobile UI (src/ui) and the desktop UI (src/ui-desktop) so both
// subscribe to the exact same dates. Each get*Holidays(year) returns
// [{ title, date: 'YYYY-MM-DD' }].

function pad (n) { return String(n).padStart(2, '0') }
function ymd (y, m, d) { return `${y}-${pad(m)}-${pad(d)}` }

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
  // Observed date: Sat→Fri, Sun→Mon
  function observed (y, m, d) {
    const dow = new Date(y, m - 1, d).getDay()
    if (dow === 6) return ymd(y, m, d - 1)
    if (dow === 0) return ymd(y, m, d + 1)
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
  function observed (y, m, d) {
    const dow = new Date(y, m - 1, d).getDay()
    if (dow === 6) return ymd(y, m, d - 1)
    if (dow === 0) return ymd(y, m, d + 1)
    return ymd(y, m, d)
  }
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
  return [
    { title: "New Year's Day",                            date: observed(year, 1,  1)  },
    { title: 'Good Friday',                               date: easterOffset(-2)       },
    { title: 'Victoria Day',                              date: victoriaDay()          },
    { title: 'Canada Day',                                date: observed(year, 7,  1)  },
    { title: 'Labour Day',                                date: nthWeekday(year, 9, 1, 1) },
    { title: 'National Day for Truth and Reconciliation', date: observed(year, 9, 30)  },
    { title: 'Thanksgiving',                              date: nthWeekday(year, 10, 1, 2) },
    { title: 'Remembrance Day',                           date: observed(year, 11, 11) },
    { title: 'Christmas Day',                             date: observed(year, 12, 25) },
    { title: 'Boxing Day',                                date: observed(year, 12, 26) },
  ]
}

export function getBitcoinHolidays (year) {
  return [
    { title: 'Genesis Block Day',      date: ymd(year,  1,  3) },
    { title: 'Hal Finney Day',         date: ymd(year,  1, 12) },
    { title: 'Bitcoin Pizza Day',      date: ymd(year,  5, 22) },
    { title: 'Bitcoin Whitepaper Day', date: ymd(year, 10, 31) },
  ]
}

export function getUKHolidays (year) {
  function observed (y, m, d) {
    const dow = new Date(y, m - 1, d).getDay()
    if (dow === 6) return ymd(y, m, d - 1)
    if (dow === 0) return ymd(y, m, d + 1)
    return ymd(y, m, d)
  }
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
  return [
    { title: "New Year's Day",          date: observed(year, 1, 1)     },
    { title: 'Good Friday',             date: easterOffset(-2)         },
    { title: 'Easter Monday',           date: easterOffset(1)          },
    { title: 'Early May Bank Holiday',  date: nthWeekday(year, 5, 1, 1)},
    { title: 'Spring Bank Holiday',     date: lastWeekday(year, 5, 1)  },
    { title: 'Summer Bank Holiday',     date: lastWeekday(year, 8, 1)  },
    { title: 'Christmas Day',           date: observed(year, 12, 25)   },
    { title: 'Boxing Day',              date: observed(year, 12, 26)   },
  ]
}

// Subscribable holiday calendars. `color`/`desc` override the per-event
// defaults ('#CF3535' / 'Public Holiday') when present; `colors` (2–3 entries)
// paints a segmented strip instead of a solid color. US uses the flag's
// Old Glory red / white / Old Glory blue.
export const HOLIDAY_COUNTRIES = [
  { code: 'us',  flag: '🇺🇸', label: 'United States', fn: getUSFederalHolidays, color: '#B22234', colors: ['#B22234', '#FFFFFF', '#3C3B6E'] },
  { code: 'ca',  flag: '🇨🇦', label: 'Canada',         fn: getCanadaHolidays   },
  { code: 'uk',  flag: '🇬🇧', label: 'United Kingdom', fn: getUKHolidays       },
  { code: 'btc', flag: '₿',  label: 'Bitcoin',        fn: getBitcoinHolidays, color: '#F7931A', desc: 'Bitcoin Holiday' },
]

// Stable ID for a holiday calendar event — shared between platforms so the
// same holiday never double-imports across devices.
export function holidayEventId (h) {
  const slug = h.title.replace(/\s+/g, '-').toLowerCase()
  return 'holiday-' + h.date + '-' + slug
}
