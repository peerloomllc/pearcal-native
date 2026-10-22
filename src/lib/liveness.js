// Who is online right now, including members we only reach through another
// member (TODO #159 follow-up).
//
// A device used to count a writer as online only when that writer had
// announced on a connection that is still open. On real devices the signers
// often reach each other through a third member (the emulator and TCL did, via
// the Mac), so the owner saw connected, syncing members as offline: it would
// not promote them, and the "majority online" checks failed.
//
// Now each device periodically tells its direct peers which writers it sees,
// with how long ago it saw each one. Ages, not timestamps, so no two devices'
// clocks need to agree. A receiver records "seen at now - age" and passes the
// entry on with its own age, so liveness travels any number of hops but always
// keeps the age of the original sighting and expires LIVE_TTL_MS after it.
//
// Any member can claim another is online. The worst a liar achieves is the
// owner promoting a device that is not really there, which costs the group
// margin until the 14-day replacement; members are invited people, and this
// sits alongside the many other things a member can already write.

const LIVE_TTL_MS = 3 * 60 * 1000
const SHARE_INTERVAL_MS = 60 * 1000
const MAX_KEYS_PER_GROUP = 64
const HEX64 = /^[0-9a-f]{64}$/

/**
 * Entries to send to a peer for one group: every writer this device sees
 * directly (age 0), plus relayed sightings still inside the TTL.
 * @param {string[]} direct    writer keys announced on an open connection
 * @param {Map<string, number>} relayed  writer key -> seenAt (local clock)
 * @returns {Array<[string, number]>} [key, ageMs]
 */
function buildLiveSeen (direct, relayed, now) {
  const best = new Map()
  for (const k of direct) best.set(k, 0)
  for (const [k, seenAt] of relayed) {
    const age = now - seenAt
    if (age < 0 || age >= LIVE_TTL_MS) continue
    if (!best.has(k) || age < best.get(k)) best.set(k, age)
  }
  return [...best].slice(0, MAX_KEYS_PER_GROUP)
}

/**
 * Fold one received group's entries into `relayed`, keeping the most recent
 * sighting per writer. Ignores this device's own key, malformed keys and ages
 * outside [0, TTL).
 * @returns {number} how many entries were accepted
 */
function mergeLiveSeen (relayed, entries, myKey, now) {
  if (!Array.isArray(entries)) return 0
  let n = 0
  for (const e of entries.slice(0, MAX_KEYS_PER_GROUP)) {
    if (!Array.isArray(e) || e.length !== 2) continue
    const [k, age] = e
    if (typeof k !== 'string' || !HEX64.test(k) || k === myKey) continue
    if (!Number.isFinite(age) || age < 0 || age >= LIVE_TTL_MS) continue
    const seenAt = now - age
    if (!relayed.has(k) || relayed.get(k) < seenAt) relayed.set(k, seenAt)
    n++
  }
  return n
}

function isRelayedLive (relayed, key, now) {
  const seenAt = relayed.get(key)
  return seenAt !== undefined && now - seenAt < LIVE_TTL_MS
}

module.exports = { buildLiveSeen, mergeLiveSeen, isRelayedLive, LIVE_TTL_MS, SHARE_INTERVAL_MS, MAX_KEYS_PER_GROUP }
