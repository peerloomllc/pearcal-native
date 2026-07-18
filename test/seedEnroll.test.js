// Live seed-enroll wire + auto-follow trust gate (TODO #116 facets #1 + #3,
// proposal 2026-07-16-seeder-live-enroll). The member (bare.js) and seeder
// (seed.js) share these definitions so the channel id + message shapes can't
// drift, and the gate is the security boundary that stops a hello-recorded peer
// from being handed other groups' topic keys.
const test = require('node:test')
const assert = require('node:assert/strict')
const {
  SEED_ENROLL_PROTOCOL, SEED_ENROLL_ID,
  buildSeedEnrollBatch, parseSeedEnrollBatch,
  buildSeedEnrollAck, parseSeedEnrollAck,
  buildSeedLeave, parseSeedLeave,
  buildSeedLeaveAck, parseSeedLeaveAck,
  autoFollowEligible,
} = require('../src/lib/seedEnroll.js')

const INV1 = 'https://peerloomllc.com/seed?group=Zw&name=Fam&key=' + 'a'.repeat(64) + '&inviter=' + 'c'.repeat(64)
const INV2 = 'https://peerloomllc.com/seed?group=Zx&name=Work&key=' + 'b'.repeat(64) + '&inviter=' + 'c'.repeat(64)

// ── channel identity (drift guard) ──────────────────────────────────────────
test('protocol + id are the stable wire values both ends must share', () => {
  assert.equal(SEED_ENROLL_PROTOCOL, 'pearcal/seed-enroll')
  assert.ok(Buffer.isBuffer(SEED_ENROLL_ID))
  assert.equal(SEED_ENROLL_ID.toString(), 'pearcal-seed-enroll-v1')
})

// ── batch (member → seeder) ─────────────────────────────────────────────────
test('buildSeedEnrollBatch / parseSeedEnrollBatch round-trips invite strings', () => {
  const buf = buildSeedEnrollBatch([INV1, INV2])
  assert.deepEqual(parseSeedEnrollBatch(buf), [INV1, INV2])
})

test('build drops non-string / empty invites', () => {
  const buf = buildSeedEnrollBatch([INV1, '', null, 42, INV2, undefined])
  assert.deepEqual(parseSeedEnrollBatch(buf), [INV1, INV2])
})

test('parseSeedEnrollBatch is defensive against malformed frames', () => {
  assert.deepEqual(parseSeedEnrollBatch(Buffer.from('not json')), [])
  assert.deepEqual(parseSeedEnrollBatch(Buffer.from('{}')), [])
  assert.deepEqual(parseSeedEnrollBatch(Buffer.from('{"seedInvites":"nope"}')), [])
  assert.deepEqual(parseSeedEnrollBatch(Buffer.from('{"seedInvites":[1,2,3]}')), [])
  assert.deepEqual(parseSeedEnrollBatch(Buffer.from('[]')), [])
})

// ── ack (seeder → member) ───────────────────────────────────────────────────
test('buildSeedEnrollAck / parseSeedEnrollAck round-trips groupIds', () => {
  const buf = buildSeedEnrollAck(['gseed01', 'gseed02'])
  assert.deepEqual(parseSeedEnrollAck(buf), ['gseed01', 'gseed02'])
})

test('parseSeedEnrollAck is defensive against malformed frames', () => {
  assert.deepEqual(parseSeedEnrollAck(Buffer.from('garbage')), [])
  assert.deepEqual(parseSeedEnrollAck(Buffer.from('{"enrolled":null}')), [])
  assert.deepEqual(parseSeedEnrollAck(Buffer.from('{"enrolled":[1]}')), [])
})

// ── group-wide revocation leave signal (Phase 2) ────────────────────────────
test('buildSeedLeave / parseSeedLeave round-trips groupIds (member → seeder)', () => {
  const buf = buildSeedLeave(['gseed01', 'gseed02'])
  assert.deepEqual(parseSeedLeave(buf), ['gseed01', 'gseed02'])
})

test('buildSeedLeave drops non-string / empty groupIds', () => {
  const buf = buildSeedLeave(['gseed01', '', null, 42, 'gseed02', undefined])
  assert.deepEqual(parseSeedLeave(buf), ['gseed01', 'gseed02'])
})

test('parseSeedLeave is defensive against malformed frames', () => {
  assert.deepEqual(parseSeedLeave(Buffer.from('not json')), [])
  assert.deepEqual(parseSeedLeave(Buffer.from('{}')), [])
  assert.deepEqual(parseSeedLeave(Buffer.from('{"leaveGroups":"nope"}')), [])
  assert.deepEqual(parseSeedLeave(Buffer.from('{"leaveGroups":[1,2]}')), [])
})

test('leave and enroll travel over the SAME message — an enroll frame yields no leave and vice versa', () => {
  // The channel carries one bidirectional message; each end reads only its keys.
  const enrollFrame = buildSeedEnrollBatch([INV1])
  assert.deepEqual(parseSeedLeave(enrollFrame), [])
  const leaveFrame = buildSeedLeave(['gseed01'])
  assert.deepEqual(parseSeedEnrollBatch(leaveFrame), [])
})

test('buildSeedLeaveAck / parseSeedLeaveAck round-trips left groupIds (seeder → member)', () => {
  const buf = buildSeedLeaveAck(['gseed01'])
  assert.deepEqual(parseSeedLeaveAck(buf), ['gseed01'])
})

test('parseSeedLeaveAck is defensive; an enroll ack yields no leave ack', () => {
  assert.deepEqual(parseSeedLeaveAck(Buffer.from('garbage')), [])
  assert.deepEqual(parseSeedLeaveAck(Buffer.from('{"left":null}')), [])
  assert.deepEqual(parseSeedLeaveAck(buildSeedEnrollAck(['g1'])), [])
})

// ── the trust gate (security boundary) ──────────────────────────────────────
test('autoFollowEligible: ONLY an explicit autoFollow:true row qualifies', () => {
  // QR-paired / opted-in row → eligible.
  assert.equal(autoFollowEligible({ pubkey: 'x', autoFollow: true }), true)
})

test('autoFollowEligible: a hello-recorded row is NOT eligible (spoof defense)', () => {
  // A peer that merely sent a seeder-hello lands here (via:'group-announce',
  // no autoFollow) — it must never be auto-pushed other groups' keys.
  assert.equal(autoFollowEligible({ pubkey: 'x', via: 'group-announce' }), false)
  assert.equal(autoFollowEligible({ pubkey: 'x', autoFollow: false }), false)
})

test('autoFollowEligible: never true for truthy-but-not-true or missing rows', () => {
  assert.equal(autoFollowEligible(null), false)
  assert.equal(autoFollowEligible(undefined), false)
  assert.equal(autoFollowEligible({}), false)
  assert.equal(autoFollowEligible({ autoFollow: 1 }), false)
  assert.equal(autoFollowEligible({ autoFollow: 'true' }), false)
})
