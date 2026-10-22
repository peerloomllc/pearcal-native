const test = require('node:test')
const assert = require('node:assert')
const { createKeyringSync } = require('../src/lib/keyringSync.js')
const { deriveKeys, open, groups, seeders } = require('../src/lib/keyring.js')
const { checkSealed } = require('../src/peerloom-seeder/keyringRecord.js')

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const OTHER = 'legal winner thank year wave sausage worth useful legal winner thank yellow'
const K = c => c.repeat(64)
const entry = (id, name = 'Cal ' + id) => ({ groupId: id, name, groupKey: K('a'), encrypted: true, encryptionKey: K('b'), ownerId: 'c'.repeat(32) })

// The rules peerloom-seeder's putKeyring applies, with its wording.
function fakeSeeder () {
  const held = new Map()
  return {
    held,
    get: async (locator) => held.get(locator) || null,
    put: async (rec) => {
      if (!checkSealed(rec)) throw new Error('This file list does not check out')
      const have = held.get(rec.locator)
      if (have && have.signKey !== rec.signKey) throw new Error('This file list belongs to someone else')
      if (have && rec.seq <= have.seq) throw new Error('A newer file list is already here')
      held.set(rec.locator, rec)
    },
  }
}

function device ({ seederMap, phrase = PHRASE, entries = [], gone = new Set(), paired = [...seederMap.keys()] }) {
  const db = new Map()
  const d = {
    entries, gone, paired, db,
    sync: createKeyringSync({
      getMnemonic: async () => d.phrase,
      listGroups: async () => d.entries,
      isGone: async (id) => d.gone.has(id),
      listSeeders: async () => d.paired,
      keyringGet: (s, locator) => seederMap.get(s).get(locator),
      keyringPut: (s, rec) => seederMap.get(s).put(rec),
      store: { get: async (k) => db.get(k), put: async (k, v) => { db.set(k, v) } },
    }),
    phrase,
  }
  return d
}
const keys = deriveKeys(PHRASE)
const stored = (seeder) => open(seeder.held.get(keys.locator.toString('hex')), keys)

test('no paired seeder: nothing is written', async () => {
  const d = device({ seederMap: new Map(), entries: [entry('g1')] })
  assert.deepEqual(await d.sync.run(), { written: false })
})

test('writes the calendars and the paired seeders, sealed so only the words open it', async () => {
  const s = fakeSeeder()
  const d = device({ seederMap: new Map([[K('d'), s]]), entries: [entry('g1'), entry('g2')] })
  const r = await d.sync.run()
  assert.equal(r.written, true)
  assert.deepEqual(r.held, [K('d')])
  const k = stored(s)
  assert.deepEqual(groups(k).map(e => e.groupId).sort(), ['g1', 'g2'])
  assert.deepEqual(seeders(k), [K('d')])
  assert.equal(open(s.held.get(keys.locator.toString('hex')), deriveKeys(OTHER)), null)
})

test('nothing changed: no write; forced: a write with the next seq', async () => {
  const s = fakeSeeder()
  const d = device({ seederMap: new Map([[K('d'), s]]), entries: [entry('g1')] })
  assert.equal((await d.sync.run()).seq, 1)
  assert.deepEqual(await d.sync.run(), { written: false })
  assert.equal((await d.sync.run({ force: true })).seq, 2)
})

test('a renamed calendar is written again', async () => {
  const s = fakeSeeder()
  const d = device({ seederMap: new Map([[K('d'), s]]), entries: [entry('g1', 'Old')] })
  await d.sync.run()
  d.entries = [entry('g1', 'New')]
  assert.equal((await d.sync.run()).written, true)
  assert.equal(groups(stored(s))[0].name, 'New')
})

test('two linked devices end up in one merged keyring', async () => {
  const s = fakeSeeder()
  const m = new Map([[K('d'), s]])
  const phone = device({ seederMap: m, entries: [entry('g1')] })
  const desk = device({ seederMap: m, entries: [entry('g2')] })
  await phone.sync.run()
  await desk.sync.run()
  assert.deepEqual(groups(stored(s)).map(e => e.groupId).sort(), ['g1', 'g2'])
  // The phone, behind the desk's seq, merges and writes past it.
  phone.entries = [entry('g1'), entry('g3')]
  const r = await phone.sync.run()
  assert.equal(r.seq, 3)
  assert.deepEqual(groups(stored(s)).map(e => e.groupId).sort(), ['g1', 'g2', 'g3'])
})

test('a calendar left here is marked removed; a linked device\'s is kept', async () => {
  const s = fakeSeeder()
  const m = new Map([[K('d'), s]])
  const phone = device({ seederMap: m, entries: [entry('g1'), entry('g2')] })
  const desk = device({ seederMap: m, entries: [entry('g9')] })
  await phone.sync.run()
  await desk.sync.run()
  phone.entries = [entry('g2')]
  phone.gone.add('g1')
  await phone.sync.run()
  assert.deepEqual(groups(stored(s)).map(e => e.groupId).sort(), ['g2', 'g9'])
})

test('a seeder that has a newer version: merged in on the next run', async () => {
  const s = fakeSeeder()
  const m = new Map([[K('d'), s]])
  const phone = device({ seederMap: m, entries: [entry('g1')] })
  const desk = device({ seederMap: m, entries: [entry('g2')] })
  await phone.sync.run()
  await desk.sync.run({ force: true })
  await desk.sync.run({ force: true })
  // The phone's last seen seq is 1, the seeder holds 3: the phone fetches it
  // first, so its put is 4 and nothing is lost.
  phone.entries = [entry('g1'), entry('g5')]
  assert.equal((await phone.sync.run()).seq, 4)
  assert.deepEqual(groups(stored(s)).map(e => e.groupId).sort(), ['g1', 'g2', 'g5'])
})

test('one seeder refusing does not stop the others', async () => {
  const good = fakeSeeder()
  const bad = { get: async () => null, put: async () => { throw new Error('This device has backed up too many file lists here') } }
  const d = device({ seederMap: new Map([[K('d'), good], [K('e'), bad]]), entries: [entry('g1')] })
  const r = await d.sync.run()
  assert.deepEqual(r.held, [K('d')])
  assert.deepEqual(await d.sync.status(), { seeders: 1, paired: 2, at: d.db.get('keyring:local').at })
})

test('restoring another identity onto the device starts a fresh keyring', async () => {
  const s = fakeSeeder()
  const d = device({ seederMap: new Map([[K('d'), s]]), entries: [entry('g1')] })
  await d.sync.run()
  d.phrase = OTHER
  d.entries = [entry('g7')]
  await d.sync.run()
  const other = deriveKeys(OTHER)
  const theirs = open(s.held.get(other.locator.toString('hex')), other)
  assert.deepEqual(groups(theirs).map(e => e.groupId), ['g7'])
})

test('status counts only seeders still paired', async () => {
  const s1 = fakeSeeder(); const s2 = fakeSeeder()
  const d = device({ seederMap: new Map([[K('d'), s1], [K('e'), s2]]), entries: [entry('g1')] })
  await d.sync.run()
  d.paired = [K('d')]
  assert.equal((await d.sync.status()).seeders, 1)
  assert.equal((await d.sync.status()).paired, 1)
})

test('a change in the same millisecond as the last write still wins', async () => {
  const s = fakeSeeder()
  const db = new Map()
  const d = { entries: [entry('g1', 'Old')] }
  const sync = createKeyringSync({
    getMnemonic: async () => PHRASE,
    listGroups: async () => d.entries,
    isGone: async () => false,
    listSeeders: async () => [K('d')],
    keyringGet: (k, locator) => s.get(locator),
    keyringPut: (k, rec) => s.put(rec),
    store: { get: async (k) => db.get(k), put: async (k, v) => { db.set(k, v) } },
    now: () => 1_800_000_000_000, // a frozen clock
  })
  await sync.run()
  d.entries = [entry('g1', 'New')]
  await sync.run()
  assert.equal(groups(stored(s))[0].name, 'New')
})
