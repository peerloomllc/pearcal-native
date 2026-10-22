// The personal keyring: a snapshot of what lives outside every shared
// calendar, so the 12 words bring it back too
// (proposals/2026-10-22-phrase-recovers-calendars.md section 4, step 5).
//
// It sits at its own address on the same seeders as the calendar list
// (keyring.js `personalLocator`), sealed with the same sign and box keys.
//
//   { v: 1,
//     events:    { <eventId>: event }            events in no shared calendar
//     notes:     { <eventId>: { text, updatedAt } }   private notes, any event
//     reminders: { <seriesId>: [ ... ] }         reminder settings, any event
//     deleted:   { <eventId>: ts } }             recent deletions
//
// Linked devices share one identity and so one address. Merging keeps, per
// event and per note, the later `updatedAt`, and drops an event deleted after
// its last change. Reminders have no time: a device's own value wins over the
// version it merges in. Deletions are kept 30 days. A deleted note has no
// record, so an older copy from another device can bring it back; that is
// the one loss this accepts.
//
// The seeder caps a version at 1 MB. Past events are dropped from the
// snapshot first, oldest first, until it fits (decided in the proposal).

const { sealAt, openAt } = require('./keyring.js')

const TOMBSTONE_MS = 30 * 24 * 60 * 60 * 1000
const MAX_NOTE = 10000
const MAX_EVENT_BYTES = 20000
const ID = /^[^\s\x00-\x1f]{1,200}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

function empty () {
  return { v: 1, events: {}, notes: {}, reminders: {}, deleted: {} }
}

const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x)
const time = (x) => (Number.isSafeInteger(x) && x >= 0 ? x : 0)

// Drops anything malformed, so a damaged or hostile snapshot cannot write
// bad rows into the database on a restore.
function clean (p) {
  const out = empty()
  if (!isObj(p) || p.v !== 1) return out
  for (const [id, e] of Object.entries(isObj(p.events) ? p.events : {})) {
    if (!ID.test(id) || !isObj(e) || e.id !== id || typeof e.date !== 'string' || !DATE.test(e.date)) continue
    if (Array.isArray(e.groups) && e.groups.length) continue
    if (JSON.stringify(e).length > MAX_EVENT_BYTES) continue
    out.events[id] = e
  }
  for (const [id, n] of Object.entries(isObj(p.notes) ? p.notes : {})) {
    if (!ID.test(id) || !isObj(n) || typeof n.text !== 'string' || !n.text || n.text.length > MAX_NOTE) continue
    out.notes[id] = { text: n.text, updatedAt: time(n.updatedAt) }
  }
  for (const [id, r] of Object.entries(isObj(p.reminders) ? p.reminders : {})) {
    if (!ID.test(id) || !Array.isArray(r) || r.length > 50) continue
    out.reminders[id] = r
  }
  for (const [id, ts] of Object.entries(isObj(p.deleted) ? p.deleted : {})) {
    if (ID.test(id) && time(ts)) out.deleted[id] = ts
  }
  return out
}

// `mine` is this device's snapshot, `theirs` the version from a seeder.
function merge (mine, theirs, now = Date.now()) {
  const a = clean(mine)
  const b = clean(theirs)
  const out = empty()
  for (const src of [b, a]) {
    for (const [id, ts] of Object.entries(src.deleted)) out.deleted[id] = Math.max(out.deleted[id] || 0, ts)
  }
  for (const [id, ts] of Object.entries(out.deleted)) if (ts < now - TOMBSTONE_MS) delete out.deleted[id]
  for (const src of [b, a]) {
    for (const [id, e] of Object.entries(src.events)) {
      const have = out.events[id]
      if (!have || time(e.updatedAt) >= time(have.updatedAt)) out.events[id] = e
    }
    for (const [id, n] of Object.entries(src.notes)) {
      const have = out.notes[id]
      if (!have || n.updatedAt >= have.updatedAt) out.notes[id] = n
    }
    // a is merged last, so its reminders win.
    Object.assign(out.reminders, src.reminders)
  }
  for (const [id, e] of Object.entries(out.events)) {
    if (out.deleted[id] && out.deleted[id] >= time(e.updatedAt)) delete out.events[id]
  }
  return out
}

// Sealed at the personal address. Past events go first, oldest first, until
// it fits the seeder's cap; `dropped` says how many.
function seal (p, keys, seq, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const value = clean(p)
  const past = Object.values(value.events).filter((e) => e.date < today).sort((x, y) => (x.date < y.date ? -1 : 1))
  let dropped = 0
  for (;;) {
    try {
      return { rec: sealAt(value, keys.personalLocator, keys, seq), dropped }
    } catch (e) {
      if (!/too large/i.test(e.message)) throw e
      if (!past.length) throw new Error('Your personal events are too large to back up')
      const n = Math.max(1, Math.ceil(past.length / 10))
      for (const ev of past.splice(0, n)) { delete value.events[ev.id]; dropped++ }
    }
  }
}

function open (rec, keys) {
  const v = openAt(rec, keys.personalLocator, keys)
  return v === null ? null : clean(v)
}

module.exports = { empty, clean, merge, seal, open, TOMBSTONE_MS }
