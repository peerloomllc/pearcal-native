const test = require('node:test')
const assert = require('node:assert')
const b4a = require('b4a')
const { createRestoring } = require('../src/lib/restoring.js')
const { deriveKeys, seal, empty, merge } = require('../src/lib/keyring.js')
const { checkClaim } = require('../src/peerloom-seeder/keyringRecord.js')

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const OTHER = 'legal winner thank year wave sausage worth useful legal winner thank yellow'
const K = c => c.repeat(64)
const entry = (id) => ({ groupId: id, name: 'Cal ' + id, groupKey: K('a'), encrypted: true, encryptionKey: K('b'), ownerId: 'c'.repeat(32) })
const S1 = K('1')
const S2 = K('2')
const DEVICE = K('d')

function keyringWith (ids, seederKeys = []) {
  const k = empty()
  for (const id of ids) k.groups[id] = { at: 1, entry: entry(id) }
  for (const s of seederKeys) k.seeders[s] = { at: 1 }
  return k
}

function setup ({ held = {}, announcing = Object.keys(held), have = [], refuseClaim = [], restorePersonal = null } = {}) {
  const keys = deriveKeys(PHRASE)
  const db = new Map([['restore:pending', { at: 1 }]])
  const added = []
  const paired = []
  const claims = []
  const r = createRestoring({
    getMnemonic: async () => PHRASE,
    lookup: async (topic) => { assert.ok(b4a.equals(topic, keys.topic)); return announcing },
    keyringGet: async (s, locator) => {
      assert.strictEqual(locator, b4a.toString(keys.locator, 'hex'))
      return held[s] || null
    },
    keyringClaim: async (s, locator, sig) => {
      if (refuseClaim.includes(s)) throw new Error('This claim does not check out')
      claims.push({ s, ok: checkClaim({ locator, sig }, b4a.toString(keys.signKeyPair.publicKey, 'hex'), s, DEVICE) })
    },
    deviceKey: async () => DEVICE,
    addSeeder: async (s) => { paired.push(s) },
    haveGroup: async (id) => have.includes(id),
    addGroup: async (e, seederKeys) => { added.push({ id: e.groupId, seederKeys }) },
    restorePersonal,
    store: { get: async (k) => db.get(k), put: async (k, v) => { db.set(k, v) }, del: async (k) => { db.delete(k) } },
    lookMs: 300,
    settleMs: 20,
    retryMs: 50,
  })
  return { r, db, added, paired, claims, keys }
}

test('finds the list on two seeders, merges them, claims both and opens each calendar', async () => {
  const keys = deriveKeys(PHRASE)
  const { r, db, added, paired, claims } = setup({
    held: { [S1]: seal(keyringWith(['g1', 'g2']), keys, 3), [S2]: seal(keyringWith(['g2', 'g3'], [S2]), keys, 5) },
  })
  const out = await r.start()
  assert.deepStrictEqual(out, { calendars: 3, added: 3, seeders: 2, personal: 0 })
  assert.deepStrictEqual(added.map(a => a.id).sort(), ['g1', 'g2', 'g3'])
  assert.deepStrictEqual(paired.sort(), [S1, S2])
  assert.ok(claims.every(c => c.ok), 'every claim verifies against the sign key')
  assert.strictEqual(db.get('keyring:local').seq, 5)
  assert.strictEqual(db.has('restore:pending'), false)
  assert.strictEqual(db.get('restore:status').state, 'done')
})

test('a calendar already on the device is left alone', async () => {
  const keys = deriveKeys(PHRASE)
  const { r, added } = setup({ held: { [S1]: seal(keyringWith(['g1', 'g2']), keys, 1) }, have: ['g1'] })
  await r.start()
  assert.deepStrictEqual(added.map(a => a.id), ['g2'])
  assert.deepStrictEqual(added[0].seederKeys, [S1])
})

test("someone else's list is ignored, and nothing found ends as 'none'", async () => {
  const { r, db, added } = setup({ held: { [S1]: seal(keyringWith(['g1']), deriveKeys(OTHER), 1) } })
  const out = await r.start()
  assert.deepStrictEqual(out, { calendars: 0, seeders: 0 })
  assert.strictEqual(added.length, 0)
  assert.strictEqual(db.get('restore:status').state, 'none')
  assert.strictEqual(db.has('restore:pending'), false)
})

test('a seeder that refuses the claim is not paired, the calendars still open', async () => {
  const keys = deriveKeys(PHRASE)
  const { r, added, paired } = setup({ held: { [S1]: seal(keyringWith(['g1'], [S2]), keys, 1) }, announcing: [S1], refuseClaim: [S2] })
  const out = await r.start()
  assert.strictEqual(out.seeders, 1)
  assert.deepStrictEqual(paired, [S1])
  assert.deepStrictEqual(added[0].seederKeys, [S1])
})

test('does nothing without restore:pending', async () => {
  const { r, db, added } = setup({})
  db.delete('restore:pending')
  assert.strictEqual(await r.start(), null)
  assert.strictEqual(added.length, 0)
})

test('merge keeps a removal from one seeder over an older listing on another', async () => {
  const keys = deriveKeys(PHRASE)
  const gone = keyringWith([])
  gone.groups.g1 = { at: Date.now(), removed: true }
  const { r, added } = setup({ held: { [S1]: seal(keyringWith(['g1', 'g2']), keys, 1), [S2]: seal(merge(gone, empty()), keys, 2) } })
  await r.start()
  assert.deepStrictEqual(added.map(a => a.id), ['g2'])
})

test('personal data is restored from the same seeders, and a failure there does not stop the calendars', async () => {
  const keys = deriveKeys(PHRASE)
  const calls = []
  const { r, added, db } = setup({
    held: { [S1]: seal(keyringWith(['g1'], [S2]), keys, 1) },
    announcing: [S1],
    restorePersonal: async (k, seederKeys) => { calls.push({ ok: k.personalLocator.equals(keys.personalLocator), seederKeys }); return 7 },
  })
  const out = await r.start()
  assert.strictEqual(out.personal, 7)
  assert.deepStrictEqual(calls, [{ ok: true, seederKeys: [S1, S2] }])
  assert.strictEqual(db.get('restore:status').personal, 7)
  assert.deepStrictEqual(added.map(a => a.id), ['g1'])

  const bad = setup({ held: { [S1]: seal(keyringWith(['g1']), keys, 1) }, restorePersonal: async () => { throw new Error('boom') } })
  const out2 = await bad.r.start()
  assert.strictEqual(out2.personal, 0)
  assert.deepStrictEqual(bad.added.map(a => a.id), ['g1'])
})
