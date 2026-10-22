// Does a PeerLoom Seeder hold a calendar's data in full? (TODO #181)
//
// "Your calendar list is backed up" only says the seeder holds the list. A
// restore then needs every member's writes for each calendar from the seeder
// too, and on the TCL test (#180) five calendars came back empty because it
// did not. Each pull from a seeder looks at how much of every writer core the
// seeder has (its contiguous length on that connection) against what this
// device has, and records the result per calendar and seeder.

// One writer core: 'held' when the seeder has at least what this device has,
// 'missing' when it has less or never opened the core, 'unknown' when this
// device has none of it either and so cannot judge.
function writerHeld ({ localLength, seederContiguous }) {
  if (!localLength) return 'unknown'
  if (seederContiguous == null) return 'missing'
  return seederContiguous >= localLength ? 'held' : 'missing'
}

// A calendar on one seeder: complete when no writer is missing and at least
// one is held.
function groupCoverage (writers) {
  let held = 0
  let missing = 0
  for (const w of writers) {
    const s = writerHeld(w)
    if (s === 'held') held++
    else if (s === 'missing') missing++
  }
  return { complete: missing === 0 && held > 0, missing }
}

// For Settings: across this device's calendars, which are fully on at least
// one paired seeder, which were checked and are not, and which have not been
// checked yet. `records` is groupId -> { seederKey: { complete } }.
function summarise (groups, records, pairedKeys) {
  const out = { total: groups.length, complete: 0, incomplete: [], checking: [] }
  for (const g of groups) {
    const rec = records[g.id] || {}
    const mine = pairedKeys.filter((k) => rec[k])
    if (mine.some((k) => rec[k].complete)) out.complete++
    else if (mine.length) out.incomplete.push(g.name || 'Calendar')
    else out.checking.push(g.name || 'Calendar')
  }
  return out
}

module.exports = { writerHeld, groupCoverage, summarise }
