// Seed-invite (blind-seeder admission) tests — proposal
// 2026-07-15-pearcal-seeder-port, Phase 4. The seed invite carries the topic +
// bootstrap (groupKey) but NEVER the block key, and must refuse member /join
// invites so a seeder can never end up holding a decryption key.
const test = require('node:test')
const assert = require('node:assert/strict')
const { buildSeedInvite, parseSeedInvite, buildSeedBundle, parseSeedBundle } = require('../src/lib/seedInvite.js')

const KEY = 'b'.repeat(64)
const KEY2 = 'd'.repeat(64)
const INVITER = 'c'.repeat(64)
const ENC = 'a'.repeat(64)
const g1 = { id: 'gseed01', name: 'Fam', groupKey: KEY }
const g2 = { id: 'gseed02', name: 'Work', groupKey: KEY2 }

test('buildSeedInvite: /seed path, no enc, carries fields', () => {
  const link = buildSeedInvite(g1, INVITER)
  assert.ok(link.includes('/seed?'), 'uses /seed path')
  assert.ok(!link.includes('enc='), 'seed invite must NEVER carry enc')
  assert.ok(link.includes('key=' + KEY))
  assert.ok(link.includes('inviter=' + INVITER))
})

test('parseSeedInvite: round-trips and never returns an encryptionKey', () => {
  const parsed = parseSeedInvite(buildSeedInvite(g1, INVITER))
  assert.equal(parsed.ok, true)
  assert.equal(parsed.groupId, 'gseed01')
  assert.equal(parsed.groupKey, KEY)
  assert.equal(parsed.inviterKey, INVITER)
  assert.equal('encryptionKey' in parsed, false, 'seed parse must not surface a block key')
})

test('parseSeedInvite: REFUSES a member /join invite', async () => {
  const invite = await import('../src/invite.js')
  const memberLink = invite.buildInviteLink({ ...g1, encryptionKey: ENC }, INVITER)
  const parsed = parseSeedInvite(memberLink)
  assert.equal(parsed.ok, false)
  assert.equal(parsed.error, 'member_invite_not_seed')
})

test('parseSeedInvite: ignores a stray &enc= (never leaks a key)', () => {
  const link = buildSeedInvite(g1, INVITER) + '&enc=' + ENC
  const parsed = parseSeedInvite(link)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.encryptionKey, undefined)
  assert.equal('encryptionKey' in parsed, false)
})

test('parseSeedInvite: rejects a bundle passed as a single invite', () => {
  const bundle = buildSeedBundle([g1, g2], INVITER)
  const parsed = parseSeedInvite(bundle)
  assert.equal(parsed.ok, false)
  assert.equal(parsed.error, 'looks_like_bundle')
})

test('pearcal://seed scheme parses', () => {
  const link = buildSeedInvite(g1, INVITER).replace('https://peerloomllc.com/', 'pearcal://')
  const parsed = parseSeedInvite(link)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.groupKey, KEY)
})

test('buildSeedBundle + parseSeedBundle: one admit covers all groups', () => {
  const bundle = buildSeedBundle([g1, g2], INVITER)
  const results = parseSeedBundle(bundle)
  assert.equal(results.length, 2)
  assert.ok(results.every(r => r.ok))
  assert.deepEqual(results.map(r => r.groupId).sort(), ['gseed01', 'gseed02'])
  assert.ok(!bundle.includes('enc='), 'bundle must never carry enc')
})
