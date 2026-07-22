// TODO #123 — the guard that makes losing a group's block-encryption key
// structurally impossible. Pure decision extracted to src/lib/groupRecord.js.
// (bugfix/desktop-group-records)
const test = require('node:test')
const assert = require('node:assert/strict')
const { resolveGroupEncryptionKey } = require('../src/lib/groupRecord.js')

const KEY = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)

test('THE #123 GUARD: a view-derived keyless write cannot drop a key we hold', () => {
  // Exactly the shape of the four bugs: the record came back out of the Autobase
  // view, where the key is always stripped.
  const r = resolveGroupEncryptionKey({ priorKey: KEY, incomingKey: undefined })
  assert.equal(r.key, KEY)
  assert.equal(r.blocked, true)
  assert.equal(r.reason, 'drop')
})

test('a null/empty incoming key is treated the same as absent', () => {
  assert.equal(resolveGroupEncryptionKey({ priorKey: KEY, incomingKey: null }).key, KEY)
  assert.equal(resolveGroupEncryptionKey({ priorKey: KEY, incomingKey: '' }).key, KEY)
  assert.equal(resolveGroupEncryptionKey({ priorKey: KEY, incomingKey: null }).blocked, true)
})

test('a changed key under a stable group id is refused (rekey mints a new id)', () => {
  const r = resolveGroupEncryptionKey({ priorKey: KEY, incomingKey: OTHER })
  assert.equal(r.key, KEY)
  assert.equal(r.blocked, true)
  assert.equal(r.reason, 'change')
})

test('an unchanged key passes through without flagging', () => {
  const r = resolveGroupEncryptionKey({ priorKey: KEY, incomingKey: KEY })
  assert.equal(r.key, KEY)
  assert.equal(r.blocked, false)
})

test('a legacy unencrypted group stays unencrypted', () => {
  // Must NOT invent a key: legacy groups join the raw groupKey topic on purpose.
  const r = resolveGroupEncryptionKey({ priorKey: undefined, incomingKey: undefined })
  assert.equal(r.key, null)
  assert.equal(r.blocked, false)
})

test('a first-time key is accepted when nothing is held yet', () => {
  const r = resolveGroupEncryptionKey({ priorKey: undefined, incomingKey: KEY })
  assert.equal(r.key, KEY)
  assert.equal(r.blocked, false)
  assert.equal(r.reason, 'no-prior-key')
})

test('back-filling a key onto a previously keyless record is allowed', () => {
  // reconcileGroupEncryptionKey's repair path depends on this.
  const r = resolveGroupEncryptionKey({ priorKey: null, incomingKey: KEY })
  assert.equal(r.key, KEY)
  assert.equal(r.blocked, false)
})
