// ICS / iCalendar parser + generator. Pure functions — no React, no DOM.
// Lifted unchanged from src/ui/App.jsx during the desktop-renderer fork
// so both UIs can import without dragging the whole calendar component.

import { expandRecurring, stepRecurrenceDate, fmtDate, parseDate } from './recurring.js'
import { withBirthdayTitle, birthdayTitle } from './birthdays.js'

function _icsUnescape (s) {
  return s.replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\')
}

function _icsParseDate (s) {
  // YYYYMMDD → YYYY-MM-DD
  const d = s.slice(0, 8)
  return d.slice(0,4) + '-' + d.slice(4,6) + '-' + d.slice(6,8)
}

function _icsParseDateTime (s) {
  // YYYYMMDDTHHMMSS[Z]
  return {
    date: s.slice(0,4) + '-' + s.slice(4,6) + '-' + s.slice(6,8),
    time: s.slice(9,11) + ':' + s.slice(11,13),
  }
}

// RRULE weekday codes, indexed like Date.getDay().
const _WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

// Map an RRULE onto the recurrence fields PearCal stores (#184), or null when
// PearCal cannot represent it, in which case the event imports as a one-off on
// its DTSTART like it always did. BY* parts that only restate DTSTART are
// accepted, since that is how Yandex and others write a plain yearly date.
// A forever series whose DTSTART is years back starts from the first
// occurrence this year instead, the way a new birthday does, so the calendar
// is not filled from 1990 one year at a time.
export function rruleToRecurrence (rrule, date, today = new Date()) {
  const parts = {}
  for (const kv of String(rrule || '').split(';')) {
    const eq = kv.indexOf('=')
    if (eq > 0) parts[kv.slice(0, eq).toUpperCase()] = kv.slice(eq + 1).toUpperCase()
  }
  const start = parseDate(date)
  const interval = parts.INTERVAL ? parseInt(parts.INTERVAL, 10) : 1
  if (!(interval >= 1)) return null
  for (const k of Object.keys(parts)) {
    if (!['FREQ', 'INTERVAL', 'UNTIL', 'COUNT', 'WKST', 'BYDAY', 'BYMONTH', 'BYMONTHDAY'].includes(k)) return null
  }
  if (parts.UNTIL && parts.COUNT) return null
  const monthOk = !parts.BYMONTH || parts.BYMONTH === String(start.getMonth() + 1)
  const dayOk = !parts.BYMONTHDAY || parts.BYMONTHDAY === String(start.getDate())
  const wd = _WEEKDAYS[start.getDay()]

  const rec = { recurrence: null, recurrenceInterval: 1, recurrenceNth: 0, recurrenceWeekday: 0 }
  if (parts.FREQ === 'DAILY') {
    if (parts.BYDAY || parts.BYMONTH || parts.BYMONTHDAY) return null
    rec.recurrence = 'daily'; rec.recurrenceInterval = interval
  } else if (parts.FREQ === 'WEEKLY') {
    if ((parts.BYDAY && parts.BYDAY !== wd) || parts.BYMONTH || parts.BYMONTHDAY) return null
    if (interval === 2) rec.recurrence = 'biweekly'
    else { rec.recurrence = 'weekly'; rec.recurrenceInterval = interval }
  } else if (parts.FREQ === 'MONTHLY') {
    if (parts.BYMONTH || !dayOk) return null
    if (parts.BYDAY) {
      // One weekday with an ordinal, e.g. 2MO. The 5th and the last (-1) are
      // left out: PearCal's monthly-nth step cannot skip a month without one.
      const m = parts.BYDAY.match(/^\+?([1-4])([A-Z]{2})$/)
      const nth = Math.ceil(start.getDate() / 7)
      if (!m || interval !== 1 || parts.BYMONTHDAY || m[2] !== wd || Number(m[1]) !== nth) return null
      rec.recurrence = 'monthly-nth'; rec.recurrenceNth = nth; rec.recurrenceWeekday = start.getDay()
    } else {
      rec.recurrence = 'monthly'; rec.recurrenceInterval = interval
    }
  } else if (parts.FREQ === 'YEARLY') {
    if (parts.BYDAY || !monthOk || !dayOk) return null
    rec.recurrence = 'yearly'; rec.recurrenceInterval = interval
  } else {
    return null
  }

  if (parts.UNTIL) {
    if (!/^\d{8}/.test(parts.UNTIL)) return null
    return { ...rec, date, recurrenceEnd: _icsParseDate(parts.UNTIL), repeatForever: false }
  }
  if (parts.COUNT) {
    const count = parseInt(parts.COUNT, 10)
    if (!(count >= 1)) return null
    const cur = new Date(start)
    for (let i = 1; i < count; i++) stepRecurrenceDate(cur, rec)
    return { ...rec, date, recurrenceEnd: fmtDate(cur), repeatForever: false }
  }
  const yearStart = new Date(today.getFullYear(), 0, 1)
  const cur = new Date(start)
  while (cur < yearStart) stepRecurrenceDate(cur, rec)
  return { ...rec, date: fmtDate(cur), recurrenceEnd: '', repeatForever: true }
}

export function parseIcs (text, today = new Date()) {
  // Unfold folded lines (continuation lines begin with space or tab)
  const unfolded = text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '')
  const lines = unfolded.split(/\r\n|\r|\n/)
  const events = []
  let inEvent = false
  let cur = null

  for (const raw of lines) {
    if (raw.trim() === 'BEGIN:VEVENT') { inEvent = true; cur = {}; continue }
    if (raw.trim() === 'END:VEVENT') {
      inEvent = false
      if (cur && cur.title && cur.date) {
        const { rrule, ...ev } = cur
        const rec = rrule ? rruleToRecurrence(rrule, ev.date, today) : null
        if (rec && ev.endDate && rec.date !== ev.date) {
          // A forever series moved its start up to this year; keep the span.
          const days = Math.round((parseDate(rec.date) - parseDate(ev.date)) / 86400000)
          const end = parseDate(ev.endDate)
          end.setDate(end.getDate() + days)
          rec.endDate = fmtDate(end)
        }
        events.push(rec ? { ...ev, ...rec } : ev)
      }
      cur = null
      continue
    }
    if (!inEvent || !cur) continue

    const colonIdx = raw.indexOf(':')
    if (colonIdx < 0) continue
    const keyPart = raw.slice(0, colonIdx)
    const value   = raw.slice(colonIdx + 1)
    const semiIdx = keyPart.indexOf(';')
    const key     = semiIdx >= 0 ? keyPart.slice(0, semiIdx) : keyPart
    const params  = semiIdx >= 0 ? keyPart.slice(semiIdx + 1) : ''

    if (key === 'SUMMARY')     { cur.title    = _icsUnescape(value) }
    else if (key === 'DESCRIPTION') { cur.desc = _icsUnescape(value) }
    else if (key === 'LOCATION')    { cur.location = _icsUnescape(value) }
    else if (key === 'URL')         { cur.meetingLink = _icsUnescape(value) }
    else if (key === 'UID')         { cur.uid = value }
    else if (key === 'RRULE')       { cur.rrule = value }
    else if (key === 'X-PEARCAL-GROUPS') {
      cur.groups = value.split(',').map(s => s.trim()).filter(Boolean)
    }
    else if (key === 'DTSTART') {
      const allDay = params.includes('VALUE=DATE') || /^\d{8}$/.test(value)
      if (allDay) {
        cur.date   = _icsParseDate(value)
        cur.allDay = true
      } else {
        const { date, time } = _icsParseDateTime(value)
        cur.date   = date
        cur.start  = time
        cur.allDay = false
      }
    } else if (key === 'DTEND') {
      const allDay = params.includes('VALUE=DATE') || /^\d{8}$/.test(value)
      if (allDay) {
        // DTEND is exclusive for DATE values — subtract one day to get inclusive end
        const excl = _icsParseDate(value)
        const d = new Date(excl + 'T12:00:00')
        d.setDate(d.getDate() - 1)
        const incl = d.toISOString().slice(0, 10)
        if (incl !== cur.date) cur.endDate = incl
      } else {
        cur.end = _icsParseDateTime(value).time
      }
    }
  }
  return events
}

// Which of the groups named by the file (X-PEARCAL-GROUPS) we are actually a
// member of. Only a PearCal-exported .ics carries that property, so a file from
// Google/Apple/Outlook returns an empty set and the caller knows there is no
// "keep what the file says" option worth offering.
export function icsFileGroups (events, groupIds) {
  const memberIds = groupIds instanceof Set ? groupIds : new Set(groupIds ?? [])
  const ids = new Set()
  for (const ev of events ?? []) {
    if (!Array.isArray(ev.groups)) continue
    for (const gid of ev.groups) if (memberIds.has(gid)) ids.add(gid)
  }
  return ids
}

// Decide where each parsed event lands, and which ones we already have.
//
// `dest` is the user's answer to the import prompt:
//   'file'      keep the groups the .ics declared (dropping any we left)
//   'personal'  every event private to this device's owner
//   <groupId>   share every event with that one group
//
// Unknown group ids never survive: a file can name a group we are not in, and
// writing an event into it would strand the event where nobody can read it.
export function routeIcsImport (events, { dest = 'personal', groupIds = [], existingEventIds } = {}) {
  const memberIds = groupIds instanceof Set ? groupIds : new Set(groupIds ?? [])
  const existing = existingEventIds instanceof Set ? existingEventIds : new Set(existingEventIds ?? [])
  return (events ?? []).map(ev => {
    const uid = ev.uid ? ev.uid.replace(/@pearcal$/, '') : null
    const skipped = !!(uid && existing.has(uid))
    let keptGroups
    if (dest === 'file') {
      keptGroups = Array.isArray(ev.groups) ? ev.groups.filter(gid => memberIds.has(gid)) : []
    } else if (dest === 'personal') {
      keptGroups = []
    } else {
      keptGroups = memberIds.has(dest) ? [dest] : []
    }
    return { ev, uid, skipped, keptGroups }
  })
}

function _icsEscape (s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/,/g, '\\,').replace(/;/g, '\\;').replace(/\n/g, '\\n')
}

function _icsDate (dateStr) {
  return dateStr.replace(/-/g, '')
}

function _icsDateTime (dateStr, timeStr) {
  // Returns YYYYMMDDTHHMMSS (local time, no Z — avoids TZ conversion issues)
  return dateStr.replace(/-/g, '') + 'T' + timeStr.replace(/:/g, '') + '00'
}

// The fields that make two occurrences "the same event" for export.
function _occKey (ev) {
  return JSON.stringify([ev.title, !!ev.allDay, ev.start || '', ev.end || '', ev.desc || '',
    ev.location || '', ev.meetingLink || '', [...(ev.groups || [])].sort()])
}

// What the series' rule produces, judged from its first occurrence. A bounded
// series is exactly what expandRecurring made; a forever one runs to the last
// occurrence materialised so far.
function _expectedOccurrences (first, last) {
  if (!first.repeatForever) return expandRecurring({ ...first, recurrenceId: undefined })
  const out = []
  const cur = parseDate(first.date)
  const end = parseDate(last.date)
  while (cur <= end && out.length < 5000) {
    out.push(withBirthdayTitle({ ...first, date: fmtDate(cur) }))
    stepRecurrenceDate(cur, first)
  }
  return out
}

// One series as a single VEVENT + RRULE, or null when its stored occurrences
// no longer match the rule (one was edited, moved or deleted on its own). Those
// series export one VEVENT per occurrence as before: EXDATE and RECURRENCE-ID
// would describe them exactly, but our own importer does not read either yet,
// so a round trip would duplicate the edited dates.
function _collapseSeries (occs) {
  const sorted = [...occs].sort((a, b) => a.date.localeCompare(b.date))
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  if (!first.recurrence || first.recurrence === 'none') return null
  if (!first.repeatForever && !first.recurrenceEnd) return null
  const ruleKeys = ['recurrence', 'recurrenceInterval', 'recurrenceNth', 'recurrenceWeekday', 'recurrenceEnd', 'repeatForever', 'endDate']
  if (sorted.some(o => ruleKeys.some(k => (o[k] ?? '') !== (first[k] ?? '')))) return null
  const expected = _expectedOccurrences(first, last)
  if (expected.length !== sorted.length) return null
  for (let i = 0; i < sorted.length; i++) {
    if (expected[i].date !== sorted[i].date || _occKey(expected[i]) !== _occKey(sorted[i])) return null
  }

  const n = Math.max(1, Math.floor(Number(first.recurrenceInterval)) || 1)
  let rule
  if (first.recurrence === 'daily') rule = 'FREQ=DAILY'
  else if (first.recurrence === 'weekly') rule = 'FREQ=WEEKLY'
  else if (first.recurrence === 'biweekly') rule = 'FREQ=WEEKLY;INTERVAL=2'
  else if (first.recurrence === 'monthly') rule = 'FREQ=MONTHLY'
  else if (first.recurrence === 'monthly-nth') {
    rule = 'FREQ=MONTHLY;BYDAY=' + (first.recurrenceNth ?? 1) + _WEEKDAYS[first.recurrenceWeekday ?? 0]
  } else if (first.recurrence === 'yearly') rule = 'FREQ=YEARLY'
  else return null
  if (n > 1 && ['daily', 'weekly', 'monthly', 'yearly'].includes(first.recurrence)) rule += ';INTERVAL=' + n
  // UNTIL takes the same value type as DTSTART (RFC 5545 3.3.10).
  if (!first.repeatForever) {
    rule += ';UNTIL=' + _icsDate(first.recurrenceEnd) + (first.allDay ? '' : 'T235959')
  }
  // A birthday's first occurrence carries that year's age; the series doesn't.
  const title = first.birthday ? birthdayTitle({ ...first.birthday, year: null }, first.date) : first.title
  return { ...first, id: first.recurrenceId, title, rrule: rule }
}

export function generateIcs (events) {
  const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//PeerLoom LLC//PearCal//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ]
  // Occurrences of one series collapse back into a single VEVENT with an
  // RRULE (#184), so a round trip keeps the series and a forever series keeps
  // its later years.
  const bySeries = new Map()
  for (const ev of events) {
    if (!ev.recurrenceId || ev.isShadow) continue
    if (!bySeries.has(ev.recurrenceId)) bySeries.set(ev.recurrenceId, [])
    bySeries.get(ev.recurrenceId).push(ev)
  }
  const out = []
  const emitted = new Set()
  for (const ev of events) {
    const occs = !ev.isShadow && ev.recurrenceId ? bySeries.get(ev.recurrenceId) : null
    if (!occs) { out.push(ev); continue }
    if (emitted.has(ev.recurrenceId)) continue
    emitted.add(ev.recurrenceId)
    const series = _collapseSeries(occs)
    if (series) out.push(series)
    else out.push(...occs)
  }

  for (const ev of out) {
    lines.push('BEGIN:VEVENT')
    lines.push('UID:' + ev.id + '@pearcal')
    lines.push('DTSTAMP:' + now)
    if (ev.allDay) {
      lines.push('DTSTART;VALUE=DATE:' + _icsDate(ev.date))
      const endDate = ev.endDate || ev.date
      // DTEND is exclusive for all-day events
      const d = new Date(endDate + 'T12:00:00')
      d.setDate(d.getDate() + 1)
      lines.push('DTEND;VALUE=DATE:' + d.toISOString().slice(0,10).replace(/-/g,''))
    } else {
      lines.push('DTSTART:' + _icsDateTime(ev.date, ev.start || '00:00'))
      if (ev.end) lines.push('DTEND:' + _icsDateTime(ev.date, ev.end))
    }
    if (ev.rrule) lines.push('RRULE:' + ev.rrule)
    lines.push('SUMMARY:' + _icsEscape(ev.title))
    if (ev.desc)     lines.push('DESCRIPTION:' + _icsEscape(ev.desc))
    if (ev.location)    lines.push('LOCATION:' + _icsEscape(ev.location))
    if (ev.meetingLink) lines.push('URL:' + _icsEscape(ev.meetingLink))
    if (Array.isArray(ev.groups) && ev.groups.length) {
      lines.push('X-PEARCAL-GROUPS:' + ev.groups.join(','))
    }
    lines.push('END:VEVENT')
  }
  lines.push('END:VCALENDAR')
  return lines.join('\r\n')
}
