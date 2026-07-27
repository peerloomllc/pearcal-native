// TODO #118 — in-app "Reset app data". Pure decision extracted to
// src/lib/resetPlan.js. (feature/in-app-reset-data)
const test = require('node:test')
const assert = require('node:assert/strict')
const { resetPlan, DATA_SUBPATHS } = require('../src/lib/resetPlan.js')

test('the default level KEEPS the identity', () => {
  assert.equal(resetPlan({}).keepIdentity, true)
  assert.equal(resetPlan({}).deleteIdentity, false)
})

test('deleting the identity takes an explicit false, nothing less', () => {
  assert.equal(resetPlan({ keepIdentity: false }).deleteIdentity, true)
  // Everything else is the safe level. A caller that passes the wrong shape
  // must not lose a user's recovery phrase over it.
  for (const wrong of [undefined, null, {}, { keepIdentity: undefined }, { keepIdentity: 0 },
    { keepIdentity: '' }, { keepIdentity: 'false' }, { keepIdentity: 'no' }]) {
    assert.equal(resetPlan(wrong).deleteIdentity, false,
      'expected keep-identity for ' + JSON.stringify(wrong))
  }
})

test('a keep-identity reset still wipes the data, it is not a no-op', () => {
  const plan = resetPlan({ keepIdentity: true })
  assert.ok(plan.subpaths.includes('core'))
  assert.ok(plan.subpaths.includes('store'))
})

test("REBUILD LEFTOVERS: the plan covers rebuildLocalDb's staging dirs", () => {
  // rebuildLocalDb renames core -> core.old and core.new -> core. An aborted
  // run leaves a full readable copy of the old database in one of those, so a
  // reset that removed only `core` would leave the "wiped" calendar on disk.
  const plan = resetPlan({ keepIdentity: false })
  assert.ok(plan.subpaths.includes('core.new'), 'core.new must be removed')
  assert.ok(plan.subpaths.includes('core.old'), 'core.old must be removed')
})

test('the path list is a copy, so a caller cannot mutate the shared constant', () => {
  const plan = resetPlan({})
  plan.subpaths.push('etc')
  assert.equal(DATA_SUBPATHS.includes('etc'), false)
  assert.equal(resetPlan({}).subpaths.includes('etc'), false)
})

test('every path is relative, so a reset can never escape the data directory', () => {
  for (const p of DATA_SUBPATHS) {
    assert.equal(p.startsWith('/'), false, p + ' must not be absolute')
    assert.equal(p.includes('..'), false, p + ' must not traverse upward')
  }
})
