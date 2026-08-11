// When a foreground should tear the swarm down and rebuild it, rather than just
// flushing. Pure decision, so it can be tested without a network. See bounceSwarm
// in src/bare.js for why flush() alone is not enough.
//
// How long the app must have been backgrounded before a foreground counts as
// "the connections are probably dead". Short trips (app switcher, notification
// shade, a glance at Control Center) keep their sockets, so bouncing there would
// throw away working connections for nothing.
const SWARM_BOUNCE_MIN_BG_MS = 20_000

// `connections` is the live connection count (swarm.connections.size).
// `platform` is whatever the shell reported: 'ios', 'android', or absent on
// desktop and on older callers that send no options at all.
function shouldBounceSwarm ({
  bgMs = 0,
  platform = null,
  connections = 0,
  minBgMs = SWARM_BOUNCE_MIN_BG_MS
} = {}) {
  if (!(Number(bgMs) >= minBgMs)) return false
  // Android keeps the worklet running behind a foreground service + wake lock, so
  // its connections usually survive a background and bouncing them would undo
  // syncing that was working. Only rebuild there once they're visibly all gone.
  // iOS freezes the entire process, so a long trip away always means dead
  // sockets, whatever the swarm still believes about them.
  if (platform === 'android' && connections > 0) return false
  return true
}

module.exports = { shouldBounceSwarm, SWARM_BOUNCE_MIN_BG_MS }
