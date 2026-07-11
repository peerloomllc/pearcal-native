// Unit tests for the bring-up start lock + autostart-gate decision
// (src/lib/backendBootstrap.js).
const test = require('node:test')
const assert = require('node:assert/strict')
const { makeStartLock, autostartGateValue } = require('../src/lib/backendBootstrap')

test('makeStartLock: startFn runs once for concurrent callers', async () => {
  let calls = 0
  let resolveStart
  const ensure = makeStartLock(() => { calls++; return new Promise((r) => { resolveStart = r }) })
  const p1 = ensure(); const p2 = ensure(); const p3 = ensure()
  assert.equal(calls, 1, 'startFn invoked exactly once for 3 concurrent callers')
  resolveStart('backend')
  const results = await Promise.all([p1, p2, p3])
  assert.deepEqual(results, ['backend', 'backend', 'backend'], 'all callers get the same value')
})

test('makeStartLock: resolved start is cached (no re-run)', async () => {
  let calls = 0
  const ensure = makeStartLock(() => { calls++; return Promise.resolve('up') })
  assert.equal(await ensure(), 'up')
  assert.equal(await ensure(), 'up')
  assert.equal(calls, 1, 'second call is a no-op')
})

test('makeStartLock: a rejected start is NOT cached (retries)', async () => {
  let calls = 0
  const ensure = makeStartLock(() => { calls++; return Promise.reject(new Error('bundle load failed')) })
  await assert.rejects(ensure())
  assert.equal(calls, 1)
  await assert.rejects(ensure())
  assert.equal(calls, 2, 'transient failure re-runs startFn on the next call')
})

test('autostartGateValue: mirrors a boolean field', () => {
  assert.deepEqual(autostartGateValue({ anyEnabled: true }, 'anyEnabled'), { write: true, value: true })
  assert.deepEqual(autostartGateValue({ anyEnabled: false }, 'anyEnabled'), { write: true, value: false })
})

test('autostartGateValue: leaves the gate untouched when the field is absent/non-boolean', () => {
  assert.deepEqual(autostartGateValue({}, 'anyEnabled'), { write: false, value: false })
  assert.deepEqual(autostartGateValue({ anyEnabled: 'yes' }, 'anyEnabled'), { write: false, value: false })
  assert.deepEqual(autostartGateValue(null, 'anyEnabled'), { write: false, value: false })
})
