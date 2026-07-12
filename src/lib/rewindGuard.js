// Writer-core rewind guard. Ported from PearCircle src/lib/rewindGuard.js
// (proposal 2026-06-27-fork-conflict-recovery, item 3 / decision 5a), pending
// PearCal wiring.
//
// Prevents a fork at its source: a single-writer hypercore can only fork if
// its length went backwards (truncation, e.g. WAL loss) and then forward with
// new content. Because nobody else signs our own writer core, the network
// holding a LONGER copy of it than we do can only mean we were truncated and
// peers kept the original tail. So before appending past a rewound tip we must
// download that original tail back; appending first would create the
// two-signatures-at-one-index fork.
//
// This is the pure decision: given our local length and the longest copy any
// connected peer advertises for our own core, decide whether we are behind and
// what range to pull back. Kept separate from bare.js so it is unit-testable.

// networkLength is max(peer.remoteLength) over the peers replicating our writer
// core; 0 when no peer is connected (then we are authoritative, not behind).
function writerRewindStatus ({ localLength, networkLength } = {}) {
  const local = Number.isFinite(localLength) ? localLength : 0
  const network = Number.isFinite(networkLength) ? networkLength : 0
  if (network <= local) return { behind: false, downloadFrom: 0, downloadTo: 0 }
  // We are behind on our OWN core => truncated. Pull the original tail
  // [local, network) before any further append.
  return { behind: true, downloadFrom: local, downloadTo: network }
}

module.exports = { writerRewindStatus }
