// #164 — the member invite builder, now shared between the WebView and the Bare
// worklet so the worklet can mint a link from the AUTHORITATIVE group record.
// (bugfix/build-invite-in-engine)
const test = require('node:test')
const assert = require('node:assert/strict')
const { buildInviteLink, buildReinviteLink, parseInviteLink } = require('../src/lib/inviteLink.js')

const ID = 'gry5nws'
const KEY = 'b0'.repeat(32)
const ENC = 'a1'.repeat(32)
const ME  = 'd1'.repeat(16)

const encrypted   = { id: ID, name: 'Hudgins', groupKey: KEY, encryptionKey: ENC }
const unencrypted = { id: ID, name: 'Hudgins', groupKey: KEY }

const encOf = link => new URL(link).searchParams.get('enc')

// ── the bug ───────────────────────────────────────────────────────────────
test('an encrypted group mints a link carrying enc', () => {
  assert.equal(encOf(buildInviteLink(encrypted, ME)), ENC)
})
test('a group object missing the key mints a link with NO enc — the failure mode', () => {
  // This is exactly what a stale UI copy produces, and why the builder moved
  // behind the worklet. Kept as a test so the shape of the bug stays visible:
  // the builder is not wrong, it is being handed the wrong object.
  assert.equal(encOf(buildInviteLink(unencrypted, ME)), null)
})
test('a reinvite carries enc too, and the reinvite marker', () => {
  const u = new URL(buildReinviteLink(encrypted, ME))
  assert.equal(u.searchParams.get('enc'), ENC)
  assert.equal(u.searchParams.get('reinvite'), '1')
})

// ── round trip ────────────────────────────────────────────────────────────
test('build then parse round trips every field', () => {
  const p = parseInviteLink(buildInviteLink(encrypted, ME))
  assert.equal(p.ok, true)
  assert.equal(p.groupId, ID)
  assert.equal(p.groupName, 'Hudgins')
  assert.equal(p.groupKey, KEY)
  assert.equal(p.inviterKey, ME)
  assert.equal(p.encryptionKey, ENC)
  assert.equal(p.reinvite, false)
})
test('a reinvite round trips with the flag set', () => {
  assert.equal(parseInviteLink(buildReinviteLink(encrypted, ME)).reinvite, true)
})

// ── the base64 that made this shareable ───────────────────────────────────
test('group ids survive base64 without btoa', () => {
  // The builder used to call btoa, a WebView global the worklet may not have.
  // Node has no btoa in this test context path either way, so a passing round
  // trip here IS the check that the Buffer fallback works.
  const p = parseInviteLink(buildInviteLink({ ...encrypted, id: 'a-B_9zZ' }, ME))
  assert.equal(p.groupId, 'a-B_9zZ')
})

// ── validation, unchanged behaviour worth pinning ─────────────────────────
test('a link with no name is rejected', () => {
  const link = buildInviteLink(encrypted, ME).replace(/&name=[^&]*/, '')
  assert.equal(parseInviteLink(link).error, 'missing_params')
})
test('a malformed enc is rejected rather than silently dropped', () => {
  const link = buildInviteLink(encrypted, ME).replace(/enc=[0-9a-f]+/, 'enc=nothex')
  assert.equal(parseInviteLink(link).error, 'invalid_enc')
})
test('an absent enc parses as null, so legacy unencrypted groups still work', () => {
  assert.equal(parseInviteLink(buildInviteLink(unencrypted, ME)).encryptionKey, null)
})
test('the legacy pear:// and pearcal:// shapes still parse', () => {
  const https = buildInviteLink(encrypted, ME)
  const q = https.slice(https.indexOf('?'))
  assert.equal(parseInviteLink('pear://pearcal/join' + q).encryptionKey, ENC)
  assert.equal(parseInviteLink('pearcal://join' + q).encryptionKey, ENC)
})
test('a seed invite is not accepted as a member invite', () => {
  // /seed deliberately omits enc; parsing one as /join would produce a keyless
  // member (#124), so the path check has to hold.
  const seed = buildInviteLink(encrypted, ME).replace('/join?', '/seed?')
  assert.equal(parseInviteLink(seed).error, 'wrong_path')
})
