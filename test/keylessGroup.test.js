// TODO #124 - the encrypted latch and the keyless-group classifier
// (src/lib/groupRecord.js). Proposal: proposals/2026-07-23-keyless-member-recovery.md
const test = require('node:test')
const assert = require('node:assert/strict')
const { resolveGroupEncryptedFlag, classifyKeylessGroup } = require('../src/lib/groupRecord.js')

const KEY = 'a'.repeat(64)
const DAY = 24 * 60 * 60 * 1000

// ── The latch ───────────────────────────────────────────────────────────────

test('holding a key sets the latch', () => {
  assert.equal(resolveGroupEncryptedFlag({ incomingKey: KEY }), true)
  assert.equal(resolveGroupEncryptedFlag({ priorKey: KEY }), true)
})

test('THE #124 LATCH: it survives the key being lost', () => {
  // Exactly the failure it exists for: a view-derived, keyless record is written
  // over a record that held a key. The key guard already refuses the drop, but
  // even if the key were gone the latch must still remember it was encrypted.
  const flag = resolveGroupEncryptedFlag({
    priorEncrypted: true, priorKey: undefined,
    incomingEncrypted: undefined, incomingKey: undefined,
  })
  assert.equal(flag, true, 'once encrypted, always encrypted')
})

test('the latch is one-way: nothing can clear it', () => {
  assert.equal(resolveGroupEncryptedFlag({ priorEncrypted: true, incomingEncrypted: false }), true)
  assert.equal(resolveGroupEncryptedFlag({ priorEncrypted: true, incomingEncrypted: null }), true)
})

test('a legacy unencrypted group never latches', () => {
  assert.equal(resolveGroupEncryptedFlag({}), false)
  assert.equal(resolveGroupEncryptedFlag({ priorEncrypted: false, incomingEncrypted: undefined }), false)
})

// ── The classifier ──────────────────────────────────────────────────────────

test('a healthy keyed group is never flagged', () => {
  const r = classifyKeylessGroup({
    encrypted: true, encryptionKey: KEY, joinedAt: 0, memberCount: 1,
    now: 10 * DAY, staleAfterMs: DAY,
  })
  assert.equal(r.damaged, false)
  assert.equal(r.reason, 'has-key')
})

test('CERTAIN: latched encrypted with no key is damaged, no heuristic needed', () => {
  const r = classifyKeylessGroup({
    encrypted: true, encryptionKey: null, joinedAt: Date.now(), memberCount: 5,
    now: Date.now(), staleAfterMs: DAY,
  })
  assert.equal(r.damaged, true)
  assert.equal(r.certainty, 'certain')
})

test('LIKELY: no latch, joined long ago, still nobody else', () => {
  const r = classifyKeylessGroup({
    encrypted: undefined, encryptionKey: null, joinedAt: 0, memberCount: 1,
    now: 3 * DAY, staleAfterMs: DAY,
  })
  assert.equal(r.damaged, true)
  assert.equal(r.certainty, 'likely')
  assert.equal(r.reason, 'never-synced')
})

test('a legacy group that DID sync is not flagged', () => {
  const r = classifyKeylessGroup({
    encrypted: undefined, encryptionKey: null, joinedAt: 0, memberCount: 4,
    now: 30 * DAY, staleAfterMs: DAY,
  })
  assert.equal(r.damaged, false, 'it has peers, so the raw topic is working fine')
  assert.equal(r.reason, 'has-peers')
})

test('a freshly joined group is given time before being accused', () => {
  const r = classifyKeylessGroup({
    encrypted: undefined, encryptionKey: null, joinedAt: 1000, memberCount: 1,
    now: 1000 + DAY / 2, staleAfterMs: DAY,
  })
  assert.equal(r.damaged, false)
  assert.equal(r.reason, 'too-recent')
})

test('the certain path does NOT wait for the staleness window', () => {
  // A latched-encrypted keyless group is broken the moment we see it. Making the
  // user wait a day for a definite answer would be pointless.
  const r = classifyKeylessGroup({
    encrypted: true, encryptionKey: null, joinedAt: 1000, memberCount: 1,
    now: 1001, staleAfterMs: DAY,
  })
  assert.equal(r.damaged, true)
  assert.equal(r.certainty, 'certain')
})

test('an unknown join time is never guessed at', () => {
  const r = classifyKeylessGroup({
    encrypted: undefined, encryptionKey: null, joinedAt: null, memberCount: 0,
    now: Date.now(), staleAfterMs: DAY,
  })
  assert.equal(r.damaged, false)
  assert.equal(r.reason, 'unknown-age')
})
