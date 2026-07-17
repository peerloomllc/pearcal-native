// Group-shared blind-seeder record shape/LWW (proposal 2026-07-17). No signatures
// (PearCal relies on Autobase writer-auth), so these cover shape, key↔pubkey
// binding, timestamp sanity, and last-write-wins.
const test = require('node:test')
const assert = require('node:assert/strict')
const {
  seederRecordKey, parseSeederRecordKey, isValidSeederRecord,
  acceptSeederRecord, buildSeederRecord,
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
