// Live seed-enroll wire (TODO #116 facet #3) — the pure, shared definition of
// the pearcal/seed-enroll Protomux channel so src/bare.js (member, sender) and
// src/seed.js (seeder, listener) can never drift on the protocol id or the
// message shapes. A member with auto-follow enabled pushes /seed invites for
// groups it creates AFTER a seeder was admitted; the seeder enrolls each and
// acks the groupIds it now hosts so the member re-announces their writer cores.
//
// Also the auto-follow TRUST GATE: pushing a group's /seed invite hands the
// recipient that group's topic+bootstrap key (never `enc` — it stays blind), so
// a member must only push to seeders it explicitly trusts. A peer that merely
// sent a seeder-hello (recorded for visibility) is NOT eligible — it could be a
// co-member spoofing the hello to harvest the topic keys of groups it isn't in.

'use strict'

const SEED_ENROLL_PROTOCOL = 'pearcal/seed-enroll'
// Buffer id — byte-identical on both ends (Protomux matches channels by id).
const SEED_ENROLL_ID = Buffer.from('pearcal-seed-enroll-v1')

// Member → seeder: a batch of /seed invite strings.
function buildSeedEnrollBatch (invites) {
  const list = Array.isArray(invites) ? invites.filter(s => typeof s === 'string' && s) : []
  return Buffer.from(JSON.stringify({ seedInvites: list }))
}

// Seeder side: recover the invite strings from a batch buffer. Defensive —
// returns [] for anything malformed so one bad frame never throws in the
// message handler.
function parseSeedEnrollBatch (buf) {
  try {
    const parsed = JSON.parse(buf.toString()) || {}
    if (!Array.isArray(parsed.seedInvites)) return []
    return parsed.seedInvites.filter(s => typeof s === 'string' && s)
  } catch { return [] }
}

// Seeder → member: the groupIds the seeder now hosts after enrolling.
function buildSeedEnrollAck (groupIds) {
  const list = Array.isArray(groupIds) ? groupIds.filter(s => typeof s === 'string' && s) : []
  return Buffer.from(JSON.stringify({ enrolled: list }))
}

function parseSeedEnrollAck (buf) {
  try {
    const parsed = JSON.parse(buf.toString()) || {}
    if (!Array.isArray(parsed.enrolled)) return []
    return parsed.enrolled.filter(s => typeof s === 'string' && s)
  } catch { return [] }
}

// The trust gate. Only a seederFollow row explicitly marked autoFollow:true is
// eligible for an auto-push. QR pairing sets it (the pubkey was scanned and
// anchored); a paste-admitted seeder starts false and the user opts in via the
// Blind Peer toggle. Everything else — including a hello-recorded row — is off.
function autoFollowEligible (row) {
  return !!row && row.autoFollow === true
}

module.exports = {
  SEED_ENROLL_PROTOCOL,
  SEED_ENROLL_ID,
  buildSeedEnrollBatch,
  parseSeedEnrollBatch,
  buildSeedEnrollAck,
  parseSeedEnrollAck,
  autoFollowEligible,
}
