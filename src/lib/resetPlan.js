// TODO #118 — what an in-app "Reset app data" actually removes.
//
// Two decisions live here rather than inline in bare.js, so they can be
// asserted without booting a worklet (bare.js touches BareKit at load and
// cannot be required from tests). Same split as relay.js and groupRecord.js.
//
// The decisions are small but both are easy to get wrong in a way that is
// silent and destructive:
//
//   1. WHICH LEVEL. A reset whose level is ambiguous must fall back to the
//      one that keeps the identity. Getting this backwards deletes a user's
//      recovery phrase because a caller passed the wrong shape.
//   2. WHICH PATHS. rebuildLocalDb writes `core.new` / `core.old` beside the
//      live `core` and renames through them. An aborted rebuild leaves one
//      behind, so a reset that removed only `core` and `store` would leave a
//      full copy of the "wiped" calendar sitting on disk.

'use strict'

// Data roots under the PearCal data directory. Deliberately an explicit list
// rather than "delete dataDir": on mobile the shell owns and created that
// directory, and on desktop unrelated siblings (skipped-updates.json) live
// beside these and are not ours to destroy.
//
// `core.new` and `core.old` are rebuildLocalDb's staging + backup dirs. They
// normally exist only mid-rebuild, but an aborted one leaves a readable copy
// of the old database behind, which is exactly what a reset must not miss.
const DATA_SUBPATHS = ['core', 'store', 'core.new', 'core.old']

// Resolve a caller's options into a concrete plan.
//
// keepIdentity defaults to TRUE for anything that is not an explicit `false`.
// Deleting the recovery phrase is the one irreversible half of this feature, so
// an unrecognised or missing option must never be what triggers it - the UI has
// to ask for it in so many words.
function resetPlan (opts) {
  const keepIdentity = (opts && opts.keepIdentity) !== false
  return {
    keepIdentity,
    deleteIdentity: !keepIdentity,
    subpaths: DATA_SUBPATHS.slice(),
  }
}

module.exports = { resetPlan, DATA_SUBPATHS }
