// Unit tests for the store flusher/compactor contract (src/lib/storeFlush.js).
// The RocksDB handle is faked; we exercise the coalesce / read-only /
// error-swallow behavior, not real disk I/O.
const test = require('node:test')
const assert = require('node:assert/strict')
const { createStoreFlusher, createStoreCompactor } = require('../src/lib/storeFlush')

function fakeStore ({ readOnly = false, flush, compactRange } = {}) {
  return { storage: { readOnly, db: { flush, compactRange } } }
}

test('flusher: no store yet -> false', async () => {
  const flushStore = createStoreFlusher({ getStore: () => null })
  assert.equal(await flushStore('boot'), false)
})

test('flusher: read-only (seed) store is never flushed', async () => {
  let called = 0
  const store = fakeStore({ readOnly: true, flush: async () => { called++ } })
  const flushStore = createStoreFlusher({ getStore: () => store })
  assert.equal(await flushStore('r'), false)
  assert.equal(called, 0)
})

test('flusher: happy path flushes and marks', async () => {
  let marks = 0
  const store = fakeStore({ flush: async () => {} })
  const flushStore = createStoreFlusher({ getStore: () => store, mark: () => { marks++ } })
  assert.equal(await flushStore('interval'), true)
  assert.equal(marks, 1)
})

test('flusher: coalesces a concurrent flush', async () => {
  let flushCalls = 0
  let release
  const store = fakeStore({ flush: () => { flushCalls++; return new Promise((r) => { release = r }) } })
  const flushStore = createStoreFlusher({ getStore: () => store })
  const p1 = flushStore('a')
  const p2 = flushStore('b') // in-flight -> coalesced
  assert.equal(await p2, false, 'second concurrent flush is skipped')
  assert.equal(flushCalls, 1, 'db.flush called once')
  release()
  assert.equal(await p1, true)
})

test('flusher: swallows a flush error and warns', async () => {
  let warned = 0
  const store = fakeStore({ flush: async () => { throw new Error('disk full') } })
  const flushStore = createStoreFlusher({ getStore: () => store, warn: () => { warned++ } })
  assert.equal(await flushStore('x'), false)
  assert.equal(warned, 1)
})

test('compactor: flushes then compacts, marks on success', async () => {
  let flushed = 0; let compacted = 0; let marks = 0
  const store = fakeStore({ flush: async () => { flushed++ }, compactRange: async () => { compacted++ } })
  const compactStore = createStoreCompactor({ getStore: () => store, mark: () => { marks++ } })
  assert.equal(await compactStore('sweep'), true)
  assert.equal(flushed, 1)
  assert.equal(compacted, 1)
  assert.equal(marks, 1)
})

test('compactor: read-only store is skipped', async () => {
  const store = fakeStore({ readOnly: true, flush: async () => {}, compactRange: async () => {} })
  const compactStore = createStoreCompactor({ getStore: () => store })
  assert.equal(await compactStore('r'), false)
})
