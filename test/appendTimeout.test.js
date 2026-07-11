// Unit tests for the append/read timeout helpers (src/lib/appendTimeout.js).
// Injectable timers keep these deterministic — no real wall-clock waits.
const test = require('node:test')
const assert = require('node:assert/strict')
const { raceAppend, withTimeout } = require('../src/lib/appendTimeout')

const neverFire = () => 1            // setTimeoutFn that returns an id but never calls cb
const noClear = () => {}
const fireNow = (cb) => { cb(); return 1 } // setTimeoutFn that fires synchronously

test('raceAppend: append settles first -> ok', async () => {
  const r = await raceAppend(Promise.resolve('done'), 1000, neverFire, noClear)
  assert.deepEqual(r, { ok: true, timedOut: false })
})

test('raceAppend: append rejects -> not ok, not timed out', async () => {
  const r = await raceAppend(Promise.reject(new Error('Closed')), 1000, neverFire, noClear)
  assert.deepEqual(r, { ok: false, timedOut: false })
})

test('raceAppend: timeout wins on a wedged append', async () => {
  const wedged = new Promise(() => {}) // never resolves
  const r = await raceAppend(wedged, 1000, fireNow, noClear)
  assert.deepEqual(r, { ok: false, timedOut: true })
})

test('withTimeout: value passes through', async () => {
  const r = await withTimeout(Promise.resolve(42), 1000, neverFire, noClear)
  assert.deepEqual(r, { value: 42, timedOut: false })
})

test('withTimeout: timeout on a stalled read', async () => {
  const r = await withTimeout(new Promise(() => {}), 1000, fireNow, noClear)
  assert.deepEqual(r, { value: undefined, timedOut: true })
})

test('withTimeout: rejection surfaces error, not a timeout', async () => {
  const r = await withTimeout(Promise.reject(new Error('boom')), 1000, neverFire, noClear)
  assert.equal(r.timedOut, false)
  assert.equal(r.value, undefined)
  assert.ok(r.error && r.error.message === 'boom')
})
