// Unit tests for the seed-mode worklet's pure logic (src/seed.js) — proposal
// 2026-07-15-pearcal-seeder-port, Phase 2. Requiring the module is safe under
// the test runner: its headless-boot guard only fires when argv carries --seed,
// which the test runner's argv does not.
const test = require('node:test')
const assert = require('node:assert/strict')
const { detectSeedMode } = require('../src/seed.js')

test('detectSeedMode: true when argv contains --seed', () => {
  assert.equal(detectSeedMode(['bare', 'seed.bundle', '--seed']), true)
  assert.equal(detectSeedMode(['node', 'src/seed.js', '--seed', '--data', '/tmp/x']), true)
})

test('detectSeedMode: false without --seed', () => {
  assert.equal(detectSeedMode(['node', 'src/seed.js']), false)
  assert.equal(detectSeedMode([]), false)
})

test('detectSeedMode: honors { mode: "seed" } init object', () => {
  assert.equal(detectSeedMode({ mode: 'seed' }), true)
  assert.equal(detectSeedMode({ mode: 'member' }), false)
  assert.equal(detectSeedMode({}), false)
})

test('detectSeedMode: false for null/undefined/garbage', () => {
  assert.equal(detectSeedMode(null), false)
  assert.equal(detectSeedMode(undefined), false)
  assert.equal(detectSeedMode('seed'), false)
})
