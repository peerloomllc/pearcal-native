// Append timeout helper. Ported from PearCircle src/lib/appendTimeout.js
// (proposal 2026-06-03-autobase-append-hang), pending PearCal wiring.
//
// On-device, a corrupt local Autobase writer core left `base.append()`
// hanging forever in the advance/apply loop. Because the worklet's IPC
// dispatcher awaits each handler serially, that single stuck append froze
// the entire backend: the device's own data never updated and every later
// IPC (putEvent, joinGroup, snapshot reads) queued behind it and never
// returned.
//
// raceAppend bounds an append against a timeout so a wedged base can never
// hang the dispatcher. The caller (safeAppend in bare.js) flags the group
// for repair on a timeout and skips further appends to it.

const APPEND_TIMEOUT_MS = 10000
// Read timeout. A corrupt base also stalls the read paths (mirrorToLocal,
// view reads), which would freeze the dispatcher just like a hung append.
// Generous, because a healthy autobase read can legitimately take a moment
// on a cold/slow device; only a genuine wedge should trip it.
const READ_TIMEOUT_MS = 12000
const TIMEOUT = Symbol('append-timeout')

// Race any promise against a timeout. Returns { value, timedOut }: the
// resolved value (undefined on timeout/rejection) and whether the timeout
// won. A rejected promise -> { value: undefined, timedOut: false, error }.
// The promise is never awaited past the timeout, so a never-resolving op
// cannot block the caller. Injectable timers for tests.
async function withTimeout (promise, timeoutMs, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout) {
  let timer = null
  const t = new Promise((resolve) => { timer = setTimeoutFn(() => resolve(TIMEOUT), timeoutMs) })
  try {
    const r = await Promise.race([promise, t])
    if (r === TIMEOUT) return { value: undefined, timedOut: true }
    return { value: r, timedOut: false }
  } catch (error) {
    return { value: undefined, timedOut: false, error }
  } finally {
    if (timer) clearTimeoutFn(timer)
  }
}

// Race `appendPromise` against `timeoutMs`. Returns:
//   { ok: true,  timedOut: false } — the append settled first
//   { ok: false, timedOut: true  } — the timeout won (base is wedged)
//   { ok: false, timedOut: false } — the append rejected (e.g. base closed)
// The append promise is never awaited past the timeout, so a never-resolving
// append cannot block the caller. setTimeoutFn / clearTimeoutFn are injectable
// for tests.
async function raceAppend (appendPromise, timeoutMs = APPEND_TIMEOUT_MS, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout) {
  let timer = null
  const timeout = new Promise((resolve) => {
    timer = setTimeoutFn(() => resolve(TIMEOUT), timeoutMs)
  })
  try {
    const r = await Promise.race([
      appendPromise.then(() => 'ok', () => 'rejected'),
      timeout,
    ])
    if (r === TIMEOUT) return { ok: false, timedOut: true }
    return { ok: r === 'ok', timedOut: false }
  } finally {
    if (timer) clearTimeoutFn(timer)
  }
}

module.exports = { raceAppend, withTimeout, APPEND_TIMEOUT_MS, READ_TIMEOUT_MS }
