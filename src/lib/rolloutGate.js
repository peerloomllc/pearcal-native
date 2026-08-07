// Is a group clear for the indexer-model change yet? (TODO #159, proposal
// 2026-08-07-non-indexer-writers.)
//
// Kept pure and out of bare.js for the same reason as syncHealth.js: this is the
// decision that stops a calendar being forked, and a decision that important
// should be testable without a database or a device.
//
// THE RULE. Two peers that read the same addWriter op differently build
// different system state from it, which splits the calendar with no way back
// (measured in test/harness/indexer-rollout.js case C: one side counts three
// indexers and needs any two, the other counts two and needs both). So a peer
// may only start WRITING the `indexer` field for a group once every member is
// known to be on a build that READS it.

// Bumped when peers gain the ability to read the `indexer` field. Mirrors
// PROTOCOL_VERSION in bare.js; kept here so the pure logic has no import back.
const REQUIRED_VERSION = 2

// Peers from before the handshake existed send no version at all. Recorded as 1
// rather than left absent, so "on old code" and "never met" stay distinct - they
// need different wording to the user and, later, different handling.
const LEGACY_VERSION = 1

/**
 * @param {object[]} members  group members, each { id, name }
 * @param {object[]} devices  one per known device: { memberId, v }
 * @param {number}   required version a device must be at to count as ready
 */
function classifyRollout (members, devices, required = REQUIRED_VERSION) {
  const list = Array.isArray(members) ? members.filter(m => m && m.id) : []
  if (!list.length) return null

  // A member is only as new as their OLDEST device. Taking the newest, or the
  // most recently seen, would call a member ready while a second device of
  // theirs still applies ops the old way - which opens the gate early and forks
  // exactly the calendars this is meant to protect.
  const lowest = new Map()
  for (const d of (Array.isArray(devices) ? devices : [])) {
    if (!d || !d.memberId) continue
    const v = Number.isFinite(Number(d.v)) ? Number(d.v) : LEGACY_VERSION
    const prev = lowest.get(d.memberId)
    if (prev === undefined || v < prev) lowest.set(d.memberId, v)
  }

  const stale = []
  const unknown = []
  for (const m of list) {
    const v = lowest.get(m.id)
    if (v === undefined) unknown.push(m.name || m.id)
    else if (v < required) stale.push(m.name || m.id)
  }

  return {
    version: required,
    // Fails CLOSED. A member we have never heard from - departed, or merely
    // quiet - leaves the group ineligible and nothing changes for it. A group
    // stuck shut is visible and fixable; a group forked open is neither.
    ready: stale.length === 0 && unknown.length === 0,
    waitingOn: [...stale, ...unknown],
    staleCount: stale.length,
    neverSeen: unknown.length,
  }
}

module.exports = { classifyRollout, REQUIRED_VERSION, LEGACY_VERSION }
