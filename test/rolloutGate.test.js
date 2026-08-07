const test = require('node:test')
const assert = require('node:assert')
const { classifyRollout, REQUIRED_VERSION, LEGACY_VERSION } = require('../src/lib/rolloutGate.js')

const M = (id, name) => ({ id, name })
const D = (memberId, v) => ({ memberId, v })

test('no members means no decision to make', () => {
  assert.equal(classifyRollout([], []), null)
  assert.equal(classifyRollout(null, null), null)
})

test('every member on the required version is ready', () => {
  const r = classifyRollout(
    [M('a', 'Ana'), M('b', 'Ben')],
    [D('a', REQUIRED_VERSION), D('b', REQUIRED_VERSION)]
  )
  assert.equal(r.ready, true)
  assert.deepEqual(r.waitingOn, [])
})

test('a member on old code holds the gate shut and is named', () => {
  const r = classifyRollout(
    [M('a', 'Ana'), M('b', 'Ben')],
    [D('a', REQUIRED_VERSION), D('b', LEGACY_VERSION)]
  )
  assert.equal(r.ready, false)
  assert.deepEqual(r.waitingOn, ['Ben'])
  assert.equal(r.staleCount, 1)
})

test('a member never seen holds the gate shut — fails CLOSED', () => {
  const r = classifyRollout(
    [M('a', 'Ana'), M('b', 'Ben')],
    [D('a', REQUIRED_VERSION)]
  )
  assert.equal(r.ready, false)
  assert.deepEqual(r.waitingOn, ['Ben'])
  assert.equal(r.neverSeen, 1)
})

// The one that matters. Keying by member and letting the newest or the most
// recent announce win would call Ben ready while his second device still
// applies ops the old way, opening the gate early and forking the calendar.
test('a member is only as new as their OLDEST device', () => {
  const r = classifyRollout(
    [M('a', 'Ana'), M('b', 'Ben')],
    [
      D('a', REQUIRED_VERSION),
      D('b', REQUIRED_VERSION),   // Ben's updated phone
      D('b', LEGACY_VERSION),     // Ben's stale desktop
    ]
  )
  assert.equal(r.ready, false, 'a stale sibling device must hold the gate shut')
  assert.deepEqual(r.waitingOn, ['Ben'])
})

test('device order does not change the verdict', () => {
  const older = [D('b', LEGACY_VERSION), D('b', REQUIRED_VERSION)]
  const newer = [D('b', REQUIRED_VERSION), D('b', LEGACY_VERSION)]
  const a = classifyRollout([M('b', 'Ben')], older)
  const b = classifyRollout([M('b', 'Ben')], newer)
  assert.equal(a.ready, false)
  assert.equal(b.ready, false)
  assert.deepEqual(a.waitingOn, b.waitingOn)
})

test('a missing or malformed version reads as legacy, never as ready', () => {
  for (const bad of [undefined, null, 'two', NaN, {}]) {
    const r = classifyRollout([M('b', 'Ben')], [D('b', bad)])
    assert.equal(r.ready, false, 'version ' + JSON.stringify(bad) + ' must not count as ready')
  }
})

test('a device with no memberId is ignored rather than trusted', () => {
  const r = classifyRollout([M('b', 'Ben')], [D(null, REQUIRED_VERSION)])
  assert.equal(r.ready, false)
  assert.equal(r.neverSeen, 1)
})

test('devices for members no longer in the group do not open the gate', () => {
  const r = classifyRollout(
    [M('a', 'Ana')],
    [D('a', REQUIRED_VERSION), D('gone', LEGACY_VERSION)]
  )
  assert.equal(r.ready, true, 'a departed member should not hold a group shut')
})

test('members are named, falling back to id when unnamed', () => {
  const r = classifyRollout([M('abc123', null)], [])
  assert.deepEqual(r.waitingOn, ['abc123'])
})

test('a future version still counts as ready', () => {
  const r = classifyRollout([M('a', 'Ana')], [D('a', REQUIRED_VERSION + 5)])
  assert.equal(r.ready, true)
})
