// Process-level helpers for the shared backend bring-up that resumes the P2P
// worklet after a reboot or an in-place app update without an Activity. Ported
// from PearCircle src/lib/backendBootstrap.js, pending PearCal wiring.
//
// Kept as a small pure module so the single-writer-critical start lock and the
// autostart-gate decision are unit-testable without pulling React Native into
// node-jest. app/index.tsx builds ensureBackendStarted() on top of
// makeStartLock and (where an autostart gate exists) mirrors state via
// autostartGateValue.

// Memoize an async bring-up so it runs at most once per process and every
// caller awaits the same promise. This is the load-bearing single-writer
// guard: a near-simultaneous Activity mount and headless boot task must not
// both pass the worklet's _workletStarted check and open the Autobase writer
// core twice (which corrupts the local view). The first caller starts the
// work; concurrent and later callers get the same in-flight (or settled)
// promise, so startFn's body runs exactly once.
//
// A rejected start is intentionally NOT cached: if the first attempt throws
// (e.g. bundle load failed), the next call re-runs startFn so a transient
// failure isn't permanent. A resolved start stays cached forever (the backend
// is up; re-calling is a no-op).
function makeStartLock (startFn) {
  let inFlight = null
  let done = false
  let value
  return function ensureStarted () {
    if (done) return Promise.resolve(value)
    if (inFlight) return inFlight
    inFlight = (async () => startFn())()
      .then((v) => { done = true; value = v; inFlight = null; return v })
      .catch((e) => { inFlight = null; throw e })
    return inFlight
  }
}

// Decide what to write into a native autostart gate from a worklet
// state payload. Returns { write, value }: write=false means the payload
// didn't carry a usable boolean, so leave the gate untouched rather than
// clobbering it with a guess. When write=true, value is the boolean to mirror.
function autostartGateValue (data, field) {
  const v = data == null ? undefined : data[field]
  if (typeof v !== 'boolean') return { write: false, value: false }
  return { write: true, value: v }
}

module.exports = { makeStartLock, autostartGateValue }
