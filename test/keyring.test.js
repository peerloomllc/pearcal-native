const test = require('node:test')
const assert = require('node:assert')
const b4a = require('b4a')
const {
  deriveKeys, empty, seal, open, clean, merge, entryFromGroup, groups, seeders, signClaim,
  NS, MAX_GROUPS, TOMBSTONE_MS
} = require('../src/lib/keyring.js')
const { checkSealed, checkClaim } = require('../src/peerloom-seeder/keyringRecord.js')

// The BIP39 test vector: all-zero entropy.
const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
// Twelve real words with a bad checksum.
const OTHER = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon'
const K = c => c.repeat(64)
const NOW = 1_800_000_000_000
const group = (id, extra = {}) => ({ id, name: 'Cal ' + id, groupKey: K('a'), encryptionKey: K('b'), ownerId: 'c'.repeat(32), ...extra })
const ring = (...items) => {
  const k = empty()
  for (const [id, item] of items) k.groups[id] = item
  return k
}

test('derived keys are pinned: changing a derivation would orphan every stored keyring', () => {
  const k = deriveKeys(PHRASE)
  assert.equal(b4a.toString(k.locator, 'hex'), '22847fdc0d0c52036a6d4cda43f0bda502c8173e87c3397370614bf8284d09f4')
  assert.equal(b4a.toString(k.topic, 'hex'), 'd61c6981d7742a53eebdc26f2acef917b4ff1a94c664f35856de028208cc92e4')
  assert.equal(b4a.toString(k.signKeyPair.publicKey, 'hex'), 'c73938e5212b583d3c2a668a43e2de76af515f07091656a15766cf9730cf002d')
  assert.equal(b4a.toString(k.boxKey, 'hex'), 'f0017003c45f9114c21f3faad1476f1a1486f3329c38d2c2cb1d51e777c23976')
})

test('every purpose gets its own key, all under pearcal/', () => {
  const k = deriveKeys(PHRASE)
  const all = [k.locator, k.topic, k.signKeyPair.publicKey, k.boxKey].map(b => b4a.toString(b, 'hex'))
  assert.equal(new Set(all).size, 4)
  for (const ns of Object.values(NS)) assert.ok(ns.startsWith('pearcal/'), ns)
})

test('the same words give the same keys however they are typed', () => {
  const a = deriveKeys(PHRASE)
  const b = deriveKeys('  ' + PHRASE.toUpperCase().replace(/ /g, '   ') + ' ')
  assert.ok(b4a.equals(a.locator, b.locator))
})

test('a phrase that is not valid is refused, never derived from', () => {
  assert.throws(() => deriveKeys(OTHER), /Not a valid recovery phrase/)
  assert.throws(() => deriveKeys(PHRASE.split(' ').slice(0, 11).join(' ')), /Not a valid recovery phrase/)
  assert.throws(() => deriveKeys(null), /Not a valid recovery phrase/)
})

test('seal then open gives the keyring back', () => {
  const keys = deriveKeys(PHRASE)
  const k = ring(['g1', { at: 5, entry: entryFromGroup(group('g1')) }])
  k.seeders[K('d')] = { at: 6 }
  assert.deepEqual(open(seal(k, keys, 1), keys), k)
})

test('the seeder accepts what we seal, and our claims', () => {
  const keys = deriveKeys(PHRASE)
  const rec = seal(empty(), keys, 3)
  assert.ok(checkSealed(rec))
  const sig = signClaim(keys.signKeyPair, rec.locator, K('e'), K('f'))
  assert.equal(checkClaim({ locator: rec.locator, sig }, rec.signKey, K('e'), K('f')), true)
  assert.equal(checkClaim({ locator: rec.locator, sig }, rec.signKey, K('e'), K('0')), false)
})

test("someone else's keyring, or a tampered one, does not open", () => {
  const keys = deriveKeys(PHRASE)
  const theirs = deriveKeys('legal winner thank year wave sausage worth useful legal winner thank yellow')
  const rec = seal(ring(['g1', { at: 1, entry: entryFromGroup(group('g1')) }]), keys, 1)
  assert.equal(open(rec, theirs), null)
  const flipped = b4a.from(rec.ciphertext, 'base64'); flipped[0] ^= 1
  assert.equal(open({ ...rec, ciphertext: b4a.toString(flipped, 'base64') }, keys), null)
  assert.equal(open({ ...rec, seq: rec.seq + 1 }, keys), null)
})

test('entryFromGroup keeps what a rejoin needs and nothing else', () => {
  const e = entryFromGroup({ ...group('g1'), members: [{ id: 'x' }], secret: 'no' })
  assert.deepEqual(Object.keys(e).sort(), ['encrypted', 'encryptionKey', 'groupId', 'groupKey', 'name', 'ownerId'])
  assert.equal(e.encrypted, true)
  assert.equal(entryFromGroup({ ...group('g2'), encryptionKey: undefined }).encrypted, false)
  assert.equal(entryFromGroup({ ...group('g3'), encryptionKey: undefined, encrypted: true }).encrypted, true)
  assert.equal(entryFromGroup({ ...group('g4'), groupKey: undefined }), null)
  assert.equal(entryFromGroup({ ...group('g5'), encryptionKey: 'short' }), null)
})

test('clean drops malformed calendars and seeders', () => {
  const k = clean({
    v: 1,
    groups: {
      g1: { at: 1, entry: entryFromGroup(group('g1')) },
      'bad id!': { at: 1, entry: entryFromGroup(group('g2')) },
      g3: { at: 1, entry: entryFromGroup(group('g9')) },
      g4: { at: -1, entry: entryFromGroup(group('g4')) },
      g5: { at: 1, removed: true },
      g6: { at: 1, entry: { ...entryFromGroup(group('g6')), groupKey: 'nope' } },
    },
    seeders: { [K('d')]: { at: 1 }, nothex: { at: 1 } },
  })
  assert.deepEqual(Object.keys(k.groups).sort(), ['g1', 'g5'])
  assert.deepEqual(Object.keys(k.seeders), [K('d')])
  assert.deepEqual(clean({ v: 2, groups: { g1: {} } }), empty())
})

test('clean caps how many calendars one keyring can carry', () => {
  const many = { v: 1, groups: {}, seeders: {} }
  for (let i = 0; i < MAX_GROUPS + 50; i++) many.groups['g' + i] = { at: 1, entry: entryFromGroup(group('g' + i)) }
  assert.equal(Object.keys(clean(many).groups).length, MAX_GROUPS)
})

test('merge keeps the later version of each calendar', () => {
  const a = ring(['g1', { at: 1, entry: entryFromGroup(group('g1', { name: 'old' })) }])
  const b = ring(['g1', { at: 2, entry: entryFromGroup(group('g1', { name: 'new' })) }], ['g2', { at: 1, entry: entryFromGroup(group('g2')) }])
  const m = merge(a, b, NOW)
  assert.equal(m.groups.g1.entry.name, 'new')
  assert.deepEqual(groups(m).map(e => e.groupId).sort(), ['g1', 'g2'])
  assert.deepEqual(merge(b, a, NOW), m)
})

test('a left calendar stays left against an older copy', () => {
  const left = ring(['g1', { at: NOW - 1000, removed: true }])
  const stale = ring(['g1', { at: NOW - 5000, entry: entryFromGroup(group('g1')) }])
  assert.deepEqual(groups(merge(stale, left, NOW)), [])
  assert.deepEqual(groups(merge(left, stale, NOW)), [])
})

test('rejoining after leaving wins over the removal', () => {
  const left = ring(['g1', { at: NOW - 5000, removed: true }])
  const back = ring(['g1', { at: NOW - 1000, entry: entryFromGroup(group('g1')) }])
  assert.equal(groups(merge(left, back, NOW)).length, 1)
})

test('removals are forgotten after 30 days', () => {
  const left = ring(['g1', { at: NOW - TOMBSTONE_MS - 1, removed: true }])
  assert.deepEqual(merge(left, empty(), NOW).groups, {})
})

test('a tie is settled the same way whatever the order', () => {
  const at = NOW - 1000
  const x = ring(['g1', { at, entry: entryFromGroup(group('g1', { name: 'x' })) }])
  const y = ring(['g1', { at, entry: entryFromGroup(group('g1', { name: 'y' })) }])
  const z = ring(['g1', { at, removed: true }])
  assert.deepEqual(merge(x, y, NOW), merge(y, x, NOW))
  assert.deepEqual(merge(x, z, NOW).groups.g1, { at, removed: true })
  assert.deepEqual(merge(z, x, NOW).groups.g1, { at, removed: true })
})

test('seeders merge the same way', () => {
  const a = empty(); a.seeders[K('d')] = { at: 1 }
  const b = empty(); b.seeders[K('d')] = { at: 2, removed: true }; b.seeders[K('e')] = { at: 1 }
  assert.deepEqual(seeders(merge(a, b, NOW)), [K('e')])
})
