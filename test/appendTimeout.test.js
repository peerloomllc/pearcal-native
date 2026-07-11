// Unit tests for the append/read timeout helpers (src/lib/appendTimeout.js).
// Injectable timers keep these deterministic — no real wall-clock waits.
const test = require('brittle')
const { raceAppend, withTimeout } = require('../src/lib/appendTimeout')

const neverFire = () => 1            // setTimeoutFn that returns an id but never calls cb
const noClear = () => {}
const fireNow = (cb) => { cb(); return 1 } // setTimeoutFn that fires synchronously

test('raceAppend: append settles first -> ok', async (t) => {
  const r = await raceAppend(Promise.resolve('done'), 1000, neverFire, noClear)
  t.alike(r, { ok: true, timedOut: false })
})

test('raceAppend: append rejects -> not ok, not timed out', async (t) => {
  const r = await raceAppend(Promise.reject(new Error('Closed')), 1000, neverFire, noClear)
  t.alike(r, { ok: false, timedOut: false })
})

test('raceAppend: timeout wins on a wedged append', async (t) => {
  const wedged = new Promise(() => {}) // never resolves
  const r = await raceAppend(wedged, 1000, fireNow, noClear)
  t.alike(r, { ok: false, timedOut: true })
})

test('withTimeout: value passes through', async (t) => {
  const r = await withTimeout(Promise.resolve(42), 1000, neverFire, noClear)
  t.alike(r, { value: 42, timedOut: false })
})

test('withTimeout: timeout on a stalled read', async (t) => {
  const r = await withTimeout(new Promise(() => {}), 1000, fireNow, noClear)
  t.alike(r, { value: undefined, timedOut: true })
})

test('withTimeout: rejection surfaces error, not a timeout', async (t) => {
  const r = await withTimeout(Promise.reject(new Error('boom')), 1000, neverFire, noClear)
  t.is(r.timedOut, false)
  t.is(r.value, undefined)
  t.ok(r.error && r.error.message === 'boom')
})
