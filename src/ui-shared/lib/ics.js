// ICS / iCalendar parser + generator. Pure functions — no React, no DOM.
// Lifted unchanged from src/ui/App.jsx during the desktop-renderer fork
// so both UIs can import without dragging the whole calendar component.

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

export function parseIcs (text) {
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
      if (cur && cur.title && cur.date) events.push(cur)
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

export function generateIcs (events) {
  const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//PeerLoom LLC//PearCal//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ]
  for (const ev of events) {
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
