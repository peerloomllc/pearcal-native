const test = require('node:test')
const assert = require('node:assert')
const { buildLiveSeen, mergeLiveSeen, isRelayedLive, LIVE_TTL_MS, MAX_KEYS_PER_GROUP } = require('../src/lib/liveness.js')

const K = c => c.repeat(64)
const NOW = 1_000_000_000

test('direct sightings go out with age zero', () => {
  assert.deepEqual(buildLiveSeen([K('a'), K('b')], new Map(), NOW), [[K('a'), 0], [K('b'), 0]])
})

test('relayed sightings keep their age, and expire after the TTL', () => {
  const relayed = new Map([[K('c'), NOW - 5000], [K('d'), NOW - LIVE_TTL_MS]])
  assert.deepEqual(buildLiveSeen([], relayed, NOW), [[K('c'), 5000]])
})

test('a direct sighting beats a relayed one for the same writer', () => {
  const relayed = new Map([[K('a'), NOW - 9000]])
  assert.deepEqual(buildLiveSeen([K('a')], relayed, NOW), [[K('a'), 0]])
})

test('merging records the sighting time from the age, not the receive time', () => {
  const relayed = new Map()
  assert.equal(mergeLiveSeen(relayed, [[K('c'), 20000]], K('m'), NOW), 1)
  assert.equal(relayed.get(K('c')), NOW - 20000)
  assert.equal(isRelayedLive(relayed, K('c'), NOW), true)
  assert.equal(isRelayedLive(relayed, K('c'), NOW + LIVE_TTL_MS), false)
})

test('an older report never overwrites a newer sighting', () => {
  const relayed = new Map([[K('c'), NOW - 1000]])
  mergeLiveSeen(relayed, [[K('c'), 60000]], K('m'), NOW)
  assert.equal(relayed.get(K('c')), NOW - 1000)
})

test('a hop keeps the original age, so liveness cannot be refreshed by relaying', () => {
  // B saw C 100 s ago and tells A; A passes it on 50 s later.
  const atA = new Map()
  mergeLiveSeen(atA, [[K('c'), 100000]], K('a'), NOW)
  const sent = buildLiveSeen([], atA, NOW + 50000)
  assert.deepEqual(sent, [[K('c'), 150000]])
  const atD = new Map()
  mergeLiveSeen(atD, sent, K('d'), NOW + 50000)
  assert.equal(isRelayedLive(atD, K('c'), NOW + 50000 + (LIVE_TTL_MS - 150000) + 1), false)
})

test('ignores our own key, bad keys and bad ages', () => {
  const relayed = new Map()
  const n = mergeLiveSeen(relayed, [
    [K('m'), 0], ['nothex', 0], [K('e'), -5], [K('e'), LIVE_TTL_MS], [K('e'), 'soon'], 'junk', [K('f'), 0],
  ], K('m'), NOW)
  assert.equal(n, 1)
  assert.deepEqual([...relayed.keys()], [K('f')])
  assert.equal(mergeLiveSeen(relayed, null, K('m'), NOW), 0)
})

test('a peer cannot flood the table', () => {
  const many = Array.from({ length: 500 }, (_, i) => [i.toString(16).padStart(64, '0'), 0])
  const relayed = new Map()
  assert.equal(mergeLiveSeen(relayed, many, K('m'), NOW), MAX_KEYS_PER_GROUP)
})
