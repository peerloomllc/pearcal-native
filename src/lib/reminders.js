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

// Notification body labels keyed by the stored numeric reminder value. The
// fallback for unknown positive minutes is `${n}min` — ugly but functional.
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

function formatTime12h (t) {
  if (!t) return ''
  const [hStr, mStr] = t.split(':')
  const h = parseInt(hStr, 10)
  if (isNaN(h)) return t
  const ampm = h >= 12 ? 'pm' : 'am'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return h12 + ':' + (mStr ?? '00') + ampm
}

function computeReminderFireTime (ev, reminder) {
  if (!ev || !ev.date) return null
  const [y, mo, d] = ev.date.split('-').map(Number)
  if (!y || !mo || !d) return null
  if (reminder === MORNING_OF) {
    return new Date(y, mo - 1, d, 9, 0, 0, 0).getTime()
  }
  if (reminder === DAY_BEFORE) {
    return new Date(y, mo - 1, d - 1, 9, 0, 0, 0).getTime()
  }
  let h = 9, m = 0
  if (!ev.allDay && ev.start) {
    const parts = ev.start.split(':').map(Number)
    h = parts[0]; m = parts[1]
  }
  const eventStartMs = new Date(y, mo - 1, d, h, m, 0, 0).getTime()
  return eventStartMs - reminder * 60 * 1000
}

function computeStartFireTime (ev) {
  if (!ev || !ev.date || ev.allDay || !ev.start) return null
  const [y, mo, d] = ev.date.split('-').map(Number)
  const [h, m] = ev.start.split(':').map(Number)
  if (!y || !mo || !d || isNaN(h)) return null
  return new Date(y, mo - 1, d, h, m, 0, 0).getTime()
}

function buildReminderBody (ev, reminder) {
  const label = OPTION_LABELS[String(reminder)] ?? (reminder > 0 ? reminder + 'min' : '')
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
  computeReminderFireTime,
  computeStartFireTime,
  buildReminderBody,
  buildStartBody,
}
