// Unit tests for the encrypted-group invite fields (proposal
// 2026-07-15-pearcal-seeder-port, Phase 1). Member invites carry the block
// `enc` key; legacy invites omit it and parse to encryptionKey: null.
// invite.js is an ES module, so load it via dynamic import from this CJS test.
const test = require('node:test')
const assert = require('node:assert/strict')

let invite
test.before(async () => { invite = await import('../src/invite.js') })

const ENC = 'a'.repeat(64) // 32-byte hex
const KEY = 'b'.repeat(64)
const INVITER = 'c'.repeat(64)
const baseGroup = { id: 'gabc12', name: 'Fam', groupKey: KEY }

test('buildInviteLink includes &enc= for encrypted groups', () => {
  const link = invite.buildInviteLink({ ...baseGroup, encryptionKey: ENC }, INVITER)
  assert.ok(link.includes('enc=' + ENC), 'link should carry enc')
})

test('buildInviteLink omits &enc= for legacy groups', () => {
  const link = invite.buildInviteLink(baseGroup, INVITER)
  assert.ok(!link.includes('enc='), 'legacy link must not carry enc')
})

test('buildReinviteLink includes &enc= for encrypted groups', () => {
  const link = invite.buildReinviteLink({ ...baseGroup, encryptionKey: ENC }, INVITER)
  assert.ok(link.includes('enc=' + ENC))
  assert.ok(link.includes('reinvite=1'))
})

test('parseInviteLink round-trips encryptionKey', () => {
  const link = invite.buildInviteLink({ ...baseGroup, encryptionKey: ENC }, INVITER)
  const parsed = invite.parseInviteLink(link)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.groupKey, KEY)
  assert.equal(parsed.encryptionKey, ENC)
})

test('parseInviteLink returns encryptionKey null for legacy invite (no enc)', () => {
  const link = invite.buildInviteLink(baseGroup, INVITER)
  const parsed = invite.parseInviteLink(link)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.encryptionKey, null)
})

test('parseInviteLink rejects a malformed enc', () => {
  const bad = invite.buildInviteLink(baseGroup, INVITER) + '&enc=NOTHEX'
  const parsed = invite.parseInviteLink(bad)
  assert.equal(parsed.ok, false)
  assert.equal(parsed.error, 'invalid_enc')
})

test('parseInviteLink accepts uppercase enc and normalizes to lowercase', () => {
  const link = invite.buildInviteLink(baseGroup, INVITER) + '&enc=' + 'A'.repeat(64)
  const parsed = invite.parseInviteLink(link)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.encryptionKey, 'a'.repeat(64))
})
