// GitHub #399 - a join that never reached the owner offered "Claim ownership".
//
// The invite path seeds a placeholder owner ("Inviter", avatar "?") and no
// lastOwnerActivityTs or updatedAt. Both UIs then measured owner inactivity
// from 0, so the very first open of a join that had not synced showed "The
// owner has been inactive for 20766 days" and a Claim button. The worklet
// rightly refused (claimOwnership: view-unreadable) and the raw reason was
// shown as the error.
//
// Kept pure so both the phone and desktop UIs make the same call and it can be
// tested without a WebView.

'use strict'

// Mirrors bare.js CLAIM_OWNERSHIP_INACTIVITY_MS. Keep in sync.
const CLAIM_OWNERSHIP_INACTIVITY_MS = 30 * 24 * 60 * 60 * 1000
const DAY_MS = 86_400_000

// The record still carries the invite placeholder, so this device has never
// received the owner's copy of the group. Same test as groupRecord.js
// resolvedPeerCount.
function isPendingJoin (group) {
  return (group?.members ?? []).some(m => m?.name === 'Inviter' && m?.avatar === '?')
}

// Should this device offer "Claim ownership", and how long has the owner been
// quiet? Returns { canClaim, inactiveDays, pendingJoin, lastActivityTs }.
// lastActivityTs is null when the record carries no timestamp at all, which
// means "unknown", never "inactive since 1970".
function claimOwnershipOffer ({ group, selfId, now, inactivityMs = CLAIM_OWNERSHIP_INACTIVITY_MS }) {
  const pendingJoin = isPendingJoin(group)
  const raw = group?.lastOwnerActivityTs ?? group?.updatedAt
  const lastActivityTs = typeof raw === 'number' && raw > 0 ? raw : null
  const isOwner = group?.ownerId === selfId
  const isMember = (group?.members ?? []).some(m => m?.id === selfId)
  const inactiveMs = lastActivityTs == null ? 0 : now - lastActivityTs
  const canClaim = !pendingJoin && !isOwner && isMember &&
    lastActivityTs != null && inactiveMs > inactivityMs
  return {
    canClaim,
    inactiveDays: Math.max(0, Math.floor(inactiveMs / DAY_MS)),
    pendingJoin,
    lastActivityTs,
  }
}

// Plain wording for a refused claim. The worklet throws
// "claimOwnership: <reason>" (see bare.js claimOwnership and
// ownerGuard.canClaimOwnership).
const CLAIM_ERROR_MESSAGES = {
  'view-unreadable': "This device hasn't received the group from its owner yet, so it can't claim it. Once it syncs with the owner or another member, try again.",
  'group base not open': "This device hasn't received the group from its owner yet, so it can't claim it. Once it syncs with the owner or another member, try again.",
  'owner-active': 'The owner has been active recently, so the group cannot be claimed.',
  'already-owner': 'You already own this group.',
  'already owner': 'You already own this group.',
  'not-a-member': 'This device is not a member of the group yet.',
  'not a member': 'This device is not a member of the group yet.',
  'group not found': 'This group is no longer on this device.',
  'append failed': "The claim couldn't be saved. Try again in a moment.",
}

function claimErrorMessage (err) {
  const msg = String(err?.message ?? err ?? '')
  const reason = msg.replace(/^claimOwnership:\s*/, '')
  return CLAIM_ERROR_MESSAGES[reason] ?? "The claim didn't go through. Try again in a moment."
}

module.exports = {
  CLAIM_OWNERSHIP_INACTIVITY_MS,
  isPendingJoin,
  claimOwnershipOffer,
  claimErrorMessage,
}
