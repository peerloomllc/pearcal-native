// Stop a periodic async job from stacking on itself.
//
// setInterval fires on schedule whether or not the previous run finished, so a
// job whose body can outrun its own cadence gets a second copy layered on the
// first. Each overlap steals CPU from the run already in flight, which makes it
// slower, which produces more overlap. The result is a process pinned at ~100%
// user CPU doing the same work several times over.
//
// Factored out of bare.js for the same reason createStoreFlusher was: the
// coalesce contract is the whole point, and it is worth testing without
// standing up the entire worklet.
//
// The skip is DEADLINE-BOUNDED rather than absolute. A run that never settles
// (an update() awaiting a peer that went away) must not silence the job for the
// rest of the session - that trades a CPU pileup for a silent stall, which is
// the worse failure of the two because nothing looks wrong. Past `staleMs` the
// in-flight run is written off and a fresh one starts. A superseded run cannot
// clear the state of the run that replaced it.
//
// `now` is injectable so tests can drive the clock instead of sleeping.
function createCadenceGuard ({ run, staleMs, slowMs, label = 'tick', now = Date.now, warn } = {}) {
  let seq = 0
  let inflight = 0            // seq of the run in flight, 0 when idle
  let startedAt = 0
  let skips = 0

  const say = (...args) => { if (typeof warn === 'function') warn(...args) }

  // Returns the run's promise, or null when this call was skipped.
  return function guarded () {
    const started = now()
    if (inflight) {
      const elapsed = started - startedAt
      if (elapsed < staleMs) {
        skips++
        // Every fourth, so a slow patch is visible without flooding the log.
        if (skips % 4 === 1) say('[' + label + '] still running after', elapsed, 'ms, skipping (skips:', skips + ')')
        return null
      }
      say('[' + label + '] previous run wedged for', elapsed, 'ms, starting a fresh one')
    }

    const mine = ++seq
    inflight = mine
    startedAt = started

    // Started synchronously and deliberately: a cadence firing should begin its
    // work now, not a microtask later, and a body that throws synchronously has
    // to release the slot exactly like one that rejects.
    let settled
    try {
      settled = Promise.resolve(run())
    } catch (e) {
      settled = Promise.resolve()
    }

    return settled
      .catch(() => {})
      .then(() => {
        const ms = now() - started
        if (inflight === mine) {
          inflight = 0
          skips = 0
        }
        if (slowMs && ms > slowMs) say('[' + label + '] slow run:', ms, 'ms')
      })
  }
}

module.exports = { createCadenceGuard }
