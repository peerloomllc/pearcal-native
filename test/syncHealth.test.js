const test = require('node:test')
const assert = require('node:assert')
const { classifySyncHealth, shouldStampSync, STALE_AFTER_MS } = require('../src/lib/syncHealth.js')

const NOW = 1_800_000_000_000
const hours = h => h * 60 * 60 * 1000

test('a calendar exchanging data recently is fine', () => {
  const r = classifySyncHealth({ lastSyncAt: NOW - hours(2), joinedAt: NOW - hours(500), memberCount: 5, now: NOW })
  assert.equal(r.state, 'ok')
})

test('THE FIELD CASE: several members, silent for days, is flagged', () => {
  const r = classifySyncHealth({ lastSyncAt: NOW - hours(72), joinedAt: NOW - hours(500), memberCount: 5, now: NOW })
  assert.equal(r.state, 'stale')
  assert.equal(r.reason, 'silent-too-long')
  assert.ok(r.sinceMs >= hours(72))
})

test('a calendar with nobody else in it is never called broken', () => {
  const r = classifySyncHealth({ lastSyncAt: null, joinedAt: NOW - hours(500), memberCount: 1, now: NOW })
  assert.equal(r.state, 'alone')
})

test('a freshly joined calendar is given time to settle', () => {
  const r = classifySyncHealth({ lastSyncAt: null, joinedAt: NOW - hours(0.2), memberCount: 3, now: NOW })
  assert.equal(r.state, 'ok')
  assert.equal(r.reason, 'recently-joined')
})

test('joined long ago and never synced once is flagged', () => {
  const r = classifySyncHealth({ lastSyncAt: null, joinedAt: NOW - hours(100), memberCount: 3, now: NOW })
  assert.equal(r.state, 'stale')
  assert.equal(r.reason, 'never-synced')
})

test('joined long ago, no record yet, but not yet past the window stays quiet', () => {
  const r = classifySyncHealth({ lastSyncAt: null, joinedAt: NOW - hours(5), memberCount: 3, now: NOW })
  assert.equal(r.state, 'ok')
})

test('NO BASELINE, NO WARNING: groups predating the feature stay silent', () => {
  // Every existing group has no lastSyncAt and, if joinedAt was never stored,
  // no baseline either. Warning here would greet everyone with a wall of false
  // alarms on the first launch after updating.
  const r = classifySyncHealth({ lastSyncAt: null, joinedAt: null, memberCount: 4, now: NOW })
  assert.equal(r.state, 'unknown')
  assert.notEqual(r.state, 'stale')
})

test('the boundary is inclusive and does not flip a minute early', () => {
  const just = classifySyncHealth({ lastSyncAt: NOW - (STALE_AFTER_MS - 1), joinedAt: NOW - hours(500), memberCount: 2, now: NOW })
  assert.equal(just.state, 'ok')
  const past = classifySyncHealth({ lastSyncAt: NOW - STALE_AFTER_MS, joinedAt: NOW - hours(500), memberCount: 2, now: NOW })
  assert.equal(past.state, 'stale')
})

test('a two-member calendar counts, it is the common shared case', () => {
  const r = classifySyncHealth({ lastSyncAt: NOW - hours(72), joinedAt: NOW - hours(500), memberCount: 2, now: NOW })
  assert.equal(r.state, 'stale')
})

test('without a clock it says nothing rather than guessing', () => {
  assert.equal(classifySyncHealth({}).state, 'unknown')
})

// --- the write throttle ------------------------------------------------------

test('the first stamp always writes', () => {
  assert.equal(shouldStampSync(null, NOW), true)
})

test('a burst of remote nodes writes once, not once each', () => {
  let last = NOW
  let writes = 0
  for (let i = 0; i < 500; i++) {
    const t = NOW + i * 10          // 500 nodes over 5 seconds
    if (shouldStampSync(last, t)) { writes++; last = t }
  }
  assert.equal(writes, 0, 'nothing within the interval')
})

test('but it does write again once the interval passes', () => {
  assert.equal(shouldStampSync(NOW, NOW + 61_000), true)
  assert.equal(shouldStampSync(NOW, NOW + 59_000), false)
})

// --- the regression the TCL caught -------------------------------------------

test('THE FALSE ALARM: an existing group must not be accused the moment the feature ships', () => {
  // Joined months ago, syncing fine, but this device only started watching five
  // minutes ago so there is no lastSyncAt yet. Caught on the TCL rendering a
  // "hasn't synced yet" banner on a perfectly healthy group.
  const r = classifySyncHealth({
    lastSyncAt: null, joinedAt: NOW - hours(2000), watchSince: NOW - hours(0.08),
    memberCount: 2, now: NOW,
  })
  assert.notEqual(r.state, 'stale')
  assert.equal(r.state, 'ok')
  assert.equal(r.reason, 'not-watching-long-enough')
})

test('but once we HAVE watched long enough, silence is reported', () => {
  const r = classifySyncHealth({
    lastSyncAt: null, joinedAt: NOW - hours(2000), watchSince: NOW - hours(72),
    memberCount: 2, now: NOW,
  })
  assert.equal(r.state, 'stale')
  assert.equal(r.reason, 'never-synced')
})

test('a group joined AFTER we started watching still uses the join time', () => {
  const r = classifySyncHealth({
    lastSyncAt: null, joinedAt: NOW - hours(3), watchSince: NOW - hours(500),
    memberCount: 2, now: NOW,
  })
  assert.equal(r.state, 'ok', 'joined 3h ago, not silent for 48h')
})
