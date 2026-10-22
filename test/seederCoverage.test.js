const test = require('node:test')
const assert = require('node:assert')
const { writerHeld, groupCoverage, summarise } = require('../src/lib/seederCoverage.js')

test('a writer is held when the seeder has at least what this device has', () => {
  assert.strictEqual(writerHeld({ localLength: 25, seederContiguous: 25 }), 'held')
  assert.strictEqual(writerHeld({ localLength: 25, seederContiguous: 30 }), 'held')
  assert.strictEqual(writerHeld({ localLength: 25, seederContiguous: 0 }), 'missing', 'the Seeder test case from #180')
  assert.strictEqual(writerHeld({ localLength: 21, seederContiguous: null }), 'missing', 'the seeder never opened the core')
  assert.strictEqual(writerHeld({ localLength: 0, seederContiguous: null }), 'unknown')
})

test('a calendar is complete only with nothing missing and something held', () => {
  assert.deepStrictEqual(groupCoverage([{ localLength: 70, seederContiguous: 70 }, { localLength: 41, seederContiguous: 41 }]), { complete: true, missing: 0 })
  assert.deepStrictEqual(groupCoverage([{ localLength: 70, seederContiguous: 70 }, { localLength: 21, seederContiguous: null }]), { complete: false, missing: 1 })
  assert.deepStrictEqual(groupCoverage([{ localLength: 0, seederContiguous: null }]), { complete: false, missing: 0 })
  assert.deepStrictEqual(groupCoverage([]), { complete: false, missing: 0 })
})

test('the summary counts calendars fully on any paired seeder, and names the rest', () => {
  const groups = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }, { id: 'd', name: 'D' }]
  const records = {
    a: { s1: { complete: true } },
    b: { s1: { complete: false }, s2: { complete: true } },
    c: { s1: { complete: false } },
    d: { old: { complete: true } }, // a seeder no longer paired does not count
  }
  assert.deepStrictEqual(summarise(groups, records, ['s1', 's2']), { total: 4, complete: 2, incomplete: ['C'], checking: ['D'] })
})
