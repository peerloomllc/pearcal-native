// Links between PearCal and PearOffice
// (/home/tim/peerloomllc/proposals/2026-10-26-pearcal-pearoffice-links.md).
//
// PearCal stores nothing new: links live in an event's description as plain
// text. This file finds them, checks them against exact patterns and works out
// what an incoming pearcal:// event or day link points at.
//
// Formats:
//   pearoffice://file/<43 chars of A-Z a-z 0-9 _ ->
//   pearoffice://folder/<32 hex>
//   pearcal://event/<calendarId>/<eventId>   calendarId: 1-64 of A-Z a-z 0-9 _ -
//                                            eventId: percent-encoded, 1-256 chars
//   pearcal://day/<YYYY-MM-DD>

const OFFICE = /^pearoffice:\/\/(?:file\/([A-Za-z0-9_-]{43})|folder\/([0-9a-fA-F]{32}))$/
const EVENT = /^pearcal:\/\/event\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9._~%-]{1,256})$/
const DAY = /^pearcal:\/\/day\/(\d{4})-(\d{2})-(\d{2})$/
const CALENDAR_ID = /^[A-Za-z0-9_-]{1,64}$/

export const PEAROFFICE_PAGE = 'https://peerloomllc.com/pearoffice/'

function validDay (y, m, d) {
  const dt = new Date(Date.UTC(+y, +m - 1, +d))
  return dt.getUTCFullYear() === +y && dt.getUTCMonth() === +m - 1 && dt.getUTCDate() === +d
}

// What a link points at, or null for anything that is not exactly one of the
// formats above.
//   { kind: 'file', id } | { kind: 'folder', id }
//   { kind: 'event', calendarId, eventId } | { kind: 'day', date }
export function parsePearLink (href) {
  if (typeof href !== 'string') return null
  let m = OFFICE.exec(href)
  if (m) return m[1] ? { kind: 'file', id: m[1] } : { kind: 'folder', id: m[2] }
  m = EVENT.exec(href)
  if (m) {
    let eventId
    try { eventId = decodeURIComponent(m[2]) } catch { return null }
    if (!eventId) return null
    return { kind: 'event', calendarId: m[1], eventId }
  }
  m = DAY.exec(href)
  if (m && validDay(m[1], m[2], m[3])) return { kind: 'day', date: `${m[1]}-${m[2]}-${m[3]}` }
  return null
}

export function isPearcalLink (href) {
  const l = parsePearLink(href)
  return !!l && (l.kind === 'event' || l.kind === 'day')
}

export function eventLink (calendarId, eventId) {
  if (typeof calendarId !== 'string' || !CALENDAR_ID.test(calendarId)) return null
  if (typeof eventId !== 'string' || !eventId) return null
  const url = 'pearcal://event/' + calendarId + '/' + encodeURIComponent(eventId)
  return parsePearLink(url) ? url : null
}

export function dayLink (date) {
  const url = 'pearcal://day/' + date
  return parsePearLink(url) ? url : null
}

// Every PearOffice or PearCal link in a piece of text, in order, each once.
// A candidate runs up to whitespace or a bracket or quote; trailing sentence
// punctuation is dropped, then the rest has to match a format exactly.
export function linksInText (text) {
  if (!text || typeof text !== 'string') return []
  const out = []
  const seen = new Set()
  const re = /(?:pearoffice|pearcal):\/\/[^\s<>"'()[\]{}]+/g
  let m
  while ((m = re.exec(text))) {
    const url = m[0].replace(/[.,;:!?]+$/, '')
    if (seen.has(url)) continue
    const link = parsePearLink(url)
    if (!link) continue
    seen.add(url)
    out.push({ url, ...link })
  }
  return out
}

export function formatLinkDay (date) {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined,
    { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
}

// The label for a link row.
export function pearLinkLabel (link) {
  if (!link) return ''
  if (link.kind === 'file') return 'PearOffice file'
  if (link.kind === 'folder') return 'PearOffice folder'
  if (link.kind === 'event') return 'PearCal event'
  if (link.kind === 'day') return formatLinkDay(link.date)
  return ''
}

// The app that opens a link, for the "isn't installed" message. Only
// pearoffice: links leave PearCal.
export function otherAppFor (href) {
  if (typeof href === 'string' && href.startsWith('pearoffice:')) return { name: 'PearOffice', page: PEAROFFICE_PAGE }
  return null
}

// The series an event id belongs to. Occurrences are '<root>_r<N>', a series
// whose cadence changed restarts at '<root>_v<V>' (occurrences
// '<root>_v<V>_r<N>'), and all of them keep recurrenceId '<root>'.
export function seriesIdOf (eventId) {
  return String(eventId).replace(/(?:_v\d+)?(?:_r\d+)?$/, '')
}

// What an event link opens, from this person's own events:
//   { event }               the occurrence itself
//   { event, series: true } the occurrence is gone, so the series' first event
//   { missing: true }       this person does not have it in that calendar
export function findLinkedEvent (events, calendarId, eventId) {
  const inCal = (events || []).filter(e => e && !e.isShadow && (e.groups || []).includes(calendarId))
  const exact = inCal.find(e => e.id === eventId)
  if (exact) return { event: exact }
  const sid = seriesIdOf(eventId)
  const series = inCal.filter(e => e.id === sid || e.recurrenceId === sid)
  if (series.length) {
    const root = series.find(e => e.id === sid) ||
      series.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))[0]
    return { event: root, series: true }
  }
  return { missing: true }
}

// Tapping a link row. A pearcal:// link opens here in the app (the App listens
// for pear:openLink). Anything else goes to the system through sync.openURL,
// which answers false when nothing opened it; for a pearoffice:// link the App
// then shows "PearOffice isn't installed on this device" (pear:appMissing).
export async function openPearLink (url, sync) {
  if (isPearcalLink(url)) {
    window.dispatchEvent(new CustomEvent('pear:openLink', { detail: url }))
    return
  }
  let ok = null
  try { ok = await sync?.openURL?.(url) } catch { ok = false }
  const app = otherAppFor(url)
  if (ok === false && app) window.dispatchEvent(new CustomEvent('pear:appMissing', { detail: app }))
}

export const MISSING_EVENT_MESSAGE = "You don't have this event. Ask someone in its calendar to invite you."
