// Desktop sleep detection (src/lib/wakeGap.js, TODO #167).
//
// A desktop has no AppState, so the main process infers "this machine was not
// running" from a timer that fired far later than it was meant to. The failure
// that matters is the false positive: a busy main process is late by seconds all
// the time, and treating that as a wake would rebuild the swarm for nothing.
// (bugfix/desktop-sleep-foreground-sync)
const test = require('node:test')
const assert = require('node:assert/strict')
const { wakeGapFrom, WAKE_POLL_INTERVAL_MS, WAKE_GAP_SLACK_MS } = require('../src/lib/wakeGap.js')

test('a timer that fires on time is not a wake', () => {
  assert.equal(wakeGapFrom(WAKE_POLL_INTERVAL_MS), 0)
})

test('ordinary lateness is not a wake', () => {
  // A loaded main process, a slow disk, a garbage collection.
  assert.equal(wakeGapFrom(WAKE_POLL_INTERVAL_MS + 1_000), 0)
  assert.equal(wakeGapFrom(WAKE_POLL_INTERVAL_MS + WAKE_GAP_SLACK_MS), 0)
})

test('a gap past the slack IS a wake', () => {
  const elapsed = WAKE_POLL_INTERVAL_MS + WAKE_GAP_SLACK_MS + 1
  assert.equal(wakeGapFrom(elapsed), elapsed)
})

test('an overnight sleep reports the whole gap, not the overshoot', () => {
  // The connections were unattended for the entire elapsed period; the scheduled
  // interval is part of that, not an exemption from it.
  const eightHours = 8 * 60 * 60 * 1000
  assert.equal(wakeGapFrom(eightHours), eightHours)
})

test('junk elapsed values are not wakes', () => {
  for (const v of [undefined, null, NaN, 'later', 0, -1000, Infinity]) {
    assert.equal(wakeGapFrom(v), 0, String(v))
  }
})

test('the interval and slack are callers choices, not baked in', () => {
  assert.equal(wakeGapFrom(10_000, 1_000, 500), 10_000)
  assert.equal(wakeGapFrom(10_000, 1_000, 60_000), 0)
})

test('a fractional gap is reported as whole milliseconds', () => {
  assert.equal(Number.isInteger(wakeGapFrom(60_000.7)), true)
})
