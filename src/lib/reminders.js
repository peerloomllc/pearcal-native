// Reminder fire-time math + notification body templates. Used by:
//   - the bare worklet's top-K scheduler (TODO #82 Phase 2 — `computeUpcomingReminders`)
//   - the RN shell's native alarm dispatcher (`reconcileSchedule` IPC handler)
//   - the WebView UI renderer (default-reminder picker labels)
//
// Authored as CommonJS so bare.js can `require()` it; esbuild does CJS→ESM
// interop transparently for App.jsx/main.jsx.
//
// MORNING_OF / DAY_BEFORE are special tokens, not literal minute offsets —
// see `REMINDER_OPTIONS` in App.jsx. Positive numbers are minutes-before.

const MORNING_OF = -1
const DAY_BEFORE = -2

// Custom-interval helpers (TODO #83 Part B). UI shows users a unit picker
// (minutes / hours / days / weeks) and persists the resolved minute count.
const UNIT_MULTIPLIER = { minutes: 1, hours: 60, days: 1440, weeks: 10080 }
const MAX_REMINDER_MINUTES = 525600 // 1 year

// Notification body labels keyed by the stored numeric reminder value. The
// fallback for unknown positive minutes routes through `deriveReminderLabel`
// so custom intervals render readably (e.g. "3 hr" instead of "180min").
const OPTION_LABELS = {
  '5':     '5 min',
  '10':    '10 min',
  '15':    '15 min',
  '30':    '30 min',
  '60':    '1 hr',
  '120':   '2 hrs',
  '1440':  '1 day',
  '10080': '1 wk',
  '20160': '2 wk',
  '-1':    'Morning of',
  '-2':    'Day before',
}

// Derive a readable short label from an arbitrary minute count. Used as the
// fallback in `buildReminderBody` for any value not in OPTION_LABELS — e.g.
// custom intervals from #83 Part B (3 days = "3 day", 90 minutes = "90 min").
function deriveReminderLabel (m) {
  if (!Number.isFinite(m) || m <= 0) return ''
  if (m % 10080 === 0) { const w = m / 10080; return w + (w === 1 ? ' wk' : ' wks') }
  if (m % 1440 === 0)  { const d = m / 1440;  return d + (d === 1 ? ' day' : ' days') }
  if (m % 60 === 0)    { const h = m / 60;    return h + (h === 1 ? ' hr' : ' hrs') }
  return m + ' min'
}

function formatTime12h (t) {
  if (!t) return ''
  const [hStr, mStr] = t.split(':')
  const h = parseInt(hStr, 10)
  if (isNaN(h)) return t
  const ampm = h >= 12 ? 'pm' : 'am'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return h12 + ':' + (mStr ?? '00') + ampm
}

// Convert a wall-clock y/mo/d/h/m in `tzName` to an absolute UTC epoch ms.
// Uses Intl (ICU static tzdata) when `tzName` is supplied — that path is
// immune to V8's cached system-TZ, which is the root cause of the
// crossed-timezones-alerts-off-by-an-hour bug: bare worklet's V8 snapshots
// the OS TZ at engine init and never refreshes, so `new Date(y,mo-1,d,h,m)`
// keeps interpreting wall-clock against the wrong zone after a flight.
function _wallClockToUtcMs (y, mo, d, h, m, tzName) {
  if (!tzName) return new Date(y, mo - 1, d, h, m, 0, 0).getTime()
  const target = Date.UTC(y, mo - 1, d, h, m, 0)
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tzName, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  let guess = target
  for (let i = 0; i < 3; i++) {
    const parts = {}
    for (const p of fmt.formatToParts(new Date(guess))) parts[p.type] = p.value
    const hh = (+parts.hour) % 24 // Intl can emit "24" for midnight in en-US
    const got = Date.UTC(+parts.year, +parts.month - 1, +parts.day, hh, +parts.minute, +parts.second)
    const diff = target - got
    if (diff === 0) return guess
    guess += diff
  }
  return guess
}

function computeReminderFireTime (ev, reminder, tzName) {
  if (!ev || !ev.date) return null
  const [y, mo, d] = ev.date.split('-').map(Number)
  if (!y || !mo || !d) return null
  if (reminder === MORNING_OF) {
    return _wallClockToUtcMs(y, mo, d, 9, 0, tzName)
  }
  if (reminder === DAY_BEFORE) {
    return _wallClockToUtcMs(y, mo, d - 1, 9, 0, tzName)
  }
  let h = 9, m = 0
  if (!ev.allDay && ev.start) {
    const parts = ev.start.split(':').map(Number)
    h = parts[0]; m = parts[1]
  }
  const eventStartMs = _wallClockToUtcMs(y, mo, d, h, m, tzName)
  return eventStartMs - reminder * 60 * 1000
}

function computeStartFireTime (ev, tzName) {
  if (!ev || !ev.date || ev.allDay || !ev.start) return null
  const [y, mo, d] = ev.date.split('-').map(Number)
  const [h, m] = ev.start.split(':').map(Number)
  if (!y || !mo || !d || isNaN(h)) return null
  return _wallClockToUtcMs(y, mo, d, h, m, tzName)
}

function buildReminderBody (ev, reminder) {
  const label = OPTION_LABELS[String(reminder)] ?? deriveReminderLabel(reminder)
  if (ev.allDay) return 'All day · ' + label
  return label + ' · ' + formatTime12h(ev.start) + '–' + formatTime12h(ev.end)
}

function buildStartBody (ev) {
  return formatTime12h(ev.start) + ' to ' + formatTime12h(ev.end)
}

module.exports = {
  MORNING_OF,
  DAY_BEFORE,
  OPTION_LABELS,
  UNIT_MULTIPLIER,
  MAX_REMINDER_MINUTES,
  deriveReminderLabel,
  computeReminderFireTime,
  computeStartFireTime,
  buildReminderBody,
  buildStartBody,
}
