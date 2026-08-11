// The foreground swarm-rebuild decision (src/lib/swarmBounce.js).
//
// Background: an iPhone took 2-4 minutes to show events after a long background
// because foregroundSync only called swarm.flush(), which is passive - it awaits
// discovery already scheduled and dials already in flight, then returns as soon
// as the queue is empty. It never re-announces or re-dials, so the app sat on
// sockets iOS had let die until each one's own keep-alive gave up.
// (bugfix/foreground-swarm-reconnect)
const test = require('node:test')
const assert = require('node:assert/strict')
const { shouldBounceSwarm, SWARM_BOUNCE_MIN_BG_MS } = require('../src/lib/swarmBounce.js')

test('iOS: a long background always rebuilds, however healthy the swarm looks', () => {
  // The whole point: after an iOS freeze the connections read as open and are
  // dead on the wire. A live count is not evidence of anything.
  assert.equal(shouldBounceSwarm({ bgMs: 120_000, platform: 'ios', connections: 4 }), true)
  assert.equal(shouldBounceSwarm({ bgMs: 120_000, platform: 'ios', connections: 0 }), true)
})

test('a short trip away never rebuilds - those sockets are still good', () => {
  // App switcher, notification shade, a glance at Control Center.
  assert.equal(shouldBounceSwarm({ bgMs: 3_000, platform: 'ios', connections: 4 }), false)
  assert.equal(shouldBounceSwarm({ bgMs: 3_000, platform: 'android', connections: 0 }), false)
})

test('the threshold boundary is inclusive', () => {
  assert.equal(shouldBounceSwarm({ bgMs: SWARM_BOUNCE_MIN_BG_MS - 1, platform: 'ios' }), false)
  assert.equal(shouldBounceSwarm({ bgMs: SWARM_BOUNCE_MIN_BG_MS, platform: 'ios' }), true)
})

test('Android keeps working connections - the foreground service keeps them alive', () => {
  // Bouncing here would destroy background sync that had genuinely succeeded.
  assert.equal(shouldBounceSwarm({ bgMs: 600_000, platform: 'android', connections: 2 }), false)
})

test('Android with nothing connected does rebuild', () => {
  assert.equal(shouldBounceSwarm({ bgMs: 600_000, platform: 'android', connections: 0 }), true)
})

test('no options at all means no rebuild - old callers keep the flush-only path', () => {
  // The desktop shell sends no AppState info, and neither did any caller before
  // this change. None of them should start bouncing by surprise.
  assert.equal(shouldBounceSwarm(), false)
  assert.equal(shouldBounceSwarm({}), false)
})

test('a junk bgMs is treated as no background, not as an infinite one', () => {
  for (const bgMs of [undefined, null, NaN, 'soon', -5]) {
    assert.equal(shouldBounceSwarm({ bgMs, platform: 'ios' }), false, String(bgMs))
  }
})

test('an unknown platform gets the iOS treatment', () => {
  // Anything that is not the foreground-service platform is assumed to have been
  // frozen. Erring toward a rebuild costs a reconnect; erring the other way costs
  // minutes of missing events.
  assert.equal(shouldBounceSwarm({ bgMs: 60_000, connections: 3 }), true)
  assert.equal(shouldBounceSwarm({ bgMs: 60_000, platform: 'windows', connections: 3 }), true)
})
