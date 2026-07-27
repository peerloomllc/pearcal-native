// TODO #125 - a followed blind peer stayed listed forever with a group count
// frozen at pair time.
//
// Two different things were wrong and it is worth keeping them apart.
//
// 1. THE COUNT WAS A FOSSIL. `seederFollow:` rows store `groupCount: enrolled`,
//    written once when the seeder was paired, and the list rendered it as if it
//    were current. Observed on the TCL: "Seeding 2 groups" for a seeder that was
//    actually serving one group the device was not even in.
//
// 2. NOTHING EVER SAID "this serves nothing of yours". `listBlindPeers` filters
//    group-shared `groupSeeder:` rows against live groups - the "reappears
//    seeding 0 groups" orphan guard - but applied no equivalent to local
//    follows, so an admitted seeder stayed on the list regardless.
//
// The fix for (1) is to stop reporting a cached number at all: count the live
// `groupSeeder:` rows each time the list is read. That is derived state, so it
// cannot go stale.
//
// The fix for (2) is deliberately to MARK, not hide, per the item: silently
// dropping a seeder the user chose to admit is its own confusion. Removal should
// be an informed choice.
//
// The `null` case matters. A device with no groups at all cannot say anything
// useful about whether a seeder serves "your groups" - the answer is vacuously
// no, and showing "not seeding any of your groups" to someone with no groups
// reads as a fault. So the decision has three states and the UI stays quiet on
// the third.

'use strict'

// How this seeder stands relative to the groups this device actually has.
//
//   { groupsServed, servesCurrentGroups }
//
//   groupsServed         how many of THIS DEVICE'S current groups it serves,
//                        counted fresh. Never the cached pair-time number.
//   servesCurrentGroups  true / false / null, where null means "no useful
//                        answer" rather than "no".
//
// `servedGroupIds` is every groupId with a `groupSeeder:` row for this pubkey;
// `liveGroupIds` is the set of groups open on this device. Both are supplied by
// the caller so this stays pure.
function summariseSeederCoverage ({ servedGroupIds, liveGroupIds } = {}) {
  const live = liveGroupIds instanceof Set ? liveGroupIds : new Set(liveGroupIds ?? [])
  const served = new Set()
  for (const id of servedGroupIds ?? []) {
    if (id && live.has(id)) served.add(id)
  }
  const groupsServed = served.size
  // No groups on this device: the question is not answerable in a way worth
  // showing. Not the same as a seeder that serves none of several groups.
  if (live.size === 0) return { groupsServed: 0, servesCurrentGroups: null }
  return { groupsServed, servesCurrentGroups: groupsServed > 0 }
}

// What the list should show under a seeder's name, given the summary above.
//
// Returned as data rather than a bare string so the caller can style the warn
// case, and computed here rather than in the view so the wording travels with
// the decision. Only mobile renders a blind-peer list today - the desktop proxy
// has no `listBlindPeers` at all, just the older single-key API - so this is one
// UI for now, and the point is that a second one gets the sentence for free
// rather than inventing its own.
function seederCoverageLabel (summary) {
  const { groupsServed, servesCurrentGroups } = summary ?? {}
  if (servesCurrentGroups === null || servesCurrentGroups === undefined) return null
  if (!servesCurrentGroups) {
    return { tone: 'warn', text: 'Not seeding any of your groups' }
  }
  return {
    tone: 'normal',
    text: groupsServed === 1 ? 'Seeding 1 group' : `Seeding ${groupsServed} groups`,
  }
}

module.exports = {
  summariseSeederCoverage,
  seederCoverageLabel,
}
