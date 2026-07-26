// Issue #265: blind-peer pairing gave no sense of progress or of how long it
// would keep trying, so a pairing that was working looked identical to one that
// had stalled.
//
// The two waits live in different runtimes - the member's rendezvous scan in
// src/bare.js, the seeder's QR lifetime in src/seed.js - and each now has a UI
// counting the same clock down. Keeping the durations and the countdown
// arithmetic here means a UI can never quietly disagree with the timer it claims
// to be showing. The seeder dashboard runs in a browser and cannot require this
// file, so it counts down the `ttlMs` the seeder reports to it instead of a
// second copy of the number.

'use strict'

// Member side: how long seederPairScan stays on the rendezvous before giving up.
const SEEDER_PAIR_SCAN_TIMEOUT_MS = 60 * 1000

// Seeder side: how long a displayed pairing QR (its rendezvous) stays valid.
const SEEDER_PAIR_TTL_MS = 5 * 60 * 1000

// Whole seconds left on a wait of `totalMs` that began `elapsedMs` ago. Clamped
// at both ends: a late tick must not render a negative countdown, and an elapsed
// that went backwards (clock jump, suspended device) shows the full wait rather
// than more than it.
function secondsRemaining (elapsedMs, totalMs) {
  const total = Math.ceil(totalMs / 1000)
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return total
  return Math.max(0, Math.min(total, Math.ceil((totalMs - elapsedMs) / 1000)))
}

// Under a minute reads better as urgency ("38s"), a minute or more as a deadline
// ("4:05"). The member's 60s scan is always the first, the seeder's 5 min QR
// starts as the second and becomes the first.
function formatCountdown (seconds) {
  const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0))
  if (s < 60) return s + 's'
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0')
}

module.exports = {
  SEEDER_PAIR_SCAN_TIMEOUT_MS,
  SEEDER_PAIR_TTL_MS,
  secondsRemaining,
  formatCountdown,
}
