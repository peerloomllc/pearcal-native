const test = require('node:test')
const assert = require('node:assert')
const { deriveKeys, seal: sealList, open: openList, empty: emptyList } = require('../src/lib/keyring.js')
const { empty, clean, merge, seal, open } = require('../src/lib/personalKeyring.js')

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const OTHER = 'legal winner thank year wave sausage worth useful legal winner thank yellow'
const ev = (id, date, updatedAt, extra = {}) => ({ id, date, title: 'T ' + id, updatedAt, ...extra })

test('the personal address differs from the calendar list address, and neither opens the other', () => {
  const k = deriveKeys(PHRASE)
  assert.ok(!k.personalLocator.equals(k.locator))
  const p = empty(); p.events.e1 = ev('e1', '2026-11-01', 1)
  const { rec } = seal(p, k, 1)
  assert.deepStrictEqual(open(rec, k).events.e1, p.events.e1)
  assert.strictEqual(openList(rec, k), null, 'a personal version is not a calendar list')
  assert.strictEqual(open(sealList(emptyList(), k, 1), k), null, 'a calendar list is not a personal version')
  assert.strictEqual(open(rec, deriveKeys(OTHER)), null)
})

test('clean drops group events, bad dates, empty notes and malformed rows', () => {
  const c = clean({ v: 1,
    events: { a: ev('a', '2026-01-01', 1), b: ev('b', '2026-01-01', 1, { groups: ['g1'] }), c: ev('c', 'soon', 1), d: ev('x', '2026-01-01', 1), 'e1_r3': ev('e1_r3', '2026-01-02', 1) },
    notes: { a: { text: 'hi', updatedAt: 2 }, b: { text: '' }, c: 'nope' },
    reminders: { a: [{ minutes: 15 }], b: 'x' },
    deleted: { z: 5, y: 'no' } })
  assert.deepStrictEqual(Object.keys(c.events).sort(), ['a', 'e1_r3'])
  assert.deepStrictEqual(Object.keys(c.notes), ['a'])
  assert.deepStrictEqual(Object.keys(c.reminders), ['a'])
  assert.deepStrictEqual(c.deleted, { z: 5 })
})

test('merge keeps the later event and note, honours deletions, and prefers its own reminders', () => {
  const now = 1000
  const mine = { v: 1, events: { a: ev('a', '2026-01-01', 10), gone: ev('gone', '2026-01-01', 5) }, notes: { a: { text: 'mine', updatedAt: 3 } }, reminders: { a: [1] }, deleted: { b: 20 } }
  const theirs = { v: 1, events: { a: ev('a', '2026-01-01', 7, { title: 'old' }), b: ev('b', '2026-01-01', 15), c: ev('c', '2026-01-02', 1) }, notes: { a: { text: 'theirs', updatedAt: 9 } }, reminders: { a: [2], c: [3] }, deleted: { gone: 6 } }
  const m = merge(mine, theirs, now)
  assert.strictEqual(m.events.a.title, 'T a', 'later updatedAt wins')
  assert.ok(!m.events.b, 'deleted after its last change')
  assert.ok(!m.events.gone, 'deleted on the other device after its last change')
  assert.ok(m.events.c)
  assert.strictEqual(m.notes.a.text, 'theirs')
  assert.deepStrictEqual(m.reminders, { a: [1], c: [3] })
})

test('a deletion older than 30 days is dropped, and an event changed after a deletion stays', () => {
  const day = 24 * 60 * 60 * 1000
  const now = 100 * day
  const m = merge({ v: 1, events: { a: ev('a', '2026-01-01', 90 * day) }, deleted: { a: 80 * day, old: 10 * day } }, empty(), now)
  assert.ok(m.events.a)
  assert.deepStrictEqual(Object.keys(m.deleted), ['a'])
})

test('too large: past events go first, oldest first, until it fits', () => {
  const k = deriveKeys(PHRASE)
  const p = empty()
  const pad = 'x'.repeat(15000)
  for (let i = 0; i < 90; i++) {
    const d = '2025-' + String(1 + (i % 12)).padStart(2, '0') + '-' + String(1 + (i % 28)).padStart(2, '0')
    p.events['p' + i] = ev('p' + i, d, 1, { notes: pad })
  }
  p.events.future = ev('future', '2027-01-01', 1, { notes: pad })
  const { rec, dropped } = seal(p, k, 1, { today: '2026-10-22' })
  const back = open(rec, k)
  assert.ok(dropped > 0)
  assert.ok(back.events.future, 'a future event is kept')
  const kept = Object.values(back.events).filter((e) => e.id !== 'future').map((e) => e.date).sort()
  const all = Object.values(p.events).filter((e) => e.id !== 'future').map((e) => e.date).sort()
  assert.ok(kept[0] >= all[dropped - 1], 'the oldest went first')
})
