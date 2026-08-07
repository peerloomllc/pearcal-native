// Should we tell the user something about this calendar's signing devices?
// (TODO #159.)
//
// WHY THIS IS A MODULE AND NOT AN `&&` IN THE JSX. The first version of this
// notice was written inline as `canLose === 0 && count > 1`, which looked
// obviously right and was not: it appears only on two-device calendars and
// stays silent on every larger one. Tim's 5-member calendar - 7 signers, 2,825
// of 69,269 entries signed - showed nothing at all, which is precisely the
// calendar the notice exists for. Caught by him asking where it was.
//
// TWO DIFFERENT PROBLEMS, and a calendar can have either without the other:
//
//   no spare  - losing one more signing device strands the history for good.
//               This is about PERMANENT loss, and it is worst at 2 signers.
//   behind    - a majority is rarely online at once, so changes are piling up
//               unsigned. This is about DAY-TO-DAY reachability, and it gets
//               worse as a calendar grows. A 7-signer calendar scores fine on
//               "no spare" (it can lose three) and terribly on this.
//
// Reporting only the first is what made the second invisible.

// Don't nag a young calendar. A handful of unsigned entries is ordinary - the
// newest ones are always unsigned until the next round of acknowledgements,
// even on a perfectly healthy calendar.
const MIN_ENTRIES = 100
const BEHIND_PCT = 50

/**
 * @param {object|null} indexers  from indexerInfoFor(): { count, majority,
 *                                canLose, total, signed, behind, behindPct }
 * @returns {{kind: 'none'|'behind'|'no-spare', ...}}
 */
function classifyIndexerNotice (indexers) {
  if (!indexers || !indexers.count || indexers.count < 2) return { kind: 'none' }

  const total = Number(indexers.total) || 0
  const behindPct = Number(indexers.behindPct) || 0

  // "Behind" first when both apply: it is the one the user can actually feel,
  // and it means the calendar is already losing ground rather than merely being
  // one loss away from trouble.
  if (total >= MIN_ENTRIES && behindPct >= BEHIND_PCT) {
    return {
      kind: 'behind',
      count: indexers.count,
      majority: indexers.majority,
      behindPct,
    }
  }

  if (indexers.canLose === 0) {
    return { kind: 'no-spare', count: indexers.count, majority: indexers.majority }
  }

  return { kind: 'none' }
}

module.exports = { classifyIndexerNotice, MIN_ENTRIES, BEHIND_PCT }
