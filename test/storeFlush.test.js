// Unit tests for the store flusher/compactor contract (src/lib/storeFlush.js).
// The RocksDB handle is faked; we exercise the coalesce / read-only /
// error-swallow behavior, not real disk I/O.
const test = require('brittle')
const { createStoreFlusher, createStoreCompactor } = require('../src/lib/storeFlush')

function fakeStore ({ readOnly = false, flush, compactRange } = {}) {
  return { storage: { readOnly, db: { flush, compactRange } } }
}

test('flusher: no store yet -> false', async (t) => {
  const flushStore = createStoreFlusher({ getStore: () => null })
  t.is(await flushStore('boot'), false)
})

test('flusher: read-only (seed) store is never flushed', async (t) => {
  let called = 0
  const store = fakeStore({ readOnly: true, flush: async () => { called++ } })
  const flushStore = createStoreFlusher({ getStore: () => store })
  t.is(await flushStore('r'), false)
  t.is(called, 0)
})

test('flusher: happy path flushes and marks', async (t) => {
  let marks = 0
  const store = fakeStore({ flush: async () => {} })
  const flushStore = createStoreFlusher({ getStore: () => store, mark: () => { marks++ } })
  t.is(await flushStore('interval'), true)
  t.is(marks, 1)
})

test('flusher: coalesces a concurrent flush', async (t) => {
  let flushCalls = 0
  let release
  const store = fakeStore({ flush: () => { flushCalls++; return new Promise((r) => { release = r }) } })
  const flushStore = createStoreFlusher({ getStore: () => store })
  const p1 = flushStore('a')
  const p2 = flushStore('b') // in-flight -> coalesced
  t.is(await p2, false, 'second concurrent flush is skipped')
  t.is(flushCalls, 1, 'db.flush called once')
  release()
  t.is(await p1, true)
})

test('flusher: swallows a flush error and warns', async (t) => {
  let warned = 0
  const store = fakeStore({ flush: async () => { throw new Error('disk full') } })
  const flushStore = createStoreFlusher({ getStore: () => store, warn: () => { warned++ } })
  t.is(await flushStore('x'), false)
  t.is(warned, 1)
})

test('compactor: flushes then compacts, marks on success', async (t) => {
  let flushed = 0; let compacted = 0; let marks = 0
  const store = fakeStore({ flush: async () => { flushed++ }, compactRange: async () => { compacted++ } })
  const compactStore = createStoreCompactor({ getStore: () => store, mark: () => { marks++ } })
  t.is(await compactStore('sweep'), true)
  t.is(flushed, 1)
  t.is(compacted, 1)
  t.is(marks, 1)
})

test('compactor: read-only store is skipped', async (t) => {
  const store = fakeStore({ readOnly: true, flush: async () => {}, compactRange: async () => {} })
  const compactStore = createStoreCompactor({ getStore: () => store })
  t.is(await compactStore('r'), false)
})
