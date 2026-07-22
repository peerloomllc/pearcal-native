// TODO #123 — the block-encryption key must never be lost from a group record.
//
// The key is local-only: it is stripped before every Autobase view append, so any
// record read back out of the view is keyless. Four separate call sites were each
// found writing such a record straight to local storage, silently destroying the
// key — after which the group reopens UNENCRYPTED on the raw swarm topic, stops
// syncing against keyed peers, and every invite minted afterwards omits `enc`.
//
// Chasing those sites one at a time is a losing game, so bare.js funnels every
// local group-record write through a single guard. This is that guard's pure
// decision, split out so it is unit-testable (bare.js touches BareKit/Pear at
// load and cannot be required from tests). Same split as ownerGuard.js.

'use strict'

// Decide which encryptionKey a group-record write should actually persist.
//
//   { key, blocked, reason }
//
// `blocked` is true when the caller tried to lose or change a key we already
// hold — the caller's value is overridden and bare.js logs the call site, which
// may be the only way the culprit is ever identified in the wild.
function resolveGroupEncryptionKey ({ priorKey, incomingKey }) {
  // Nothing held yet: accept whatever the caller has, including nothing. A
  // legacy (unencrypted) group legitimately has no key and must stay that way.
  if (!priorKey) return { key: incomingKey ?? null, blocked: false, reason: 'no-prior-key' }
  if (!incomingKey) return { key: priorKey, blocked: true, reason: 'drop' }
  // A rekey mints a NEW group id, so the key changing under a stable id is never
  // legitimate. Keep what we hold rather than lose the ability to decrypt.
  if (incomingKey !== priorKey) return { key: priorKey, blocked: true, reason: 'change' }
  return { key: priorKey, blocked: false, reason: 'unchanged' }
}

module.exports = { resolveGroupEncryptionKey }
