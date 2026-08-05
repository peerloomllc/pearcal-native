const test = require('node:test')
const assert = require('node:assert')
const { createCadenceGuard } = require('../src/lib/cadenceGuard.js')

// A controllable clock, so these tests assert on behaviour rather than on how
// fast the machine running them happens to be.
function clock (start = 1_000_000) {
  let t = start
  return { now: () => t, advance: ms => { t += ms } }
}

// A body whose completion the test decides.
function deferredBody () {
  const state = { started: 0, finished: 0, resolvers: [] }
  const run = () => {
    state.started++
    return new Promise(resolve => state.resolvers.push(() => { state.finished++; resolve() }))
  }
  state.run = run
  state.releaseAll = () => { const rs = state.resolvers.splice(0); rs.forEach(r => r()) }
  return state
}

test('THE PILEUP: a slow run is never layered on by the next tick', async () => {
  const c = clock()
  const body = deferredBody()
  const tick = createCadenceGuard({ run: body.run, staleMs: 300_000, now: c.now })

  const first = tick()
  assert.equal(body.started, 1)

  // Five more cadence firings while the first is still in flight.
  for (let i = 0; i < 5; i++) { c.advance(15_000); assert.equal(tick(), null, 'skipped') }
  assert.equal(body.started, 1, 'still exactly one run, not six')

  body.releaseAll()
  await first

  // Once it finishes, the cadence resumes normally.
  c.advance(15_000)
  const next = tick()
  assert.ok(next, 'not skipped once idle')
  assert.equal(body.started, 2)
  body.releaseAll()
  await next
})

test('a wedged run does NOT silence the job forever', async () => {
  const c = clock()
  const body = deferredBody()
  const tick = createCadenceGuard({ run: body.run, staleMs: 300_000, now: c.now })

  tick()                                  // never released: this run is wedged
  c.advance(299_999)
  assert.equal(tick(), null, 'still inside the deadline, so skipped')
  assert.equal(body.started, 1)

  c.advance(2)                            // now past staleMs
  const fresh = tick()
  assert.ok(fresh, 'a fresh run starts rather than stalling forever')
  assert.equal(body.started, 2)

  body.releaseAll()
  await fresh
})

test('a superseded run cannot clear the state of the one that replaced it', async () => {
  const c = clock()
  const body = deferredBody()
  const tick = createCadenceGuard({ run: body.run, staleMs: 300_000, now: c.now })

  const wedged = tick()
  c.advance(300_001)
  tick()                                  // replaces the wedged run
  assert.equal(body.started, 2)

  // The old run finally settles. It must not mark the guard idle, or the
  // replacement would itself be stackable.
  body.resolvers.shift()()
  await wedged

  c.advance(1000)
  assert.equal(tick(), null, 'replacement still holds the slot')
  assert.equal(body.started, 2)
})

test('a throwing run releases the slot', async () => {
  const c = clock()
  let started = 0
  const tick = createCadenceGuard({
    run: () => { started++; return Promise.reject(new Error('boom')) },
    staleMs: 300_000,
    now: c.now,
  })

  await tick()
  c.advance(15_000)
  await tick()
  assert.equal(started, 2, 'a failure must not wedge the cadence')
})

test('a synchronous throw releases the slot too', async () => {
  const c = clock()
  let started = 0
  const tick = createCadenceGuard({
    run: () => { started++; throw new Error('boom') },
    staleMs: 300_000,
    now: c.now,
  })

  await tick()
  c.advance(15_000)
  await tick()
  assert.equal(started, 2)
})

test('slow runs are reported, quick ones are not', async () => {
  const c = clock()
  const lines = []
  const body = deferredBody()
  const tick = createCadenceGuard({
    run: body.run, staleMs: 300_000, slowMs: 15_000, label: 'RT-TICK',
    now: c.now, warn: (...a) => lines.push(a.join(' ')),
  })

  const quick = tick()
  c.advance(500)
  body.releaseAll()
  await quick
  assert.equal(lines.filter(l => l.includes('slow run')).length, 0)

  const slow = tick()
  c.advance(20_000)
  body.releaseAll()
  await slow
  assert.equal(lines.filter(l => l.includes('slow run')).length, 1)
  assert.ok(lines.some(l => l.includes('[RT-TICK]')), 'labelled')
})

test('skips are logged periodically, not on every firing', async () => {
  const c = clock()
  const lines = []
  const body = deferredBody()
  const tick = createCadenceGuard({
    run: body.run, staleMs: 300_000, now: c.now, warn: (...a) => lines.push(a.join(' ')),
  })

  const first = tick()
  for (let i = 0; i < 8; i++) { c.advance(15_000); tick() }
  const skipLines = lines.filter(l => l.includes('skipping'))
  assert.equal(skipLines.length, 2, '8 skips report twice, not 8 times')

  body.releaseAll()
  await first
})
