// TODO #123 — the guard that makes losing a group's block-encryption key
// structurally impossible. Pure decision extracted to src/lib/groupRecord.js.
// (bugfix/desktop-group-records)
const test = require('node:test')
const assert = require('node:assert/strict')
const {
  resolveGroupEncryptionKey, isGroupRecordKey, groupIdFromRecordKey, GROUP_KEY_PREFIX,
} = require('../src/lib/groupRecord.js')

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

// ── which keys must go through the guard (the fifth site, TODO #123) ──────
// resyncGroup walks a raw Autobase view read-stream and dispatches on the key
// prefix, so unlike the other four sites it never mentions the namespace it is
// writing. These are the decisions that let a stream-keyed write route itself.

test('a group-record key is recognised as one', () => {
  assert.equal(isGroupRecordKey('groups:g0soe8x'), true)
  assert.equal(groupIdFromRecordKey('groups:g0soe8x'), 'g0soe8x')
})

test('groupMembers: is a DIFFERENT namespace and must not match', () => {
  // It shares the `group` stem and diverges at the sixth character. Nothing in
  // the code special-cases that, so it is worth a test: a later rename that made
  // the prefixes nest would silently route TODO #70's split member records
  // through the group guard, which would then defend a key they never carry.
  assert.equal(isGroupRecordKey('groupMembers:g0soe8x'), false)
  assert.equal(groupIdFromRecordKey('groupMembers:g0soe8x'), null)
})

test('other namespaces in the same DB are left alone', () => {
  // resyncGroup writes events and avatars through the same dispatcher, so these
  // must fall through to a plain db.put rather than the group guard.
  for (const k of ['events:2026-07-26:abc', 'avatars:deadbeef', 'members:g1:m1', 'profile']) {
    assert.equal(isGroupRecordKey(k), false, k)
  }
})

test('the namespace itself is not a group id', () => {
  // Guards against a truncated key addressing the whole prefix.
  assert.equal(groupIdFromRecordKey(GROUP_KEY_PREFIX), null)
})

test('tolerates non-string keys', () => {
  for (const k of [null, undefined, 42, {}]) {
    assert.equal(isGroupRecordKey(k), false)
    assert.equal(groupIdFromRecordKey(k), null)
  }
})
