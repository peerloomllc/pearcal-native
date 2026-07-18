// Fix 2 (TODO #117) — authenticate two self-destructive group control paths
// against the group's AUTHORITATIVE Autobase view instead of unauthenticated
// plaintext or a stale local mirror. Kept out of bare.js so the decisions are
// unit-testable (bare.js touches BareKit/Pear at load and can't be required).
//
// Background (the EncTestv-class corruption): an old-build peer joined an
// encrypted group, couldn't decrypt it, and — treating the undecryptable view
// as "empty / owner absent" — both tripped owner-recovery and, on leave, booted
// another member. Fix 1 (#198, merged) already stops old-code peers from
// connecting to encrypted groups at all; these guards are defense-in-depth for
// legacy (unencrypted) groups and the pre-existing owner-recovery landmine.
//
// A genuine removal / a genuinely absent owner is recorded in the encrypted
// Autobase view by an authorized writer. A peer without the encryption key
// can't forge that view, so corroborating against it is the security boundary.

'use strict'

// Is `selfId` present in the view record's removedMembers list? removedMembers
// entries are sometimes bare ids and sometimes { id, ... } objects.
function isMemberRemovedInView (viewGroup, selfId) {
  const removed = viewGroup?.removedMembers ?? []
  return removed.some(m => (m?.id ?? m) === selfId)
}

// Decide whether an incoming `memberLeft(self)` control message — which is
// UNAUTHENTICATED plaintext over the writer-announce channel, so any connected
// peer could forge memberLeft(us) to make us self-delete — should be IGNORED.
//
// Ignore only when we can positively read the authoritative view AND it does
// NOT corroborate our removal (not in removedMembers, and we haven't already
// recorded a local block). If the view is unreadable (`viewGroup` null —
// undecryptable / not yet synced), return false so we fall through to the
// legacy best-effort behavior; #198 already covers the encrypted case at the
// connection layer, so falling through only affects legacy groups.
//
// A genuine owner-initiated removal still propagates: the owner also writes the
// victim into the authoritative removedMembers, so `isMemberRemovedInView` is
// true and this returns false (proceed to self-delete). Even in the race where
// the plaintext message beats the base record, the message is ignored here and
// the authoritative self-removal auto-leave path fires once the record
// replicates — so removal is never lost, only ever gated.
function shouldIgnoreSelfMemberLeft ({ viewGroup, blocked, selfId }) {
  if (!viewGroup) return false            // unreadable view → best-effort fall-through
  if (blocked) return false               // already recorded as blocked → proceed
  return !isMemberRemovedInView(viewGroup, selfId) // readable & not removed → forged, ignore
}

// Decide whether a non-owner ownership claim is justified, judged strictly from
// the AUTHORITATIVE view record — never a local mirror. The local
// lastOwnerActivityTs goes stale for two very different reasons: the owner is
// genuinely gone (a legit claim after CLAIM_OWNERSHIP_INACTIVITY_MS), OR we
// simply can't read the owner's recent activity because the encrypted view is
// undecryptable or the base hasn't caught up. An unreadable view (`viewGroup`
// null) must NOT be mistaken for an absent owner — that is exactly the landmine
// that let an undecryptable peer seize an encrypted group. Returns
// { ok, reason }; apply() re-enforces the same inactivity rule against the view
// so a tampered client can't bypass this.
function canClaimOwnership ({ viewGroup, selfId, now, inactivityMs }) {
  if (!viewGroup) return { ok: false, reason: 'view-unreadable' }
  if (viewGroup.ownerId === selfId) return { ok: false, reason: 'already-owner' }
  if (!(viewGroup.members ?? []).some(m => (m?.id ?? m) === selfId)) {
    return { ok: false, reason: 'not-a-member' }
  }
  const lastActivity = viewGroup.lastOwnerActivityTs ?? viewGroup.updatedAt ?? 0
  const elapsed = now - lastActivity
  if (elapsed <= inactivityMs) return { ok: false, reason: 'owner-active' }
  return { ok: true, reason: 'owner-inactive' }
}

// Decide whether an incoming plaintext `groupDeleted(groupId)` control message —
// which, like `memberLeft`, is UNAUTHENTICATED and forgeable by any connected
// peer — should be honored. `groupDeleted` is an OWNER-ONLY action, and a
// genuine owner deletion is recorded as a `deleted` tombstone on the group's
// authoritative Autobase view by apply(), only AFTER apply() verifies the op's
// Autobase-attested author (node.from.key) is the owner's writer. A peer without
// the encryption key can't forge that view state, so corroborating against it is
// the security boundary.
//
// Honor ONLY when the view positively carries the owner-authored deletion. An
// unreadable/absent/undecryptable view (`viewGroup` null) or a readable view with
// no `deleted` flag → do NOT honor. This never loses a real deletion: the same
// authoritative op that set the flag also drives apply()'s local purge, so an
// ignored plaintext message is at worst redundant.
function shouldHonorGroupDeleted ({ viewGroup }) {
  return viewGroup?.deleted === true
}

module.exports = {
  isMemberRemovedInView,
  shouldIgnoreSelfMemberLeft,
  canClaimOwnership,
  shouldHonorGroupDeleted,
}
