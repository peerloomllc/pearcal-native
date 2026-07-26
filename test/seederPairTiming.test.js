// Issue #265: pairing countdowns. These cover the shared arithmetic in
// src/lib/seederPairTiming.js, which both pairing UIs render from.
// (feature/seeder-pair-feedback)
const test = require('node:test')
const assert = require('node:assert/strict')
const {
  SEEDER_PAIR_SCAN_TIMEOUT_MS,
  SEEDER_PAIR_TTL_MS,
  secondsRemaining,
  formatCountdown,
} = require('../src/lib/seederPairTiming.js')

// ── the durations themselves ──────────────────────────────────────────────
test('the member scan gives up after a minute', () => {
  assert.equal(SEEDER_PAIR_SCAN_TIMEOUT_MS, 60000)
})
test('a displayed pairing QR lasts five minutes', () => {
  assert.equal(SEEDER_PAIR_TTL_MS, 300000)
})
test('the QR outlives the scan, so a scan can never outlast the QR it scanned', () => {
  assert.ok(SEEDER_PAIR_TTL_MS > SEEDER_PAIR_SCAN_TIMEOUT_MS)
})

// ── secondsRemaining ──────────────────────────────────────────────────────
test('a fresh wait shows its whole duration', () => {
  assert.equal(secondsRemaining(0, SEEDER_PAIR_SCAN_TIMEOUT_MS), 60)
})
test('counts down as time passes', () => {
  assert.equal(secondsRemaining(1000, SEEDER_PAIR_SCAN_TIMEOUT_MS), 59)
  assert.equal(secondsRemaining(45000, SEEDER_PAIR_SCAN_TIMEOUT_MS), 15)
})
test('rounds up, so a partly-elapsed second still reads as remaining', () => {
  // 59.5s left must show 60, not 59 - the wait has not lost a whole second yet.
  assert.equal(secondsRemaining(500, SEEDER_PAIR_SCAN_TIMEOUT_MS), 60)
})
test('never goes negative when a tick lands after the deadline', () => {
  assert.equal(secondsRemaining(SEEDER_PAIR_SCAN_TIMEOUT_MS, SEEDER_PAIR_SCAN_TIMEOUT_MS), 0)
  assert.equal(secondsRemaining(90000, SEEDER_PAIR_SCAN_TIMEOUT_MS), 0)
})
test('a backwards clock shows the full wait rather than more than it', () => {
  // Device suspended and resumed, or the wall clock stepped back.
  assert.equal(secondsRemaining(-5000, SEEDER_PAIR_SCAN_TIMEOUT_MS), 60)
})
test('a non-numeric elapsed shows the full wait', () => {
  assert.equal(secondsRemaining(NaN, SEEDER_PAIR_SCAN_TIMEOUT_MS), 60)
  assert.equal(secondsRemaining(undefined, SEEDER_PAIR_SCAN_TIMEOUT_MS), 60)
})
test('works for the seeder QR duration too', () => {
  assert.equal(secondsRemaining(0, SEEDER_PAIR_TTL_MS), 300)
  assert.equal(secondsRemaining(299000, SEEDER_PAIR_TTL_MS), 1)
})

// ── formatCountdown ───────────────────────────────────────────────────────
test('under a minute reads as bare seconds', () => {
  assert.equal(formatCountdown(59), '59s')
  assert.equal(formatCountdown(8), '8s')
  assert.equal(formatCountdown(0), '0s')
})
test('a minute or more reads as m:ss with a padded seconds field', () => {
  assert.equal(formatCountdown(60), '1:00')
  assert.equal(formatCountdown(65), '1:05')
  assert.equal(formatCountdown(300), '5:00')
})
test('formats what secondsRemaining produces across a whole QR lifetime', () => {
  const at = ms => formatCountdown(secondsRemaining(ms, SEEDER_PAIR_TTL_MS))
  assert.equal(at(0), '5:00')
  assert.equal(at(1000), '4:59')
  // The m:ss to seconds handover, both sides of it. Rounding up means a full
  // minute is still showing with 59.001s left, so 1:00 holds until a whole
  // second has gone.
  assert.equal(at(240000), '1:00')
  assert.equal(at(240999), '1:00')
  assert.equal(at(241000), '59s')
  assert.equal(at(SEEDER_PAIR_TTL_MS), '0s')
})
test('negative and non-numeric seconds floor to zero rather than rendering junk', () => {
  assert.equal(formatCountdown(-1), '0s')
  assert.equal(formatCountdown(NaN), '0s')
})
