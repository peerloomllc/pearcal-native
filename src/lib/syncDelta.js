// TODO #141(a) - merging the debounced sync deltas the UI patches state from.
//
// bare.js coalesces sync emissions over a 50ms window so a burst from a mirror
// loop becomes one message. Merging two deltas used to be:
//
//   for (const e of a.changedEvents) map.set(e.id, e)
//   for (const e of b.changedEvents) map.set(e.id, e)
//   for (const id of removedIds) map.delete(id)      // <- always last
//
// so a removal ALWAYS beat a change to the same id, whichever arrived first.
// That is right for the case it was written for (a delete plus unrelated
// changes) and wrong the moment one id is both removed and re-written inside a
// single window - the re-write is dropped and the UI is told only "gone". It
// was a load-bearing part of how #264's date move made an event vanish: the
// delete-then-put emitted a removal and a change for the same id, and the
// removal won regardless of order.
//
// The rule now is simply last-writer-wins, because `a` is the pending delta and
// `b` is the newer one: apply each delta in order, and within each apply the
// removals before the changes so a delta that somehow carries both for one id
// resolves to the change (a row the caller just wrote is the more useful thing
// to tell the UI about than a row it says is gone).
//
// Pure so it is unit-testable - bare.js touches BareKit at load and cannot be
// required from tests. Same split as eventTombstone.js and eventMove.js.

'use strict'

function mergeSyncDelta (a, b) {
  if (!a) return b
  if (!b) return a

  const out = {}
  if (a.fullReload || b.fullReload) out.fullReload = true
  if (a.groupChanged || b.groupChanged) out.groupChanged = true
  if (a.rsvpsChanged || b.rsvpsChanged) out.rsvpsChanged = true

  const changed = new Map()
  const removed = new Set()

  // `a` first, then `b`: whichever delta spoke LAST about an id decides it.
  for (const delta of [a, b]) {
    for (const id of (delta.removedIds ?? [])) {
      changed.delete(id)
      removed.add(id)
    }
    for (const e of (delta.changedEvents ?? [])) {
      if (!e || e.id === undefined) continue
      removed.delete(e.id)
      changed.set(e.id, e)
    }
  }

  if (changed.size) out.changedEvents = [...changed.values()]
  if (removed.size) out.removedIds = [...removed]
  return out
}

module.exports = { mergeSyncDelta }
