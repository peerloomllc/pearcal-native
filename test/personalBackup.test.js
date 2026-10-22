const test = require('node:test')
const assert = require('node:assert')
const { createPersonalBackup, fetchPersonal } = require('../src/lib/personalBackup.js')
const { deriveKeys } = require('../src/lib/keyring.js')
const { checkSealed } = require('../src/peerloom-seeder/keyringRecord.js')

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const ev = (id, updatedAt, title = 'T ' + id) => ({ id, date: '2026-11-0' + (1 + (id.length % 8)), title, updatedAt })

// The rules peerloom-seeder's putKeyring applies.
function fakeSeeder () {
  const held = new Map()
  return {
    held,
    get: async (locator) => held.get(locator) || null,
    put: async (rec) => {
      if (!checkSealed(rec)) throw new Error('does not check out')
      const have = held.get(rec.locator)
      if (have && have.signKey !== rec.signKey) throw new Error('belongs to someone else')
      if (have && rec.seq <= have.seq) throw new Error('A newer file list is already here')
      held.set(rec.locator, rec)
    },
  }
}

function device (seeder, data) {
  const db = new Map()
  const b = createPersonalBackup({
    getMnemonic: async () => PHRASE,
    snapshot: async () => ({ v: 1, events: { ...data.events }, notes: { ...data.notes }, reminders: {}, deleted: { ...data.deleted } }),
    listSeeders: async () => ['s1'],
    keyringGet: async (s, locator) => seeder.get(locator),
    keyringPut: async (s, rec) => seeder.put(rec),
    store: { get: async (k) => db.get(k), put: async (k, v) => { db.set(k, v) } },
  })
  return { b, db, data }
}

test('writes once, skips when nothing changed, writes again after a change', async () => {
  const seeder = fakeSeeder()
  const d = device(seeder, { events: { e1: ev('e1', 1) }, notes: {}, deleted: {} })
  assert.strictEqual((await d.b.run()).written, true)
  assert.strictEqual((await d.b.run()).written, false)
  d.data.events.e2 = ev('e2', 2)
  const r = await d.b.run()
  assert.strictEqual(r.written, true)
  assert.strictEqual(r.seq, 2)
  const back = await fetchPersonal(['s1'], deriveKeys(PHRASE), async (s, l) => seeder.get(l))
  assert.deepStrictEqual(Object.keys(back.snapshot.events).sort(), ['e1', 'e2'])
  assert.strictEqual((await d.b.status()).events, 2)
})

test('two linked devices writing in turn both end up in the seeder copy, deletions included', async () => {
  const seeder = fakeSeeder()
  const a = device(seeder, { events: { shared: ev('shared', 1), onlyA: ev('onlyA', 1) }, notes: { shared: { text: 'a', updatedAt: 1 } }, deleted: {} })
  const b = device(seeder, { events: { shared: ev('shared', 5, 'edited on B'), onlyB: ev('onlyB', 1) }, notes: {}, deleted: { onlyA: Date.now() } })
  await a.b.run()
  await b.b.run()
  const back = await fetchPersonal(['s1'], deriveKeys(PHRASE), async (s, l) => seeder.get(l))
  assert.deepStrictEqual(Object.keys(back.snapshot.events).sort(), ['onlyB', 'shared'])
  assert.strictEqual(back.snapshot.events.shared.title, 'edited on B')
  assert.strictEqual(back.snapshot.notes.shared.text, 'a')
  assert.strictEqual(back.seq, 2)
})

test('the personal copy and the calendar list live at different addresses on the seeder', async () => {
  const seeder = fakeSeeder()
  await device(seeder, { events: { e1: ev('e1', 1) }, notes: {}, deleted: {} }).b.run()
  const k = deriveKeys(PHRASE)
  assert.ok(seeder.held.has(k.personalLocator.toString('hex')))
  assert.ok(!seeder.held.has(k.locator.toString('hex')))
})
