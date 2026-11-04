// Personal calendars and per-device calendar visibility (TODO #189, proposal
// proposals/2026-11-04-personal-calendars.md).
//
// A personal event (no groups) belongs to one personal calendar through its
// optional `calendarId`. A missing id means the implicit default calendar, which
// needs no stored row until it is renamed or recoloured, so events written
// before this feature need no migration.
//
// Calendar rows live at `personalCalendar:{id}` and sync to linked devices
// through the personal base, last-write-wins by `updatedAt`. Deleting a calendar
// writes `deleted: true` instead of removing the row, so an older put arriving
// later cannot bring it back.
//
// Visibility is a per-device list of hidden keys. It is not synced. Keys are
// `personal:{calendarId}`, `group:{groupId}`, `holiday:{countryCode}` and
// `sub:{subscriptionId}`.
//
// Shared by bare.js (widget filter, storage) and both UIs, so it is plain
// CommonJS with no dependencies.

const DEFAULT_CALENDAR_ID = 'default'
const DEFAULT_CALENDAR_NAME = 'Personal'
const CALENDAR_KEY_PREFIX = 'personalCalendar:'
const VISIBILITY_KEY = 'ui:calendarVisibility'
const NAME_MAX = 60

function calendarKey (id) { return CALENDAR_KEY_PREFIX + id }

function personalCalendarId (ev) {
  return (ev && typeof ev.calendarId === 'string' && ev.calendarId) || DEFAULT_CALENDAR_ID
}

function isPersonalEvent (ev) {
  return !(ev && Array.isArray(ev.groups) && ev.groups.length)
}

// Which visibility keys an event answers to. A group event shows while any of
// its groups is visible, which is how the desktop sidebar already behaved.
// `holidayKeysFor(ev)` returns the holiday keys claiming a built-in holiday
// event, or an empty list for anything else.
function visibilityKeys (ev, { holidayKeysFor } = {}) {
  // Read-only events from a web calendar subscription (phase 2).
  if (ev && ev.subscriptionId) return ['sub:' + ev.subscriptionId]
  if (!isPersonalEvent(ev)) return ev.groups.map(g => 'group:' + g)
  if (holidayKeysFor) {
    const keys = holidayKeysFor(ev)
    if (keys && keys.length) return keys
  }
  return ['personal:' + personalCalendarId(ev)]
}

function isEventVisible (ev, hidden, opts) {
  if (!hidden || hidden.size === 0) return true
  return visibilityKeys(ev, opts).some(k => !hidden.has(k))
}

// Visibility as stored: { hidden: string[], hiddenEventIds: string[] }.
// hiddenEventIds carries built-in holiday events whose countries are all
// hidden. The UI computes it because only the UI knows the holiday tables,
// and bare.js needs it to filter the home-screen widget.
function normalizeVisibility (v) {
  const hidden = Array.isArray(v?.hidden) ? v.hidden.filter(k => typeof k === 'string') : []
  const hiddenEventIds = Array.isArray(v?.hiddenEventIds) ? v.hiddenEventIds.filter(k => typeof k === 'string') : []
  return { hidden: [...new Set(hidden)], hiddenEventIds: [...new Set(hiddenEventIds)] }
}

// Widget filter, run inside bare.js on stored events.
function widgetEventVisible (ev, visibility) {
  if (!visibility) return true
  if (visibility.hiddenEventIds && visibility.hiddenEventIds.length &&
      visibility.hiddenEventIds.includes(ev?.id)) return false
  const hidden = visibility.hidden && visibility.hidden.length ? new Set(visibility.hidden) : null
  if (!hidden) return true
  return visibilityKeys(ev).some(k => !hidden.has(k))
}

function cleanName (name) {
  return String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX)
}

// Validate and stamp a calendar row before it is stored.
function makeCalendarRecord (input, prev, now = Date.now()) {
  const id = String(input?.id ?? '').trim()
  if (!id) throw new Error('calendar id required')
  if (id.includes(':')) throw new Error('calendar id must not contain ":"')
  const name = cleanName(input.name ?? prev?.name)
  if (!name && !input.deleted) throw new Error('calendar name required')
  if (input.deleted && id === DEFAULT_CALENDAR_ID) throw new Error('the default calendar cannot be deleted')
  const rec = {
    id,
    name: name || prev?.name || '',
    color: typeof input.color === 'string' ? input.color : (prev?.color ?? null),
    createdAt: prev?.createdAt ?? input.createdAt ?? now,
    updatedAt: Math.max(now, (prev?.updatedAt ?? 0) + 1),
  }
  if (input.deleted) rec.deleted = true
  return rec
}

// Last-write-wins between two versions of one row.
function newerCalendar (prev, next) {
  if (!next) return prev ?? null
  if (!prev) return next
  return (next.updatedAt ?? 0) > (prev.updatedAt ?? 0) ? next : prev
}

// The calendar list a UI shows: default first, then by creation, deleted rows
// dropped. The default appears even when no row exists for it.
function listCalendars (rows) {
  const byId = new Map()
  for (const r of rows ?? []) {
    if (!r?.id) continue
    byId.set(r.id, newerCalendar(byId.get(r.id), r))
  }
  const def = byId.get(DEFAULT_CALENDAR_ID)
  const out = [{
    id: DEFAULT_CALENDAR_ID,
    name: def?.name || DEFAULT_CALENDAR_NAME,
    color: def?.color ?? null,
    createdAt: def?.createdAt ?? 0,
    updatedAt: def?.updatedAt ?? 0,
    isDefault: true,
  }]
  const rest = [...byId.values()]
    .filter(r => r.id !== DEFAULT_CALENDAR_ID && !r.deleted)
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id))
  return out.concat(rest)
}

// The color an event is drawn in. A personal event in a calendar takes that
// calendar's color unless the user picked one for the event itself
// (`colorCustom`). Events written before this feature have no calendarId and
// keep the color they were saved with.
function eventDisplayColor (ev, calendarsById) {
  if (!ev || !isPersonalEvent(ev) || ev.colorCustom || !ev.calendarId) return ev?.color
  const cal = calendarsById?.get ? calendarsById.get(ev.calendarId) : calendarsById?.[ev.calendarId]
  return cal?.color || ev.color
}

// A group never learns which personal calendar an event came from.
function stripPersonalFields (ev) {
  if (!ev || typeof ev !== 'object') return ev
  if (!('calendarId' in ev) && !('colorCustom' in ev)) return ev
  const { calendarId, colorCustom, ...rest } = ev
  return rest
}

// What deleting calendar `id` does to its events: move them to `moveTo`, or
// delete them when `moveTo` is null. Only personal events in that calendar are
// touched; an event already shared with a group is left alone.
function planCalendarDelete (events, id, moveTo) {
  if (id === DEFAULT_CALENDAR_ID) throw new Error('the default calendar cannot be deleted')
  const mine = (events ?? []).filter(e => isPersonalEvent(e) && personalCalendarId(e) === id)
  if (moveTo == null) return { move: [], remove: mine }
  return {
    move: mine.map(e => ({ ...e, calendarId: moveTo })),
    remove: [],
  }
}

function newCalendarId (rand = Math.random) {
  return 'cal' + Date.now().toString(36) + rand().toString(36).slice(2, 8)
}

module.exports = {
  DEFAULT_CALENDAR_ID,
  DEFAULT_CALENDAR_NAME,
  CALENDAR_KEY_PREFIX,
  VISIBILITY_KEY,
  calendarKey,
  personalCalendarId,
  isPersonalEvent,
  visibilityKeys,
  isEventVisible,
  normalizeVisibility,
  widgetEventVisible,
  makeCalendarRecord,
  newerCalendar,
  listCalendars,
  eventDisplayColor,
  stripPersonalFields,
  planCalendarDelete,
  newCalendarId,
}
