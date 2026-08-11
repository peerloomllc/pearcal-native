// Desktop sleep detection (TODO #167).
//
// The phones learn they were away from AppState. A desktop has no such signal,
// so the main process watches for the two things that mean "this machine was
// not running just now":
//
//   1. powerMonitor's suspend/resume pair, which is the clean case.
//   2. A wall-clock gap: a timer that should have fired every N seconds fired
//      far later instead. This is the backstop, because powerMonitor's resume
//      does not reliably arrive on every Linux desktop environment, and because
//      a machine can be paused (a VM, a laptop that hibernated) without ever
//      emitting suspend.
//
// Whatever it finds is handed to the worklet as `bgMs`, which the swarm-bounce
// decision already understands - see swarmBounce.js for why a long gap has to
// rebuild the connections rather than flush them.

// How often to check the clock. Short enough that a wake is noticed promptly,
// long enough to be free.
const WAKE_POLL_INTERVAL_MS = 30_000

// A timer never fires exactly on time, and a busy or throttled main process can
// be late by seconds without anything having slept. Only a gap beyond this much
// slack counts as time the machine was not running.
const WAKE_GAP_SLACK_MS = 15_000

// Returns how long the machine appears to have been away, or 0 if the timer was
// merely late. `elapsedMs` is the real time between two consecutive checks and
// `intervalMs` is how far apart they were meant to be.
function wakeGapFrom (elapsedMs, intervalMs = WAKE_POLL_INTERVAL_MS, slackMs = WAKE_GAP_SLACK_MS) {
  const elapsed = Number(elapsedMs)
  if (!Number.isFinite(elapsed) || elapsed <= 0) return 0
  const overshoot = elapsed - intervalMs
  if (overshoot <= slackMs) return 0
  // Report the whole gap, not just the overshoot. From the swarm's point of view
  // the connections have been unattended for the entire elapsed period, and the
  // scheduled interval is part of that.
  return Math.round(elapsed)
}

module.exports = { wakeGapFrom, WAKE_POLL_INTERVAL_MS, WAKE_GAP_SLACK_MS }
