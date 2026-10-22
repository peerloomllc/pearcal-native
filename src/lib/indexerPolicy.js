// Which devices should sign for a group? (TODO #159, proposal
// 2026-08-07-non-indexer-writers.)
//
// Kept pure and out of bare.js for the same reason as rolloutGate.js: this
// decides who can finalise a calendar's history, and a decision that important
// should be testable without a database or a device.
//
// Everything here is expressed as `{ addWriter: k, indexer: true|false }` ops.
// Release N (v1.0.43) taught every peer to read that field, and Autobase treats
// `indexer: false` on an EXISTING indexer as a demotion: the device stays a
// writer and stops signing (test/harness/indexer-demote.js L, M and N). So the
// swap and the repair need no new op type. Demotions also carry `demote: true`
// so apply can tell them from a plain grant, which must never demote.
//
// THE POLICY, from the proposal's "The policy" section:
//   1. The signer set is 1 or 3, never 2 by our hand. A calendar stays at one
//      until it can go straight to three. Groups already at 2 are topped up.
//   2. Only one device proposes: the owner's lowest-keyed online device,
//      signer or not (an owner restored onto a new phone joins as a plain
//      writer). If no owner device has been seen for OWNER_AWAY_MS, the
//      lowest-keyed online signer that is not the owner's stands in. Two
//      proposers promoting different devices is the one way to end up worse,
//      hence the long wait; if it happens anyway the result is four signers,
//      which the next run repairs.
//   3. Only promote a device that is connected now, on a build that reads the
//      field, a current member, and has been around for a stability window.
//   4. Replace, never shrink. A dead signer is demoted in the same batch that
//      promotes its replacement, so the set never passes through two.
//   5. Never propose while a majority of signers is not reachable. The op could
//      not take effect anyway (harness scenario H).
// Plus the repair for groups already over-indexed (scenario K): when a majority
// is online together, cut the set to three in one batch.

// How long a device must have been seen in this group before it may sign. A
// device that joins once and never returns would otherwise become a dead
// signer, which is the problem this whole change exists to fix.
const STABLE_MS = 24 * 60 * 60 * 1000

// How long a signer can go unseen before a three-signer group replaces it.
// Long on purpose: a replacement costs nothing if the device is truly gone, but
// demoting a phone that was merely on holiday spends the group's one spare.
const DEAD_MS = 14 * 24 * 60 * 60 * 1000

// How long the owner must be unseen before another signer stands in as the
// proposer. A week, so an owner who is merely offline for a weekend never
// races a stand-in.
const OWNER_AWAY_MS = 7 * 24 * 60 * 60 * 1000

// How many signers a group aims for. Three can lose one and keep signing;
// four is worse than three (majority 3 vs 2), see the proposal.
const TARGET = 3

/**
 * @param {object}   s
 * @param {string}   s.myKey        this device's writer key (hex)
 * @param {boolean}  s.isOwner      this device belongs to the group owner
 * @param {boolean}  s.gateReady    every member is on a build at s.minVersion
 * @param {number}   s.minVersion   version a device must run to be promoted
 * @param {string[]} s.indexers     current signer keys, from the live base
 * @param {object[]} s.writers      known devices in this group, each
 *   { key, memberId, identity, v, firstSeen, lastSeen, live }
 * @param {string[]} s.activeMemberIds  current members (not removed)
 * @param {string}   s.myIdentity   this device's identity key (hex)
 * @param {string}   s.ownerIdentity  the owner's identity key, if known
 * @param {number}   s.ownerLastSeen  newest lastSeen over the owner's devices
 * @param {number}   s.now
 * @returns {{ ops: object[], reason: string }}
 */
function decideIndexerChange (s) {
  const none = reason => ({ ops: [], reason })
  if (!s || !s.gateReady) return none('gate closed')
  const indexers = Array.isArray(s.indexers) ? s.indexers : []
  const amSigner = indexers.includes(s.myKey)

  const now = s.now
  const byKey = new Map()
  for (const w of (Array.isArray(s.writers) ? s.writers : [])) if (w && w.key) byKey.set(w.key, w)
  const active = new Set(s.activeMemberIds || [])
  const live = k => k === s.myKey || !!byKey.get(k)?.live

  // Rule 2: one proposer.
  if (s.isOwner) {
    // The owner may have several devices; only the lowest-keyed online one
    // acts, whether or not it signs.
    const ownerLive = [...byKey.values()].filter(w => w.live && s.myIdentity && w.identity === s.myIdentity).map(w => w.key)
    if (ownerLive.some(k => k < s.myKey)) return none('another owner device proposes')
  } else {
    if (!amSigner) return none('not the owner')
    const isOwnerDevice = k => !!s.ownerIdentity && byKey.get(k)?.identity === s.ownerIdentity
    if ([...byKey.values()].some(w => w.live && isOwnerDevice(w.key))) return none('owner is online')
    if (!Number.isFinite(s.ownerLastSeen) || now - s.ownerLastSeen < OWNER_AWAY_MS) return none('not the owner')
    const standIns = indexers.filter(k => live(k) && !isOwnerDevice(k))
    if (standIns.some(k => k < s.myKey)) return none('another signer stands in')
  }

  // Rule 5: a majority of the CURRENT set must be reachable.
  const majority = Math.floor(indexers.length / 2) + 1
  const liveIndexers = indexers.filter(live)
  if (liveIndexers.length < majority) return none('quorum unreachable')

  // Rule 3: who may be promoted.
  const eligible = w => w && w.live && w.key !== s.myKey &&
    !indexers.includes(w.key) &&
    Number(w.v) >= s.minVersion &&
    w.memberId && active.has(w.memberId) &&
    Number.isFinite(w.firstSeen) && now - w.firstSeen >= STABLE_MS
  // Prefer devices of people who do not already sign, so one person turning
  // their phone off cannot take out two signers. Then lowest key, so two runs
  // over the same state choose the same device.
  const rankCandidates = (taken) => {
    const signingIds = new Set(taken.map(k => k === s.myKey ? s.myIdentity : byKey.get(k)?.identity).filter(Boolean))
    return [...byKey.values()].filter(eligible).sort((a, b) => {
      const da = a.identity && signingIds.has(a.identity) ? 1 : 0
      const db = b.identity && signingIds.has(b.identity) ? 1 : 0
      return da - db || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
    }).map(w => w.key)
  }
  const promote = k => ({ addWriter: k, indexer: true })
  // `demote: true` is what tells apply this is a demotion and not a plain
  // grant, which is a no-op for an existing writer (bare.js group apply).
  const demote = k => ({ addWriter: k, indexer: false, demote: true })

  if (indexers.length > TARGET) {
    // Repair. Keep live signers that are still members, me first, then fill
    // from candidates; everything else is demoted in the same batch.
    const keepable = liveIndexers.filter(k => k === s.myKey || active.has(byKey.get(k)?.memberId))
    const keep = [...(amSigner ? [s.myKey] : []), ...keepable.filter(k => k !== s.myKey).sort()].slice(0, TARGET)
    const fill = rankCandidates(keep).slice(0, TARGET - keep.length)
    const target = [...keep, ...fill]
    if (target.length < TARGET) return none('not enough live devices to choose three')
    return {
      ops: [...fill.map(promote), ...indexers.filter(k => !target.includes(k)).map(demote)],
      reason: 'repair ' + indexers.length + ' -> ' + TARGET,
    }
  }

  if (indexers.length === TARGET) {
    // Swap out signers that are gone: unseen for DEAD_MS, or no longer a member.
    const gone = indexers.filter(k => {
      if (live(k)) return false
      const w = byKey.get(k)
      if (w?.memberId && !active.has(w.memberId)) return true
      const seen = Number.isFinite(w?.lastSeen) ? w.lastSeen : null
      return seen !== null && now - seen >= DEAD_MS
    })
    if (!gone.length) return none('healthy')
    const fill = rankCandidates(indexers.filter(k => !gone.includes(k))).slice(0, gone.length)
    if (!fill.length) return none('signer gone, no replacement online')
    const out = gone.slice(0, fill.length)
    return { ops: [...fill.map(promote), ...out.map(demote)], reason: 'replace ' + out.length }
  }

  // Growth: 1 -> 3 in one batch, or 2 -> 3.
  const need = TARGET - indexers.length
  const fill = rankCandidates(indexers).slice(0, need)
  if (fill.length < need) return none('waiting for devices')
  return { ops: fill.map(promote), reason: 'grow ' + indexers.length + ' -> ' + TARGET }
}

module.exports = { decideIndexerChange, STABLE_MS, DEAD_MS, OWNER_AWAY_MS, TARGET }
