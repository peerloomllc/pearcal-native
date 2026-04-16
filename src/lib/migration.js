// Phase 2 of the group-rekey migration: helpers for building, storing, and
// verifying the signed migration marker that lives in the OLD Autobase and
// points members at the new group created in Phase 1.
//
// The marker is appended as a regular Autobase node:
//   { op: 'put', type: 'migration',
//     key: 'groupMigration:' + oldGroupId,
//     value: { v, oldGroupId, newGroupId, newGroupKey,
//              preparedAt, migratedAt, ownerId, ownerPubKey, sig } }
//
// ownerId is the owner's hex public key (pearcal invariant: profile.id ===
// profile.publicKey), repeated under ownerPubKey for readability. The sig is
// over canonicalized JSON of the payload WITHOUT the sig field.

const { canonicalize, signMessage, verifySignature } = require('./sign.js')

const MARKER_VERSION = 1

function markerKey (oldGroupId) {
  return 'groupMigration:' + oldGroupId
}

function buildMarker (descriptor, profile, now = Date.now()) {
  if (!descriptor?.oldGroupId || !descriptor?.newGroupId || !descriptor?.newGroupKey) {
    throw new Error('buildMarker: descriptor missing oldGroupId/newGroupId/newGroupKey')
  }
  if (!profile?.id || !profile?.publicKey || !profile?.secretKey) {
    throw new Error('buildMarker: profile missing id/publicKey/secretKey')
  }
  if (profile.id !== profile.publicKey) {
    throw new Error('buildMarker: profile.id must equal profile.publicKey')
  }
  const payload = {
    v:           MARKER_VERSION,
    oldGroupId:  descriptor.oldGroupId,
    newGroupId:  descriptor.newGroupId,
    newGroupKey: descriptor.newGroupKey,
    preparedAt:  descriptor.preparedAt ?? now,
    migratedAt:  now,
    ownerId:     profile.id,
    ownerPubKey: profile.publicKey,
  }
  const sig = signMessage(payload, profile.secretKey)
  return { ...payload, sig }
}

// Verify a marker value pulled from the view. `expectedOwnerId` should be the
// ownerId of the current (pre-migration) group record; if omitted we accept
// any ownerId but still require a valid signature over the embedded pubkey.
function verifyMarker (marker, { expectedOwnerId, expectedOldGroupId } = {}) {
  if (!marker || typeof marker !== 'object') return false
  if (marker.v !== MARKER_VERSION) return false
  const { sig, ...payload } = marker
  if (!sig || !payload.ownerId || !payload.ownerPubKey) return false
  if (payload.ownerId !== payload.ownerPubKey) return false
  if (expectedOwnerId && payload.ownerId !== expectedOwnerId) return false
  if (expectedOldGroupId && payload.oldGroupId !== expectedOldGroupId) return false
  return verifySignature(payload, sig, payload.ownerPubKey)
}

async function readMarker (view, oldGroupId) {
  const node = await view.get(markerKey(oldGroupId)).catch(() => null)
  return node?.value ?? null
}

module.exports = {
  MARKER_VERSION,
  markerKey,
  buildMarker,
  verifyMarker,
  readMarker,
  // Re-export for callers that also need raw canonicalize/verify
  canonicalize,
  signMessage,
  verifySignature,
}
