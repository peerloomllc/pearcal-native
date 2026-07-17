// Group-shared blind-seeder record shape/LWW (proposal 2026-07-17). No signatures
// (PearCal relies on Autobase writer-auth), so these cover shape, key↔pubkey
// binding, timestamp sanity, and last-write-wins.
const test = require('node:test')
const assert = require('node:assert/strict')
const {
  seederRecordKey, parseSeederRecordKey, isValidSeederRecord,
  acceptSeederRecord, buildSeederRecord, buildSeederRevocation,
} = require('../src/lib/seederRecord.js')

const PK = 'a'.repeat(64)
const PK2 = 'b'.repeat(64)
const BY = 'c'.repeat(64)
const NOW = 1_700_000_000_000

test('key build/parse round-trips; rejects malformed', () => {
  assert.equal(seederRecordKey(PK), 'seeder:' + PK)
  assert.equal(parseSeederRecordKey('seeder:' + PK), PK)
  assert.equal(parseSeederRecordKey('seeder:' + PK.toUpperCase()), PK) // lowercased
  assert.equal(parseSeederRecordKey('seeder:short'), null)
  assert.equal(parseSeederRecordKey('other:' + PK), null)
  assert.equal(parseSeederRecordKey(null), null)
})

test('buildSeederRecord: fresh row', () => {
  const r = buildSeederRecord({ pubkey: PK, nickname: 'Umbrel', addedBy: BY, now: NOW })
  assert.equal(r.pubkey, PK)
  assert.equal(r.nickname, 'Umbrel')
  assert.equal(r.addedBy, BY)
  assert.equal(r.addedAt, NOW)
  assert.equal(r.updatedAt, NOW)
  assert.equal(r.v, 1)
})

test('buildSeederRecord: preserves addedBy/addedAt on re-admit, bumps updatedAt', () => {
  const first = buildSeederRecord({ pubkey: PK, nickname: 'A', addedBy: BY, now: NOW })
  const again = buildSeederRecord({ pubkey: PK, nickname: 'B', addedBy: 'd'.repeat(64), existing: first, now: NOW + 5000 })
  assert.equal(again.addedBy, BY)          // preserved
  assert.equal(again.addedAt, NOW)         // preserved
  assert.equal(again.updatedAt, NOW + 5000) // bumped
  assert.equal(again.nickname, 'B')        // updated
})

test('isValidSeederRecord: accepts a well-formed row', () => {
  const r = buildSeederRecord({ pubkey: PK, nickname: 'Umbrel', addedBy: BY, now: NOW })
  assert.equal(isValidSeederRecord(r, PK, NOW), true)
})

test('isValidSeederRecord: pubkey MUST match the key suffix', () => {
  const r = buildSeederRecord({ pubkey: PK, now: NOW })
  assert.equal(isValidSeederRecord(r, PK2, NOW), false) // key says PK2, row says PK
})

test('isValidSeederRecord: rejects bad shape / timestamps', () => {
  assert.equal(isValidSeederRecord(null, PK, NOW), false)
  assert.equal(isValidSeederRecord({ pubkey: 'nothex' }, null, NOW), false)
  assert.equal(isValidSeederRecord({ pubkey: PK, addedAt: NOW, updatedAt: NOW - 1 }, PK, NOW), false) // updatedAt < addedAt
  assert.equal(isValidSeederRecord({ pubkey: PK, addedAt: NOW + 999_999_999, updatedAt: NOW + 999_999_999 }, PK, NOW), false) // future
  assert.equal(isValidSeederRecord({ pubkey: PK, addedAt: NOW, updatedAt: NOW, nickname: 42 }, PK, NOW), false) // bad nickname type
})

test('acceptSeederRecord: LWW — strictly newer wins, equal does not', () => {
  const a = buildSeederRecord({ pubkey: PK, nickname: 'A', now: NOW })
  const b = buildSeederRecord({ pubkey: PK, nickname: 'B', existing: a, now: NOW + 1 })
  assert.equal(acceptSeederRecord({ incoming: a, existing: null, keyPubkey: PK, now: NOW + 5 }), true)  // no existing
  assert.equal(acceptSeederRecord({ incoming: b, existing: a, keyPubkey: PK, now: NOW + 5 }), true)     // newer
  assert.equal(acceptSeederRecord({ incoming: a, existing: b, keyPubkey: PK, now: NOW + 5 }), false)    // older
  assert.equal(acceptSeederRecord({ incoming: a, existing: a, keyPubkey: PK, now: NOW + 5 }), false)    // equal
})

test('acceptSeederRecord: an invalid incoming row is never accepted', () => {
  assert.equal(acceptSeederRecord({ incoming: { pubkey: 'nope' }, existing: null, keyPubkey: PK, now: NOW }), false)
})

// ── group-wide revocation tombstone (Phase 2) ───────────────────────────────
test('buildSeederRevocation: sets tombstone fields, preserves history, bumps updatedAt', () => {
  const first = buildSeederRecord({ pubkey: PK, nickname: 'Umbrel', addedBy: BY, now: NOW })
  const rev = buildSeederRevocation({ pubkey: PK, existing: first, revokedBy: BY, now: NOW + 9000 })
  assert.equal(rev.pubkey, PK)
  assert.equal(rev.revoked, true)
  assert.equal(rev.revokedAt, NOW + 9000)
  assert.equal(rev.revokedBy, BY)
  assert.equal(rev.updatedAt, NOW + 9000) // bumped so it wins LWW
  assert.equal(rev.addedBy, BY)           // history preserved
  assert.equal(rev.addedAt, NOW)          // history preserved
  assert.equal(rev.nickname, 'Umbrel')    // preserved
  assert.equal(rev.v, 1)
})

test('buildSeederRevocation: works with no existing row (revoke a bare pubkey)', () => {
  const rev = buildSeederRevocation({ pubkey: PK, revokedBy: BY, now: NOW })
  assert.equal(rev.revoked, true)
  assert.equal(rev.addedAt, NOW)          // defaults to now
  assert.equal(rev.updatedAt, NOW)
})

test('isValidSeederRecord: a revoked row is well-formed (revoked needs revokedAt)', () => {
  const rev = buildSeederRevocation({ pubkey: PK, existing: buildSeederRecord({ pubkey: PK, now: NOW }), revokedBy: BY, now: NOW + 1 })
  assert.equal(isValidSeederRecord(rev, PK, NOW + 1), true)
  assert.equal(isValidSeederRecord({ ...rev, revokedAt: undefined }, PK, NOW + 1), false) // revoked without revokedAt
})

test('acceptSeederRecord: a revoke wins over the record it revokes; a LATER re-admit un-revokes', () => {
  const rec = buildSeederRecord({ pubkey: PK, nickname: 'A', addedBy: BY, now: NOW })
  const rev = buildSeederRevocation({ pubkey: PK, existing: rec, revokedBy: BY, now: NOW + 1000 })
  // revoke is newer than the record → accepted
  assert.equal(acceptSeederRecord({ incoming: rev, existing: rec, keyPubkey: PK, now: NOW + 5000 }), true)
  // a re-admit AFTER the revoke (newer updatedAt, no revoked flag) → accepted, clearing the tombstone
  const readmit = buildSeederRecord({ pubkey: PK, nickname: 'A', addedBy: BY, existing: rev, now: NOW + 2000 })
  assert.equal(readmit.revoked, undefined)
  assert.equal(acceptSeederRecord({ incoming: readmit, existing: rev, keyPubkey: PK, now: NOW + 5000 }), true)
  // a stale revoke does NOT overturn a newer re-admit
  assert.equal(acceptSeederRecord({ incoming: rev, existing: readmit, keyPubkey: PK, now: NOW + 5000 }), false)
})
