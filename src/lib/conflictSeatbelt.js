// Decision logic for the post-conflict worklet seatbelt. Ported from
// PearCircle src/lib/conflictSeatbelt.js (proposal 2026-06-27-fork-conflict-
// recovery), pending PearCal wiring.
//
// A hypercore fork conflict (two validly-signed but divergent blocks at the
// same index) tears down the core's sessions, rejecting in-flight ones with
// Error('Closed'). That rejection escapes through the replicator's Promise.all
// as an unhandled rejection; with no handler Bare aborts the whole worklet,
// which is the 17x crash loop observed on-device (PearCircle, 2026-06-24).
//
// The seatbelt swallows ONLY a conflict's fallout and preserves fail-fast
// abort for everything else, so a real bug still crashes with its diagnostic
// stack. "Conflict fallout" = an error whose message matches a conflict, seen
// within a short grace window after a 'conflict' event actually fired. Both
// conditions are required: the message match alone would risk swallowing an
// unrelated 'Closed' from normal teardown; the time window alone would risk
// swallowing an unrelated bug that happens to fire just after a conflict.

// How long after a 'conflict' event we treat a matching rejection as its
// fallout. The teardown + replicator unwind is sub-second in practice; 15s is
// generous slack for a slow device without meaningfully widening the window.
const CONFLICT_GRACE_MS = 15000

const CONFLICT_FALLOUT_RE = /Two conflicting signatures|conflict|^Closed$/i

// True when err looks like the fallout of a fork conflict (by message).
function isConflictFallout (err) {
  const msg = (err && (err.message || (typeof err === 'string' ? err : ''))) || ''
  return CONFLICT_FALLOUT_RE.test(msg)
}

// Decide whether a fault should be swallowed. `lastConflictAt` is the ts of the
// most recent 'conflict' event (0 if none); `now` is the current ts. Returns
// true to swallow (keep the app alive), false to abort (fail fast).
function shouldSwallowFault (err, lastConflictAt, now, graceMs = CONFLICT_GRACE_MS) {
  if (!lastConflictAt) return false
  if ((now - lastConflictAt) >= graceMs) return false
  return isConflictFallout(err)
}

// Hypercore logs this line from checkConflict on EVERY fork conflict, for any
// core (local writer OR a remote member's writer core), e.g.:
//   [hypercore] conflict detected in <discoveryKeyHex> (writable=true,quorum=1)
// Intercepting it is how we arm the seatbelt source-agnostically: per-core
// listeners only cover our own base.local/base.view, so a remote member's fork
// would otherwise set no _lastConflictAt and still crash everyone. Returns the
// discoveryKey hex (for best-effort attribution) or null if the line isn't one.
const CONFLICT_LOG_RE = /^\[hypercore\] conflict detected in ([0-9a-f]+)/

function parseConflictLog (arg) {
  if (typeof arg !== 'string') return null
  const m = CONFLICT_LOG_RE.exec(arg)
  return m ? m[1] : null
}

module.exports = { shouldSwallowFault, isConflictFallout, parseConflictLog, CONFLICT_GRACE_MS }
