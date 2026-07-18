// Fix 2 (TODO #117) — the two self-destructive group control paths must be
// authenticated against the authoritative Autobase view, not unauthenticated
// plaintext or a stale local mirror. These test the pure decisions extracted to
// src/lib/ownerGuard.js. (bugfix/encrypted-group-owner-recovery-guard)
const test = require('node:test')
const assert = require('node:assert/strict')
const {
  isMemberRemovedInView,
  shouldIgnoreSelfMemberLeft,
  canClaimOwnership,
  shouldHonorGroupDeleted,
} = require('../src/lib/ownerGuard.js')

const SELF = 'self-id'
const DAY = 24 * 60 * 60 * 1000
const INACTIVITY = 30 * DAY

// ── isMemberRemovedInView ─────────────────────────────────────────────────
test('isMemberRemovedInView matches object-shaped removedMembers', () => {
  assert.equal(isMemberRemovedInView({ removedMembers: [{ id: SELF }] }, SELF), true)
})
test('isMemberRemovedInView matches bare-id removedMembers', () => {
  assert.equal(isMemberRemovedInView({ removedMembers: [SELF] }, SELF), true)
})
test('isMemberRemovedInView false when absent / empty / missing', () => {
  assert.equal(isMemberRemovedInView({ removedMembers: [{ id: 'other' }] }, SELF), false)
  assert.equal(isMemberRemovedInView({ removedMembers: [] }, SELF), false)
  assert.equal(isMemberRemovedInView({}, SELF), false)
  assert.equal(isMemberRemovedInView(null, SELF), false)
})

// ── shouldIgnoreSelfMemberLeft ────────────────────────────────────────────
test('forged memberLeft is IGNORED when the readable view does not corroborate removal', () => {
  // Attacker without the encryption key can't write us into removedMembers.
  const viewGroup = { members: [{ id: SELF }], removedMembers: [] }
  assert.equal(shouldIgnoreSelfMemberLeft({ viewGroup, blocked: false, selfId: SELF }), true)
})

test('genuine owner removal is HONORED — self in authoritative removedMembers', () => {
  const viewGroup = { members: [], removedMembers: [{ id: SELF }] }
  assert.equal(shouldIgnoreSelfMemberLeft({ viewGroup, blocked: false, selfId: SELF }), false)
})

test('unreadable view falls through (best-effort) — do not ignore', () => {
  // Undecryptable / not-yet-synced view: #198 covers the encrypted case at the
  // connection layer, so falling through only affects legacy groups.
  assert.equal(shouldIgnoreSelfMemberLeft({ viewGroup: null, blocked: false, selfId: SELF }), false)
})

test('a locally-recorded block honors the leave even if view lags', () => {
  const viewGroup = { members: [{ id: SELF }], removedMembers: [] }
  assert.equal(shouldIgnoreSelfMemberLeft({ viewGroup, blocked: true, selfId: SELF }), false)
})

// ── canClaimOwnership ─────────────────────────────────────────────────────
test('claim refused when view is unreadable (undecryptable ≠ owner absent)', () => {
  const d = canClaimOwnership({ viewGroup: null, selfId: SELF, now: 1e15, inactivityMs: INACTIVITY })
  assert.equal(d.ok, false)
  assert.equal(d.reason, 'view-unreadable')
})

test('claim refused when owner active within the inactivity window', () => {
  const now = 1_000_000_000_000
  const viewGroup = { ownerId: 'owner', members: [{ id: SELF }], lastOwnerActivityTs: now - DAY }
  const d = canClaimOwnership({ viewGroup, selfId: SELF, now, inactivityMs: INACTIVITY })
  assert.equal(d.ok, false)
  assert.equal(d.reason, 'owner-active')
})

test('claim granted after sufficient owner inactivity, judged from the view', () => {
  const now = 1_000_000_000_000
  const viewGroup = { ownerId: 'owner', members: [{ id: SELF }], lastOwnerActivityTs: now - (INACTIVITY + DAY) }
  const d = canClaimOwnership({ viewGroup, selfId: SELF, now, inactivityMs: INACTIVITY })
  assert.equal(d.ok, true)
  assert.equal(d.reason, 'owner-inactive')
})

test('claim refused when self is not a member of the authoritative view', () => {
  const now = 1_000_000_000_000
  const viewGroup = { ownerId: 'owner', members: [{ id: 'other' }], lastOwnerActivityTs: 0 }
  const d = canClaimOwnership({ viewGroup, selfId: SELF, now, inactivityMs: INACTIVITY })
  assert.equal(d.ok, false)
  assert.equal(d.reason, 'not-a-member')
})

test('claim refused when self is already the owner in the view', () => {
  const viewGroup = { ownerId: SELF, members: [{ id: SELF }], lastOwnerActivityTs: 0 }
  const d = canClaimOwnership({ viewGroup, selfId: SELF, now: 1e15, inactivityMs: INACTIVITY })
  assert.equal(d.ok, false)
  assert.equal(d.reason, 'already-owner')
})

test('claim falls back to updatedAt when lastOwnerActivityTs is absent (legacy groups)', () => {
  const now = 1_000_000_000_000
  const stale = { ownerId: 'owner', members: [{ id: SELF }], updatedAt: now - (INACTIVITY + DAY) }
  assert.equal(canClaimOwnership({ viewGroup: stale, selfId: SELF, now, inactivityMs: INACTIVITY }).ok, true)
  const fresh = { ownerId: 'owner', members: [{ id: SELF }], updatedAt: now - DAY }
  assert.equal(canClaimOwnership({ viewGroup: fresh, selfId: SELF, now, inactivityMs: INACTIVITY }).ok, false)
})

// ── shouldHonorGroupDeleted ───────────────────────────────────────────────
test('groupDeleted honored only when the view carries the owner-authored deletion', () => {
  // apply() sets `deleted:true` after verifying node.from.key === owner's writer.
  assert.equal(shouldHonorGroupDeleted({ viewGroup: { deleted: true } }), true)
  assert.equal(shouldHonorGroupDeleted({ viewGroup: { deleted: true, deletedAt: 123 } }), true)
})

test('forged groupDeleted ignored when the view shows no deletion', () => {
  // A keyless peer can't forge the `deleted` flag in the encrypted view.
  assert.equal(shouldHonorGroupDeleted({ viewGroup: { members: [{ id: SELF }] } }), false)
  assert.equal(shouldHonorGroupDeleted({ viewGroup: { deleted: false } }), false)
})

test('groupDeleted ignored when the view is unreadable / absent (no false positive)', () => {
  // Undecryptable / not-yet-synced view must never read as "deleted" — the
  // authoritative base op still purges once it applies.
  assert.equal(shouldHonorGroupDeleted({ viewGroup: null }), false)
  assert.equal(shouldHonorGroupDeleted({ viewGroup: undefined }), false)
})
