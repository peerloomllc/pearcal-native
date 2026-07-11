// Unit tests for the post-conflict seatbelt decision logic
// (src/lib/conflictSeatbelt.js).
const test = require('node:test')
const assert = require('node:assert/strict')
const { isConflictFallout, shouldSwallowFault, parseConflictLog, CONFLICT_GRACE_MS } = require('../src/lib/conflictSeatbelt')

test('isConflictFallout: matches the fork-conflict fingerprints', () => {
  assert.ok(isConflictFallout(new Error('Two conflicting signatures')))
  assert.ok(isConflictFallout(new Error('Closed')))
  assert.ok(isConflictFallout(new Error('conflict detected in abcd')))
  assert.ok(isConflictFallout('Closed')) // bare string
})

test('isConflictFallout: leaves unrelated errors alone', () => {
  assert.ok(!isConflictFallout(new Error('ECONNRESET')))
  assert.ok(!isConflictFallout(new Error('undefined is not a function')))
  assert.ok(!isConflictFallout(undefined))
  assert.ok(!isConflictFallout(null))
})

test('shouldSwallowFault: swallows fallout inside the grace window', () => {
  const now = 1_000_000
  const recent = now - 1000 // 1s after a conflict, well inside grace
  assert.ok(shouldSwallowFault(new Error('Closed'), recent, now))
})

test('shouldSwallowFault: never swallows without a prior conflict', () => {
  const now = 1_000_000
  assert.ok(!shouldSwallowFault(new Error('Closed'), 0, now))
})

test('shouldSwallowFault: fails fast once past the grace window', () => {
  const now = 1_000_000
  const stale = now - (CONFLICT_GRACE_MS + 1)
  assert.ok(!shouldSwallowFault(new Error('Closed'), stale, now))
})

test('shouldSwallowFault: an unrelated error inside the window still aborts', () => {
  const now = 1_000_000
  const recent = now - 1000
  assert.ok(!shouldSwallowFault(new Error('null is not an object'), recent, now))
})

test('parseConflictLog: extracts discovery key from the hypercore line', () => {
  const disc = parseConflictLog('[hypercore] conflict detected in deadbeef99 (writable=true,quorum=1)')
  assert.equal(disc, 'deadbeef99')
})

test('parseConflictLog: null for non-conflict / non-string input', () => {
  assert.equal(parseConflictLog('[bare] just a normal log line'), null)
  assert.equal(parseConflictLog(42), null)
  assert.equal(parseConflictLog(undefined), null)
})
