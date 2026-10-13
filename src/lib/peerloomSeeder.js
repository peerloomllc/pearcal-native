// PeerLoom Seeder records (proposals/2026-10-13-peerloom-seeder.md). A member
// who paired a phone with PeerLoom Seeder (the shared seeder for every PeerLoom
// app) writes `pseeder:{seederKey}` into a group, and every member then backs
// the group up to that seeder.
//
//   pseeder:{seederKey} -> {
//     seederKey:  hex64  - the seeder (matches the key suffix)
//     writer:     hex64  - profile publicKey that signed this row
//     addedBy:    hex64  - publicKey of whoever added it; never changes
//     addedAt:    number - never changes
//     updatedAt:  number - LWW
//     revoked?:   true, with revokedAt and revokedBy
//     v: 1, sig: hex128  - Ed25519 over canonical(rest) by `writer`
//   }
//
// Unlike `seeder:` rows these are signed, because who may write a later row
// matters: the first row may come from any member (and names them addedBy);
// any later row (revoke, re-admit) only from the group owner or addedBy.
// Old PearCal versions store the rows (their apply puts any type) but never
// read them.

const { signMessage, verifySignature } = require('./sign.js')

const PREFIX = 'pseeder:'
const HEX64 = /^[0-9a-f]{64}$/
const FUTURE_MS = 10 * 60 * 1000

const recordKey = (seederKey) => PREFIX + seederKey
function parseRecordKey (key) {
  if (typeof key !== 'string' || !key.startsWith(PREFIX)) return null
  const k = key.slice(PREFIX.length).toLowerCase()
  return HEX64.test(k) ? k : null
}

// A signed row. `existing` keeps addedBy and addedAt; `revoked` true revokes,
// false re-admits.
function buildRecord ({ seederKey, writer, secretKey, existing = null, revoked = false, now = Date.now() }) {
  const prev = existing && existing.seederKey === seederKey ? existing : null
  const row = {
    seederKey,
    writer,
    addedBy: prev ? prev.addedBy : writer,
    addedAt: prev ? prev.addedAt : now,
    updatedAt: Math.max(now, prev ? prev.updatedAt + 1 : now),
    v: 1
  }
  if (revoked) { row.revoked = true; row.revokedAt = now; row.revokedBy = writer }
  return { ...row, sig: signMessage(row, secretKey) }
}

// Signing keys are member publicKeys. A member's `id` is not always its
// publicKey (profiles made from a recovery identity derive the id), so the
// owner's key is looked up through members[].
const keysOf = (group) => new Set(((group && group.members) || []).map((m) => m && m.publicKey).filter(Boolean))
function ownerKeyOf (group) {
  const owner = ((group && group.members) || []).find((m) => m && m.id === group.ownerId)
  return (owner && owner.publicKey) || null
}

// The apply rule. `group` is the group record from the same view (ownerId,
// members[] with id and publicKey); `now` bounds future timestamps.
function acceptRecord ({ key, incoming, existing = null, group, now = Date.now() }) {
  const seederKey = parseRecordKey(key)
  if (!seederKey || !incoming || typeof incoming !== 'object') return false
  const { sig, ...row } = incoming
  if (row.v !== 1 || row.seederKey !== seederKey) return false
  if (!HEX64.test(row.writer || '') || !HEX64.test(row.addedBy || '')) return false
  for (const t of ['addedAt', 'updatedAt']) {
    if (typeof row[t] !== 'number' || !Number.isFinite(row[t]) || row[t] > now + FUTURE_MS) return false
  }
  if (row.updatedAt < row.addedAt) return false
  if (row.revoked === true && (typeof row.revokedAt !== 'number' || row.revokedBy !== row.writer)) return false
  if (typeof sig !== 'string' || !verifySignature(row, sig, row.writer)) return false
  if (!keysOf(group).has(row.writer)) return false
  if (!existing) return row.addedBy === row.writer
  if (row.addedBy !== existing.addedBy || row.addedAt !== existing.addedAt) return false
  if (!(row.updatedAt > existing.updatedAt)) return false
  return row.writer === ownerKeyOf(group) || row.writer === existing.addedBy
}

// Who may change a row (`me` is a publicKey): the owner and whoever added it.
const canChange = ({ me, existing, group }) => !existing || me === ownerKeyOf(group) || me === existing.addedBy

module.exports = { PREFIX, recordKey, parseRecordKey, buildRecord, acceptRecord, canChange }
