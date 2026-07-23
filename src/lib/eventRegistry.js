// TODO #126 - the RN shell's IPC event-handler registry.
//
// The shell registers its complete set of bare-event handlers inside a memoized
// worklet bring-up body (`makeStartLock`, see backendBootstrap.js). That body is
// re-entered on a COLD reopen, because the Activity teardown nulls the memo so a
// later mount can start a fresh worklet.
//
// The registry itself is module-level and outlives any single mount, so the two
// lifetimes do not match: the memo resets, the handler map does not. Every cold
// re-entry therefore appended a SECOND, third, Nth copy of every handler, and
// dispatch fires all of them. One `syncNotify` from bare became N identical
// notifications at the same instant, N morning digests, N reconciles.
//
// It needs the JS context to survive the Activity teardown, which is exactly the
// warm-process case: a device that keeps the process alive (foreground service
// on GrapheneOS) remounts into surviving module state. A device that reaps the
// process rebuilds everything and never sees it.
//
// The fix is to make registration idempotent by construction rather than to
// pair it with a teardown that may not run: the bring-up body calls reset()
// before registering, so whatever path got us there, exactly one copy survives.
// Split out here so it is unit-testable (app/index.tsx cannot be required from
// tests). Same split as ownerGuard.js / groupRecord.js / backendBootstrap.js.

'use strict'

function createEventRegistry () {
  const handlers = new Map()

  return {
    // Register a handler for a bare event name. Multiple DISTINCT handlers for
    // one event are legitimate; what is never legitimate is the same bring-up
    // body registering its set twice, which is what reset() below prevents.
    on (event, fn) {
      const list = handlers.get(event) ?? []
      list.push(fn)
      handlers.set(event, list)
    },

    // Drop every handler. Called at the top of the bring-up body, so a cold
    // re-entry replaces the previous set instead of stacking on top of it.
    reset () {
      handlers.clear()
    },

    // Fan an incoming bare event out to its handlers. A throwing handler must
    // not stop the others: they are independent subscribers, and losing the
    // rest of the chain to one bad listener is how a single failure becomes a
    // silent partial outage.
    dispatch (event, data) {
      const list = handlers.get(event)
      if (!list) return 0
      for (const fn of list) {
        try { fn(data) } catch (e) { /* one listener must not break the rest */ }
      }
      return list.length
    },

    // Test/diagnostic surface.
    count (event) {
      return (handlers.get(event) ?? []).length
    },
  }
}

module.exports = { createEventRegistry }
