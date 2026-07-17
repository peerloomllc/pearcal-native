// Group-shared blind-seeder record (proposal 2026-07-17-group-shared-seeder-record).
// A member writes `seeder:{pubkey}` into a group's Autobase view so the seeder is
// visible in EVERY member's Blind Peer list — not just the admitter's — and to lay
// the foundation for group-wide revocation. Unlike PearCircle's signed rows, PearCal
// relies on the group Autobase's writer-authorization (only admitted members can
// append), matching how `event`/`group`/`groupMembership` records work — so no
// per-row signature. This module is the pure shape/LWW logic, kept separate so it's
// unit-testable without the bare runtime.
//
//   seeder:{pubkey} → {
//     pubkey:    hex64  — seeder identity (matches the key suffix)
//     nickname:  string | null  — shared name shown to all members
//     addedBy:   hex    — identity of the first admitter (preserved on re-admit)
//     addedAt:   number — first-admission ms
//     updatedAt: number — LWW ordering; every write bumps it
//     v:         1
//     revoked?, revokedAt?, revokedBy?   — reserved for Phase 2 (group-wide revoke)
//   }

'use strict'

const KEY_PREFIX = 'seeder:'
const HEX64 = /^[0-9a-f]{64}$/i
const HEX_MIN = /^[0-9a-f]{16,}$/i

function isHex64 (s) { return typeof s === 'string' && HEX64.test(s) }
function isHexKey (s) { return typeof s === 'string' && HEX_MIN.test(s) }

// View key for a seeder record.
function seederRecordKey (pubkey) { return KEY_PREFIX + String(pubkey).toLowerCase() }

// Recover the seeder pubkey from a `seeder:{pubkey}` view key (null if malformed).
function parseSeederRecordKey (key) {
  if (typeof key !== 'string' || !key.startsWith(KEY_PREFIX)) return null
  const pk = key.slice(KEY_PREFIX.length)
  return isHex64(pk) ? pk.toLowerCase() : null
}

// Shape/consistency check for a mirrored/applied record. Strict on the security-
// relevant field (pubkey must equal the key suffix) + timestamps; loose on the
// informational fields (nickname, addedBy).
function isValidSeederRecord (value, keyPubkey, now = Date.now(), futureToleranceMs = 5 * 60 * 1000) {
  if (!value || typeof value !== 'object') return false
  if (!isHex64(value.pubkey)) return false
  if (keyPubkey != null && value.pubkey.toLowerCase() !== String(keyPubkey).toLowerCase()) return false
  if (typeof value.addedAt !== 'number' || !Number.isFinite(value.addedAt)) return false
  if (typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)) return false
  if (value.addedAt > now + futureToleranceMs) return false
  if (value.updatedAt > now + futureToleranceMs) return false
  if (value.updatedAt < value.addedAt) return false
  if (value.nickname != null && typeof value.nickname !== 'string') return false
  if (value.addedBy != null && !isHexKey(value.addedBy)) return false
  if (value.revoked === true) {
    if (typeof value.revokedAt !== 'number' || !Number.isFinite(value.revokedAt)) return false
  }
  return true
}

// Should the incoming record replace `existing` in local mirror? Valid + strictly
// newer (or no existing). Equal updatedAt does NOT overwrite (first-writer stable).
function acceptSeederRecord ({ incoming, existing, keyPubkey, now = Date.now(), futureToleranceMs = 5 * 60 * 1000 }) {
  if (!isValidSeederRecord(incoming, keyPubkey, now, futureToleranceMs)) return false
  if (!existing) return true
  const ex = typeof existing.updatedAt === 'number' ? existing.updatedAt : 0
  return incoming.updatedAt > ex
}

// Build/refresh a record: preserve addedBy/addedAt from an existing row, bump
// updatedAt so the write wins LWW.
function buildSeederRecord ({ pubkey, nickname = null, addedBy = null, existing = null, now = Date.now() }) {
  const pk = String(pubkey).toLowerCase()
  return {
    pubkey: pk,
    nickname: nickname ?? existing?.nickname ?? null,
    addedBy: existing?.addedBy ?? addedBy ?? null,
    addedAt: existing?.addedAt ?? now,
    updatedAt: now,
    v: 1,
  }
}

module.exports = {
  KEY_PREFIX,
  seederRecordKey,
  parseSeederRecordKey,
  isValidSeederRecord,
  acceptSeederRecord,
  buildSeederRecord,
  isHex64,
}
