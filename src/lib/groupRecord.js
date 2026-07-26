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

// TODO #124 - a one-way "this group is encrypted" latch.
//
// A damaged encrypted group and a legacy unencrypted group are INDISTINGUISHABLE
// on disk: both are just a group record with no encryptionKey. That ambiguity,
// not reachability, is what stops a keyless device from ever working out that it
// is the broken one, so it opens the group unencrypted on the raw groupKey
// topic, never meets a keyed peer, and mints invites with no `enc=` that break
// whoever accepts them.
//
// The latch closes that gap. It is set the first time we ever see a key for the
// group and never cleared, so it OUTLIVES the key's loss by construction. After
// that, `encrypted === true && !encryptionKey` is a definitive, offline, instant
// "this device is the broken one".
//
// It is monotonic for the same reason resolveGroupEncryptionKey exists: the
// record is rewritten from view-derived (keyless) values all over the place, and
// any flag that those writes could clear would be lost in exactly the same way
// the key was. It rides the same choke point, so there is one place to be right.
//
// Non-secret, and deliberately LOCAL-only, never appended to a view. A flag
// carried in the view would be useless here: the view of an encrypted group is
// itself encrypted, so the one device that needs to read it is the one device
// that cannot.
function resolveGroupEncryptedFlag ({ priorEncrypted, priorKey, incomingEncrypted, incomingKey }) {
  // Holding a key, now or before, proves the group is encrypted.
  if (priorKey || incomingKey) return true
  // Otherwise the latch only ever moves false -> true.
  return !!(priorEncrypted || incomingEncrypted)
}

// Classify a local group record as damaged (encrypted but keyless), for the
// warning surfaced to the user.
//
//   'certain' - the latch says encrypted and we hold no key. Not a guess.
//   'likely'  - no latch (record predates it), but the group has been joined a
//               good while and STILL has no peer-supplied membership, which is
//               what a keyless device looks like: it is on the wrong swarm topic
//               so it never meets anyone. A group whose members are merely
//               offline looks the same, hence 'likely' and a soft warning.
//   'no'      - healthy, or a legitimate legacy unencrypted group.
//
// `peerCount` is the number of RESOLVED peers the record carries: members that
// are neither this device nor the unresolved "Inviter" placeholder that the
// invite-join path seeds. That distinction matters and device testing proved
// it: a keyless group joined by invite always starts at TWO raw members (self +
// placeholder), so a naive member count never drops to 1 and the heuristic
// would never fire for the exact real-world case. A device that has actually
// met a peer has the owner's real record in place of the placeholder, so
// peerCount >= 1. A keyless device meets no one, so peerCount === 0.
function classifyKeylessGroup ({
  encrypted, encryptionKey, joinedAt, peerCount, now, staleAfterMs,
}) {
  if (encryptionKey) return { damaged: false, certainty: 'no', reason: 'has-key' }
  if (encrypted) return { damaged: true, certainty: 'certain', reason: 'latched-encrypted-no-key' }
  // `== null` rather than falsy: 0 is a legitimate timestamp, and treating it as
  // "unknown" would silently skip the check for the oldest records of all.
  if (joinedAt == null || typeof joinedAt !== 'number' || !staleAfterMs) {
    return { damaged: false, certainty: 'no', reason: 'unknown-age' }
  }
  if ((now - joinedAt) < staleAfterMs) return { damaged: false, certainty: 'no', reason: 'too-recent' }
  if ((peerCount ?? 0) > 0) return { damaged: false, certainty: 'no', reason: 'has-peers' }
  return { damaged: true, certainty: 'likely', reason: 'never-synced' }
}

// Count members that prove this device has actually synced with the group: not
// itself, and not the "Inviter" placeholder (name 'Inviter' + avatar '?') that
// handleInviteLink seeds and the owner's real record later overwrites. See
// classifyKeylessGroup for why the placeholder must be excluded.
function resolvedPeerCount (members, selfId) {
  if (!Array.isArray(members)) return 0
  let n = 0
  for (const m of members) {
    if (!m || m.id === selfId) continue
    if (m.name === 'Inviter' && m.avatar === '?') continue
    n++
  }
  return n
}

// TODO #142 - is this record one the latch should already have been set on?
//
// The latch is only ever set as a side effect of a group-record write, and it
// shipped (2026-07-23) after groups that already held keys, so those records sit
// at `encryptionKey` present + `encrypted` false: plainly encrypted, but not
// saying so. That is the exact state the latch exists to prevent. Lose the key
// from such a record via one of the #123 paths and nothing distinguishes it from
// a legacy unencrypted group - classifyKeylessGroup drops from 'certain' to a
// soft 'likely' at best, and the device reopens the group in the clear.
//
// Holding a key is proof, so this needs no heuristic and no network: it is a
// one-pass boot repair over local records.
function needsEncryptedLatchBackfill (record) {
  return !!(record && record.encryptionKey && !record.encrypted)
}

// The other half of the same sweep's value: a record that claims encrypted and
// holds NO key is a device that has definitively lost it (TODO #123/#124). There
// is nothing to repair locally - recovery needs a fresh invite or a sibling - so
// the sweep only reports these, but reporting them at all is new. Deliberately
// not folded into the function above: one returns work to do, this one returns a
// thing to say.
function isEncryptedButKeyless (record) {
  return !!(record && record.encrypted && !record.encryptionKey)
}

module.exports = {
  resolveGroupEncryptionKey,
  resolveGroupEncryptedFlag,
  classifyKeylessGroup,
  resolvedPeerCount,
  needsEncryptedLatchBackfill,
  isEncryptedButKeyless,
}
