// Issue #264: changing an event's date must MOVE its row, not delete the old
// one and create a new one.
//
// An event row is keyed `events:{date}:{id}`, so a date change necessarily
// touches two keys. The save path used to do that as deleteEvent(prevDate, id)
// followed by putEvent(newEvent), which looks harmless until you notice that
// every cleanup deleteEvent performs is keyed by event ID, not by date. It
// tombstones `deleted:{id}` and drops `reminders:{id}`, `privateNotes:{id}` and
// the event's RSVPs - all of which belong to the row just written at the new
// date. The tombstone then blocks that row from ever being mirrored again, and
// on a paired sibling device the replicated `del` op lands before the `put` is
// mirrored, so the sibling deletes the event and refuses the put that would
// bring it back.
//
// Same shape as the group-scoped tombstone bug in TODO #122, so the same
// remedy: the decisions live here as pure functions (bare.js touches BareKit at
// load and can't be required from tests) and bare.js just executes the plan.

'use strict'

const EVENTS_PREFIX = 'events:'
const DELETED_PREFIX = 'deleted:'

function eventKey (date, id) {
  return EVENTS_PREFIX + date + ':' + id
}

// Which date is this save moving the event away from, if any? Returns null for
// an ordinary in-place save, including the no-op case where `_prevDate` merely
// echoes the unchanged date.
function movedFromDate (event) {
  const prev = event?._prevDate
  if (!prev || !event?.date || !event?.id) return null
  return prev === event.date ? null : prev
}

// Everything the local write for one putEvent call has to do.
//   putKey            row to write
//   delKeys           rows to drop, i.e. the vacated date when moving
//   clearTombstoneKey stale `deleted:{id}` to clear. An explicit user save
//                     contradicts a tombstone for the same id, so clearing it
//                     also heals events moved by a build that wrote one.
//   tombstoneKeys     always empty. A save never tombstones - that is the whole
//                     point of the fix, so it is asserted rather than implied.
function planEventWrite (event) {
  const movedFrom = movedFromDate(event)
  return {
    movedFrom,
    putKey: eventKey(event.date, event.id),
    delKeys: movedFrom ? [eventKey(movedFrom, event.id)] : [],
    clearTombstoneKey: DELETED_PREFIX + event.id,
    tombstoneKeys: [],
  }
}

// Value to append to the personal base for this save. `_prevDate` has to travel
// with it so a sibling device relocates its own row instead of keeping a copy at
// each date - mirrorToLocal already acts on the field. A non-move append carries
// no `_prevDate` at all, leaving the op byte-identical to what earlier builds
// produced.
function personalAppendValue (stored, movedFrom) {
  return movedFrom ? { ...stored, _prevDate: movedFrom } : stored
}

module.exports = {
  eventKey,
  movedFromDate,
  planEventWrite,
  personalAppendValue,
}
