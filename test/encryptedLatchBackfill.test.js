// TODO #142 - the `encrypted` latch has to be set on groups that predate it,
// because the moment it matters is AFTER the key is gone and by then the record
// cannot prove anything about itself. Pure decisions in src/lib/groupRecord.js.
// (bugfix/encrypted-latch-backfill)
const test = require('node:test')
const assert = require('node:assert/strict')
const {
  needsEncryptedLatchBackfill,
  isEncryptedButKeyless,
  resolveGroupEncryptedFlag,
  classifyKeylessGroup,
} = require('../src/lib/groupRecord.js')

const KEY = 'a'.repeat(64)

// ── needsEncryptedLatchBackfill ───────────────────────────────────────────
test('a keyed group with no latch needs the backfill', () => {
  // Exactly the state found on this box: joined before 2026-07-23, holds a key,
  // record still says encrypted:false.
  assert.equal(needsEncryptedLatchBackfill({ encryptionKey: KEY, encrypted: false }), true)
  assert.equal(needsEncryptedLatchBackfill({ encryptionKey: KEY }), true)
})
test('a keyed group that already has the latch is left alone', () => {
  assert.equal(needsEncryptedLatchBackfill({ encryptionKey: KEY, encrypted: true }), false)
})
test('a legacy unencrypted group is never latched', () => {
  // The whole point: a group that legitimately has no key must stay unlatched,
  // or every legacy group would start claiming to be damaged.
  assert.equal(needsEncryptedLatchBackfill({ encrypted: false }), false)
  assert.equal(needsEncryptedLatchBackfill({}), false)
})
test('a keyless record that already claims encrypted is not backfill work', () => {
  // It is already latched; there is no key to prove anything with.
  assert.equal(needsEncryptedLatchBackfill({ encrypted: true }), false)
})
test('tolerates null and undefined records', () => {
  assert.equal(needsEncryptedLatchBackfill(null), false)
  assert.equal(needsEncryptedLatchBackfill(undefined), false)
})

// ── isEncryptedButKeyless ─────────────────────────────────────────────────
test('latched with no key is the definitively broken device', () => {
  assert.equal(isEncryptedButKeyless({ encrypted: true }), true)
  assert.equal(isEncryptedButKeyless({ encrypted: true, encryptionKey: '' }), true)
})
test('holding the key is not broken, latch or no latch', () => {
  assert.equal(isEncryptedButKeyless({ encrypted: true, encryptionKey: KEY }), false)
  assert.equal(isEncryptedButKeyless({ encryptionKey: KEY }), false)
})
test('a legacy group is not broken', () => {
  assert.equal(isEncryptedButKeyless({}), false)
  assert.equal(isEncryptedButKeyless(null), false)
})

// ── the two are mutually exclusive ────────────────────────────────────────
test('no record is ever both backfill work and definitively broken', () => {
  const records = [
    { encryptionKey: KEY, encrypted: false },
    { encryptionKey: KEY, encrypted: true },
    { encrypted: true },
    { encrypted: false },
    {},
    null,
  ]
  for (const r of records) {
    assert.ok(!(needsEncryptedLatchBackfill(r) && isEncryptedButKeyless(r)),
      'both true for ' + JSON.stringify(r))
  }
})

// ── the backfill agrees with the guard that normally sets the latch ───────
test('backfilling produces exactly what putGroupRecord would have written', () => {
  // The sweep re-writes the record through putGroupRecord, so the latch it ends
  // up with must be the guard's own answer - not a second opinion that could
  // drift from it.
  const rec = { encryptionKey: KEY, encrypted: false }
  assert.equal(needsEncryptedLatchBackfill(rec), true)
  assert.equal(resolveGroupEncryptedFlag({
    priorEncrypted: rec.encrypted, priorKey: rec.encryptionKey,
    incomingEncrypted: rec.encrypted, incomingKey: rec.encryptionKey,
  }), true)
})

// ── why it matters: the latch is what makes the diagnosis certain ─────────
test('after the key is lost, the latch is the difference between certain and a guess', () => {
  const joinedAt = Date.now() - 48 * 60 * 60 * 1000
  const common = { encryptionKey: null, joinedAt, peerCount: 0, now: Date.now(), staleAfterMs: 24 * 60 * 60 * 1000 }
  const latched   = classifyKeylessGroup({ ...common, encrypted: true })
  const unlatched = classifyKeylessGroup({ ...common, encrypted: false })
  assert.equal(latched.certainty, 'certain')
  assert.notEqual(unlatched.certainty, 'certain')
})
