// Is this shared calendar still syncing?
//
// From the field, 2026-08-06: a five-member calendar stopped syncing and the app
// said nothing at all. The user worked it out himself and repaired it by
// creating a NEW group and moving every event across, which meant re-inviting
// everyone. His words: "this can't be the solution for the future".
//
// The gap he is pointing at is not the underlying bug, it is that the failure
// was SILENT. The only thing that surfaced a broken group before this was
// classifyKeylessGroup, which covers exactly one fault (encrypted-but-keyless)
// and whose heuristic path goes quiet as soon as a group has more than one
// peer - so it was guaranteed quiet for his case.
//
// Kept pure and separate from bare.js, like groupRecord.js, so the decision can
// be tested without standing up a worklet.

// A calendar that has not exchanged anything with anybody for this long, despite
// having other members, is worth mentioning. Deliberately generous: people go
// away for a weekend, phones stay off, and a false alarm teaches users to ignore
// the warning, which is worse than saying nothing.
const STALE_AFTER_MS = 48 * 60 * 60 * 1000

// Below this we say nothing at all, however stale. A brand new group has not
// synced yet by definition, and a group you just joined is still settling.
const GRACE_AFTER_JOIN_MS = 60 * 60 * 1000

// Classify one group's sync health.
//
//   lastSyncAt   ms, or null if we have never recorded an exchange
//   joinedAt     ms, or null if unknown
//   memberCount  members incl. self; 1 means there is nobody to sync WITH
//   now          ms
//
// Returns { state, sinceMs, reason } where state is one of:
//   'ok'       recently exchanged data, or too soon to judge
//   'alone'    no other members, so silence is expected, not a fault
//   'stale'    has other members and has not exchanged anything in a long time
//   'unknown'  not enough information to say (do NOT warn on this)
// `watchSince` is when THIS DEVICE started recording sync activity at all. It
// matters because "has not synced in 48h" is only sayable once we have been
// watching for 48h. Without it, every pre-existing group has no lastSyncAt the
// moment the feature ships, an old joinedAt, and therefore gets accused of
// being broken on the first launch after updating. Caught on the TCL doing
// exactly that, on a group that was fine.
function classifySyncHealth ({ lastSyncAt, joinedAt, watchSince, memberCount, now, staleAfterMs = STALE_AFTER_MS, graceMs = GRACE_AFTER_JOIN_MS } = {}) {
  if (typeof now !== 'number') return { state: 'unknown', sinceMs: null, reason: 'no-clock' }

  // Nobody to sync with. Saying "not syncing" to someone whose calendar is
  // private would be a bug report waiting to happen.
  if (typeof memberCount === 'number' && memberCount <= 1) {
    return { state: 'alone', sinceMs: null, reason: 'single-member' }
  }

  // Still settling after a join.
  if (typeof joinedAt === 'number' && (now - joinedAt) < graceMs) {
    return { state: 'ok', sinceMs: null, reason: 'recently-joined' }
  }

  if (typeof lastSyncAt !== 'number') {
    // Never recorded an exchange. Silence only counts from the LATER of when the
    // group was joined and when this device started watching - we cannot claim
    // 48h of silence after 5 minutes of observation.
    const baselines = []
    if (typeof joinedAt === 'number') baselines.push(joinedAt)
    if (typeof watchSince === 'number') baselines.push(watchSince)
    if (!baselines.length) return { state: 'unknown', sinceMs: null, reason: 'no-baseline' }
    const since = now - Math.max(...baselines)
    return since >= staleAfterMs
      ? { state: 'stale', sinceMs: since, reason: 'never-synced' }
      : { state: 'ok', sinceMs: since, reason: 'not-watching-long-enough' }
  }

  const since = now - lastSyncAt
  return since >= staleAfterMs
    ? { state: 'stale', sinceMs: since, reason: 'silent-too-long' }
    : { state: 'ok', sinceMs: since, reason: 'recent' }
}

// Should this stamp be written? The apply loop sees remote nodes in bursts, and
// writing on every one would be exactly the write-amplification pattern that
// caused trouble elsewhere in this codebase. One write per group per interval is
// plenty for a 48h judgement.
const STAMP_INTERVAL_MS = 60 * 1000

function shouldStampSync (previousTs, now, intervalMs = STAMP_INTERVAL_MS) {
  if (typeof now !== 'number') return false
  if (typeof previousTs !== 'number') return true
  return (now - previousTs) >= intervalMs
}

module.exports = {
  classifySyncHealth,
  shouldStampSync,
  STALE_AFTER_MS,
  GRACE_AFTER_JOIN_MS,
  STAMP_INTERVAL_MS,
}
