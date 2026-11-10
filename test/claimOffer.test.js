// GitHub #399 - a join that never reached the owner offered "Claim ownership"
// with "inactive for 20766 days" and then showed the raw worklet reason.
// Pure decision in src/lib/claimOffer.js. (bugfix/pending-join-claim-offer)
const test = require('node:test')
const assert = require('node:assert/strict')
const {
  claimOwnershipOffer, claimErrorMessage, isPendingJoin, CLAIM_OWNERSHIP_INACTIVITY_MS,
} = require('../src/lib/claimOffer.js')

const NOW = Date.UTC(2026, 10, 9)
const ME = 'me'
const OWNER = 'owner'

// Exactly what src/invite.js handleInviteLink writes for a fresh join.
const freshJoin = () => ({
  id: 'g1', name: 'JQL', ownerId: OWNER, joinedAt: NOW - 5 * 60_000,
  members: [{ id: ME, name: 'JQ', avatar: 'J' }, { id: OWNER, name: 'Inviter', avatar: '?' }],
})

test('#399: a join still on the Inviter placeholder never offers a claim', () => {
  const o = claimOwnershipOffer({ group: freshJoin(), selfId: ME, now: NOW })
  assert.equal(o.pendingJoin, true)
  assert.equal(o.canClaim, false)
  assert.equal(o.lastActivityTs, null)
  assert.equal(o.inactiveDays, 0, 'no timestamp must not read as 20766 days')
})

test('a synced group with no owner timestamp at all does not offer a claim', () => {
  const g = { ...freshJoin(), members: [{ id: ME, name: 'JQ' }, { id: OWNER, name: 'Sam', avatar: 'S' }] }
  const o = claimOwnershipOffer({ group: g, selfId: ME, now: NOW })
  assert.equal(o.pendingJoin, false)
  assert.equal(o.canClaim, false)
})

test('a synced group whose owner is quiet past the limit still offers a claim', () => {
  const g = {
    ...freshJoin(),
    members: [{ id: ME, name: 'JQ' }, { id: OWNER, name: 'Sam', avatar: 'S' }],
    lastOwnerActivityTs: NOW - CLAIM_OWNERSHIP_INACTIVITY_MS - 86_400_000,
  }
  const o = claimOwnershipOffer({ group: g, selfId: ME, now: NOW })
  assert.equal(o.canClaim, true)
  assert.equal(o.inactiveDays, 31)
})

test('an active owner, the owner themselves and a non-member get no offer', () => {
  const synced = { ...freshJoin(), members: [{ id: ME, name: 'JQ' }, { id: OWNER, name: 'Sam' }] }
  assert.equal(claimOwnershipOffer({ group: { ...synced, lastOwnerActivityTs: NOW - 86_400_000 }, selfId: ME, now: NOW }).canClaim, false)
  const old = { ...synced, lastOwnerActivityTs: NOW - 2 * CLAIM_OWNERSHIP_INACTIVITY_MS }
  assert.equal(claimOwnershipOffer({ group: old, selfId: OWNER, now: NOW }).canClaim, false)
  assert.equal(claimOwnershipOffer({ group: old, selfId: 'stranger', now: NOW }).canClaim, false)
})

test('a placeholder needs both the name and the ? avatar', () => {
  assert.equal(isPendingJoin({ members: [{ id: 'x', name: 'Inviter', avatar: 'I' }] }), false)
  assert.equal(isPendingJoin(null), false)
})

test('#399: the raw worklet reason is never shown', () => {
  const msg = claimErrorMessage(new Error('claimOwnership: view-unreadable'))
  assert.doesNotMatch(msg, /claimOwnership|view-unreadable/)
  assert.match(msg, /hasn't received the group/)
  assert.match(claimErrorMessage(new Error('claimOwnership: owner-active')), /active recently/)
  assert.doesNotMatch(claimErrorMessage(new Error('something odd')), /something odd/)
})
