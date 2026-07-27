// TODO #145 - a failed join has to say something true and something actionable.
// The UI dropped every outcome but blocked_from_group, so a genuinely failed
// join looked exactly like a clean one. Pure decision in src/lib/joinOutcome.js.
// (feature/surface-join-errors)
const test = require('node:test')
const assert = require('node:assert/strict')
const { joinOutcomeMessage, isBenignJoinOutcome } = require('../src/lib/joinOutcome.js')

// Every code the join path can actually produce: parseInviteLink's failures plus
// handleInviteLink's own, plus repairKeylessGroupFromInvite's reasons.
const PARSE_ERRORS = [
  'invalid_url', 'malformed_url', 'wrong_path', 'missing_params',
  'invalid_group_id', 'empty_name', 'invalid_key', 'invalid_inviter', 'invalid_enc',
]
const REPAIR_REASONS = ['missing-args', 'not-a-member', 'already-keyed', 'key-conflict', 'reconcile-failed']

test('THE #145 REGRESSION: a failed repair does not read as a clean join', () => {
  // The old behaviour was to say nothing at all, or to blame the link. Both are
  // wrong: the link is fine, the repair is what failed.
  const r = joinOutcomeMessage({ error: 'repair_failed', reason: 'reconcile-failed', groupName: 'Family' })
  assert.equal(r.tone, 'error')
  assert.match(r.message, /Family/)
  assert.doesNotMatch(r.message, /invite link does not look right/)
})

test('each repair reason tells a different story', () => {
  // The point of surfacing `reason` at all. If two reasons produced the same
  // sentence, the plumbing would be pointless.
  const messages = REPAIR_REASONS.map(reason =>
    joinOutcomeMessage({ error: 'repair_failed', reason, groupName: 'Family' }).message)
  assert.equal(new Set(messages).size, messages.length, 'two reasons produced identical advice')
})

test('key-conflict advises the one thing that actually helps', () => {
  // A stale invite for a rekeyed group cannot be repaired by retrying, so the
  // advice has to be "get removed and re-added", not "try again".
  const r = joinOutcomeMessage({ error: 'repair_failed', reason: 'key-conflict', groupName: 'Work' })
  assert.equal(r.tone, 'error')
  assert.match(r.message, /different version/i)
})

test('an unknown repair reason still gets a message, not a blank', () => {
  // Defensive: a reason added to bare.js later must not fall through to nothing.
  const r = joinOutcomeMessage({ error: 'repair_failed', reason: 'something-new' })
  assert.equal(r.tone, 'error')
  assert.ok(r.message.length > 0)
})

test('already-keyed is not an error, and is not coloured like one', () => {
  // Colouring a non-problem red trains people to ignore red.
  const r = joinOutcomeMessage({ error: 'repair_failed', reason: 'already-keyed', groupName: 'Family' })
  assert.equal(r.tone, 'info')
})

test('already_member reads as an answer rather than a failure', () => {
  const r = joinOutcomeMessage({ error: 'already_member', groupName: 'Family' })
  assert.equal(r.tone, 'info')
  assert.match(r.message, /already in "Family"/)
})

test('being blocked says who to ask, since retrying cannot help', () => {
  const r = joinOutcomeMessage({ error: 'blocked_from_group', groupName: 'Family' })
  assert.equal(r.tone, 'error')
  assert.match(r.message, /removed/i)
})

test('every parse failure blames the link, because there the link IS the problem', () => {
  for (const error of PARSE_ERRORS) {
    const r = joinOutcomeMessage({ error })
    assert.equal(r.tone, 'error', error)
    assert.match(r.message, /invite link does not look right/, error)
  }
})

test('an unknown error names its code instead of inventing a cause', () => {
  // An honest "something went wrong (x)" beats a confident wrong diagnosis, and
  // the code makes a user report actionable.
  const r = joinOutcomeMessage({ error: 'brand_new_code', groupName: 'Family' })
  assert.equal(r.tone, 'error')
  assert.match(r.message, /brand_new_code/)
})

test('a missing group name never leaves a dangling quote or "undefined"', () => {
  // The name comes from a URL parameter, so it is routinely absent.
  for (const error of [...PARSE_ERRORS, 'already_member', 'blocked_from_group', 'repair_failed', 'nonsense']) {
    const r = joinOutcomeMessage({ error })
    assert.doesNotMatch(r.message, /undefined|""/, error)
  }
})

test('called with nothing at all, it still returns a usable message', () => {
  const r = joinOutcomeMessage()
  assert.equal(r.tone, 'error')
  assert.ok(r.message.length > 0)
})

test('every message is plain language: no error codes leaking as jargon', () => {
  // Rule: these are read by the person using the app. The only code allowed
  // through is the unknown-error fallback, which is deliberate.
  const known = [
    ...PARSE_ERRORS.map(error => ({ error })),
    { error: 'already_member' },
    { error: 'blocked_from_group' },
    ...REPAIR_REASONS.map(reason => ({ error: 'repair_failed', reason })),
  ]
  for (const c of known) {
    const { message } = joinOutcomeMessage({ ...c, groupName: 'Family' })
    assert.doesNotMatch(message, /repair_failed|already_member|blocked_from_group|encryptionKey|reconcile-failed|key-conflict/, JSON.stringify(c))
  }
})

// ── isBenignJoinOutcome ───────────────────────────────────────────────────
test('only the genuinely-nothing-wrong outcomes let the sheet close', () => {
  assert.equal(isBenignJoinOutcome({ error: 'already_member' }), true)
  assert.equal(isBenignJoinOutcome({ error: 'repair_failed', reason: 'already-keyed' }), true)
})

test('a real failure keeps the sheet open', () => {
  // Closing is what made these dead ends invisible in the first place.
  assert.equal(isBenignJoinOutcome({ error: 'repair_failed', reason: 'reconcile-failed' }), false)
  assert.equal(isBenignJoinOutcome({ error: 'repair_failed', reason: 'key-conflict' }), false)
  assert.equal(isBenignJoinOutcome({ error: 'invalid_key' }), false)
  assert.equal(isBenignJoinOutcome({ error: 'blocked_from_group' }), false)
  assert.equal(isBenignJoinOutcome({}), false)
  assert.equal(isBenignJoinOutcome(), false)
})

test('benign means closeable, NOT silent', () => {
  // The pairing that matters: anything benign still has a message to show, or
  // closing it would be the old silence under a new name.
  for (const c of [{ error: 'already_member' }, { error: 'repair_failed', reason: 'already-keyed' }]) {
    assert.equal(isBenignJoinOutcome(c), true)
    assert.ok(joinOutcomeMessage({ ...c, groupName: 'Family' }).message.length > 0)
  }
})

test('a thrown join is reported, not left spinning', () => {
  // handleInviteLink throwing used to be indistinguishable from a hang: the
  // caller only reacted to a RETURNED result, so nothing was ever shown.
  const r = joinOutcomeMessage({ error: 'join_threw', reason: 'boom', groupName: 'Family' })
  assert.equal(r.tone, 'error')
  assert.match(r.message, /Family/)
  assert.doesNotMatch(r.message, /boom|join_threw/, 'the internal detail must not surface as jargon')
})

test('a thrown join keeps the sheet open, since there is something to read', () => {
  assert.equal(isBenignJoinOutcome({ error: 'join_threw' }), false)
})
