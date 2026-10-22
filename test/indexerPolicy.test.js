const test = require('node:test')
const assert = require('node:assert')
const { decideIndexerChange, STABLE_MS, DEAD_MS, OWNER_AWAY_MS } = require('../src/lib/indexerPolicy.js')

const NOW = 1_000_000_000_000
const OLD = NOW - STABLE_MS - 1
// Device: key, member, identity, live, plus overrides.
const W = (key, memberId, identity, live = true, extra = {}) =>
  ({ key, memberId, identity, v: 3, firstSeen: OLD, lastSeen: live ? NOW : NOW - 1000, live, ...extra })
const base = (over = {}) => ({
  myKey: 'k1', myIdentity: 'idOwner', isOwner: true, gateReady: true, minVersion: 3,
  indexers: ['k1'], writers: [], activeMemberIds: ['owner', 'ana', 'ben', 'cal'], now: NOW, ...over,
})
const keys = r => r.ops.map(o => (o.indexer ? '+' : '-') + o.addWriter).sort()

test('nothing happens while the gate is closed', () => {
  const r = decideIndexerChange(base({ gateReady: false, writers: [W('k2', 'ana', 'a'), W('k3', 'ben', 'b')] }))
  assert.deepEqual(r.ops, [])
})

test('only the owner proposes', () => {
  const r = decideIndexerChange(base({ isOwner: false, writers: [W('k2', 'ana', 'a'), W('k3', 'ben', 'b')] }))
  assert.deepEqual(r.ops, [])
})

test('a solo calendar stays at one signer', () => {
  assert.deepEqual(decideIndexerChange(base()).ops, [])
})

test('one plain writer is not enough: never go to two', () => {
  const r = decideIndexerChange(base({ writers: [W('k2', 'ana', 'a')] }))
  assert.deepEqual(r.ops, [])
})

test('two eligible writers: grow 1 -> 3 in one batch', () => {
  const r = decideIndexerChange(base({ writers: [W('k2', 'ana', 'a'), W('k3', 'ben', 'b')] }))
  assert.deepEqual(keys(r), ['+k2', '+k3'])
})

test('a device newer than the stability window is not promoted', () => {
  const r = decideIndexerChange(base({ writers: [W('k2', 'ana', 'a'), W('k3', 'ben', 'b', true, { firstSeen: NOW - 1000 })] }))
  assert.deepEqual(r.ops, [])
})

test('offline, old-version and removed devices are not promoted', () => {
  for (const bad of [
    W('k3', 'ben', 'b', false),
    W('k3', 'ben', 'b', true, { v: 2 }),
    W('k3', 'gone', 'b'),
  ]) {
    assert.deepEqual(decideIndexerChange(base({ writers: [W('k2', 'ana', 'a'), bad] })).ops, [])
  }
})

test('prefers a person who does not already sign', () => {
  const r = decideIndexerChange(base({
    // The owner's own second device ranks last: it would add no new person.
    writers: [W('k5', 'owner', 'idOwner'), W('k2', 'ana', 'a'), W('k3', 'ben', 'b')],
  }))
  assert.deepEqual(keys(r), ['+k2', '+k3'])
})

test('two signers today: top up to three', () => {
  const r = decideIndexerChange(base({
    indexers: ['k1', 'k2'], writers: [W('k2', 'ana', 'a'), W('k3', 'ben', 'b')],
  }))
  assert.deepEqual(keys(r), ['+k3'])
})

test('two signers with the other one offline: quorum unreachable, do nothing', () => {
  const r = decideIndexerChange(base({
    indexers: ['k1', 'k2'], writers: [W('k2', 'ana', 'a', false), W('k3', 'ben', 'b')],
  }))
  assert.deepEqual(r.ops, [])
  assert.equal(r.reason, 'quorum unreachable')
})

test('three healthy signers: nothing to do', () => {
  const r = decideIndexerChange(base({
    indexers: ['k1', 'k2', 'k3'], writers: [W('k2', 'ana', 'a'), W('k3', 'ben', 'b'), W('k4', 'cal', 'c')],
  }))
  assert.deepEqual(r.ops, [])
})

test('a signer offline for a short while is not replaced', () => {
  const r = decideIndexerChange(base({
    indexers: ['k1', 'k2', 'k3'],
    writers: [W('k2', 'ana', 'a'), W('k3', 'ben', 'b', false, { lastSeen: NOW - DEAD_MS + 60000 }), W('k4', 'cal', 'c')],
  }))
  assert.deepEqual(r.ops, [])
})

test('a dead signer is swapped for a live one in one batch', () => {
  const r = decideIndexerChange(base({
    indexers: ['k1', 'k2', 'k3'],
    writers: [W('k2', 'ana', 'a'), W('k3', 'ben', 'b', false, { lastSeen: NOW - DEAD_MS - 1 }), W('k4', 'cal', 'c')],
  }))
  assert.deepEqual(keys(r), ['+k4', '-k3'])
})

test('a removed member\'s signer is swapped out without waiting', () => {
  const r = decideIndexerChange(base({
    indexers: ['k1', 'k2', 'k3'],
    writers: [W('k2', 'ana', 'a'), W('k3', 'gone', 'g', false), W('k4', 'cal', 'c')],
  }))
  assert.deepEqual(keys(r), ['+k4', '-k3'])
})

test('a dead signer with nobody to replace it stays: replace, never shrink', () => {
  const r = decideIndexerChange(base({
    indexers: ['k1', 'k2', 'k3'],
    writers: [W('k2', 'ana', 'a'), W('k3', 'ben', 'b', false, { lastSeen: NOW - DEAD_MS - 1 })],
  }))
  assert.deepEqual(r.ops, [])
})

test('repair: seven signers, four online, cut to three in one batch', () => {
  const r = decideIndexerChange(base({
    indexers: ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7'],
    writers: [
      W('k2', 'ana', 'a'), W('k3', 'ben', 'b'), W('k4', 'cal', 'c'),
      W('k5', 'ana', 'a', false), W('k6', 'ben', 'b', false), W('k7', 'cal', 'c', false),
    ],
  }))
  assert.deepEqual(keys(r), ['-k4', '-k5', '-k6', '-k7'])
})

test('repair is refused without a live majority', () => {
  const r = decideIndexerChange(base({
    indexers: ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7'],
    writers: [W('k2', 'ana', 'a'), W('k3', 'ben', 'b'), W('k4', 'cal', 'c', false)],
  }))
  assert.deepEqual(r.ops, [])
})

test('repair fills from plain writers when too few signers are live', () => {
  const r = decideIndexerChange(base({
    indexers: ['k1', 'k2', 'k3', 'k4'],
    writers: [W('k2', 'ana', 'a'), W('k3', 'ben', 'b'), W('k4', 'gone', 'g'), W('k9', 'cal', 'c')],
  }))
  // k4 belongs to a removed member: not kept even though live.
  assert.deepEqual(keys(r), ['-k4'])
})

test('never demotes the proposing device, and the result is always three', () => {
  const r = decideIndexerChange(base({
    myKey: 'k9',
    indexers: ['k2', 'k3', 'k4', 'k9'],
    writers: [W('k2', 'ana', 'a'), W('k3', 'ben', 'b'), W('k4', 'cal', 'c')],
  }))
  assert.ok(!r.ops.some(o => o.addWriter === 'k9' && !o.indexer))
  assert.equal(r.ops.filter(o => !o.indexer).length, 1)
})

test('of two live owner devices that sign, only the lower key proposes', () => {
  const s = {
    indexers: ['k1', 'k0', 'k2'],
    writers: [W('k0', 'owner', 'idOwner'), W('k2', 'ana', 'a'), W('k3', 'ben', 'b')],
  }
  assert.equal(decideIndexerChange(base(s)).reason, 'another owner device proposes')
})

// The backup proposer (TODO #159 follow-up).
const longGone = NOW - DEAD_MS - 1

test('an owner restored onto a new phone still proposes without being a signer', () => {
  const r = decideIndexerChange(base({
    myKey: 'k9',
    indexers: ['k1', 'k2', 'k3'],
    writers: [
      W('k1', 'owner', 'idOwner', false, { lastSeen: longGone }),
      W('k2', 'ana', 'a'), W('k3', 'ben', 'b'), W('k4', 'cal', 'c'),
    ],
  }))
  assert.deepEqual(keys(r), ['+k4', '-k1'])
})

const standIn = (over = {}) => base({
  myKey: 'k2', myIdentity: 'a', isOwner: false, ownerIdentity: 'idOwner',
  ownerLastSeen: longGone,
  indexers: ['k1', 'k2', 'k3'],
  writers: [
    W('k1', 'owner', 'idOwner', false, { lastSeen: longGone }),
    W('k3', 'ben', 'b'), W('k4', 'cal', 'c'),
  ],
  ...over,
})

test('with the owner gone a week, the lowest online signer stands in', () => {
  assert.deepEqual(keys(decideIndexerChange(standIn())), ['+k4', '-k1'])
})

test('a stand-in waits while the owner was seen within the week', () => {
  const r = decideIndexerChange(standIn({ ownerLastSeen: NOW - OWNER_AWAY_MS + 60000 }))
  assert.deepEqual(r.ops, [])
})

test('a stand-in never acts while any owner device is online', () => {
  const r = decideIndexerChange(standIn({
    writers: [W('k1', 'owner', 'idOwner', false), W('k8', 'owner', 'idOwner'), W('k3', 'ben', 'b'), W('k4', 'cal', 'c')],
  }))
  assert.equal(r.reason, 'owner is online')
})

test('only the lowest-keyed signer stands in', () => {
  const r = decideIndexerChange(standIn({
    myKey: 'k3', myIdentity: 'b',
    writers: [W('k1', 'owner', 'idOwner', false, { lastSeen: longGone }), W('k2', 'ana', 'a'), W('k4', 'cal', 'c')],
  }))
  assert.equal(r.reason, 'another signer stands in')
})

test('a member who is not a signer never stands in', () => {
  const r = decideIndexerChange(standIn({ myKey: 'k4', myIdentity: 'c' }))
  assert.deepEqual(r.ops, [])
})

test('a stand-in with no word of the owner at all waits', () => {
  const r = decideIndexerChange(standIn({ ownerLastSeen: undefined }))
  assert.deepEqual(r.ops, [])
})

test('demotions are marked so apply can tell them from a plain grant', () => {
  const r = decideIndexerChange(base({
    indexers: ['k1', 'k2', 'k3'],
    writers: [W('k2', 'ana', 'a'), W('k3', 'gone', 'g', false), W('k4', 'cal', 'c')],
  }))
  assert.deepEqual(r.ops.find(o => o.addWriter === 'k3'), { addWriter: 'k3', indexer: false, demote: true })
  assert.deepEqual(r.ops.find(o => o.addWriter === 'k4'), { addWriter: 'k4', indexer: true })
})
