// Bound the rocksdb-native write-ahead log by flushing the corestore memtable
// to an on-disk SST on demand. Ported from PearCircle src/lib/storeFlush.js,
// pending PearCal wiring.
//
// The backend only auto-flushes when the 64 MB write buffer fills or on a
// clean close; a force-killed app rarely closes cleanly, so a busy device's
// first-ever flush is the giant 64 MB one whose cold-start replay trips
// Android's ANR watchdog and wedges the app. Flushing on a cadence keeps the
// WAL small.
//
// Factored out of bare.js so the coalesce / read-only / error-swallow contract
// is unit-testable without standing up the whole worklet. `getStore` is a
// thunk returning the live Corestore (or null before init) so the flusher
// never closes over a stale reference.
function createStoreFlusher ({ getStore, mark, warn } = {}) {
  let flushing = false

  return async function flushStore (reason) {
    const store = typeof getStore === 'function' ? getStore() : null
    const db = store && store.storage && store.storage.db
    // No store yet, or a read-only (seed-replica) store: nothing to flush.
    if (!db || store.storage.readOnly) return false
    // Coalesce: a flush is already in flight. RocksDB rolls the memtable on
    // flush, so the in-flight one already captures everything committed; a
    // second concurrent flush would be redundant work.
    if (flushing) return false
    flushing = true
    try {
      await db.flush()
      if (typeof mark === 'function') mark('store:flush', { reason })
      return true
    } catch (e) {
      if (typeof warn === 'function') warn('[bare] store flush failed', reason, e && e.message)
      return false
    } finally {
      flushing = false
    }
  }
}

// Reclaim dead on-disk SST by forcing a full-keyspace RocksDB compaction.
// Flushing (above) rolls the memtable to SST and truncates the WAL, but it
// never reclaims space from keys that were overwritten or deleted -- the
// superseded SST blocks linger until RocksDB happens to run a background
// compaction, which it may defer indefinitely on a mostly-idle app. After a
// big delete pass (event/reminder deletes, group purges) or a long run of
// overwrites, that dead SST is the bulk of the on-disk footprint.
// compactRange(null, null) compacts the whole keyspace, dropping tombstoned +
// superseded blocks for real.
//
// Heavier than a flush (it rewrites SST files), so callers schedule it off the
// cold-start path and on a slow cadence, never per-write. We flush first so any
// just-deleted keys are on disk as SST and actually get compacted away. Same
// coalesce / read-only / error-swallow contract as the flusher.
function createStoreCompactor ({ getStore, mark, warn } = {}) {
  let compacting = false

  return async function compactStore (reason) {
    const store = typeof getStore === 'function' ? getStore() : null
    const db = store && store.storage && store.storage.db
    // No store yet, or a read-only (seed-replica) store: nothing to compact.
    if (!db || store.storage.readOnly) return false
    if (compacting) return false
    compacting = true
    try {
      try { await db.flush() } catch {}
      await db.compactRange()
      if (typeof mark === 'function') mark('store:compact', { reason })
      return true
    } catch (e) {
      if (typeof warn === 'function') warn('[bare] store compact failed', reason, e && e.message)
      return false
    } finally {
      compacting = false
    }
  }
}

module.exports = { createStoreFlusher, createStoreCompactor }
