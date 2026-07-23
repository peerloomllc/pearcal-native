// Unit tests for the RN shell's IPC event-handler registry (src/lib/eventRegistry.js).
// The regression these exist for is TODO #126: one bare event producing N
// identical notifications because the handler set was registered N times.
const test = require('node:test')
const assert = require('node:assert/strict')
const { createEventRegistry } = require('../src/lib/eventRegistry')
const { makeStartLock } = require('../src/lib/backendBootstrap')

test('dispatch delivers to a registered handler exactly once', () => {
  const reg = createEventRegistry()
  const seen = []
  reg.on('syncNotify', (d) => seen.push(d))
  reg.dispatch('syncNotify', { title: 'Sam added Dinner' })
  assert.deepEqual(seen, [{ title: 'Sam added Dinner' }])
})

test('dispatch on an unregistered event is a no-op', () => {
  const reg = createEventRegistry()
  assert.equal(reg.dispatch('nope', {}), 0)
})

test('reset drops every handler', () => {
  const reg = createEventRegistry()
  reg.on('syncNotify', () => {})
  reg.on('sync', () => {})
  assert.equal(reg.count('syncNotify'), 1)
  reg.reset()
  assert.equal(reg.count('syncNotify'), 0)
  assert.equal(reg.count('sync'), 0)
})

test('one throwing handler does not stop the others', () => {
  const reg = createEventRegistry()
  const seen = []
  reg.on('sync', () => { throw new Error('boom') })
  reg.on('sync', () => seen.push('second ran'))
  reg.dispatch('sync', {})
  assert.deepEqual(seen, ['second ran'], 'later handlers still run')
})

// ── The TODO #126 regression ────────────────────────────────────────────────
// Models the real shell lifecycle: a module-level registry that outlives mounts,
// plus a memoized bring-up body that the Activity teardown nulls so a later cold
// mount re-runs it. Uses the REAL makeStartLock the shell uses.

function makeShell () {
  const reg = createEventRegistry()          // module-level: survives teardown
  const posted = []
  let ensureStarted = null                   // the memo the teardown nulls

  async function mount () {
    if (!ensureStarted) {
      ensureStarted = makeStartLock(async () => {
        // The bring-up body registers the COMPLETE handler set. Clearing first
        // is the fix: it makes re-entry replace rather than stack.
        reg.reset()
        reg.on('syncNotify', (d) => posted.push(d.title))
      })
    }
    await ensureStarted()
  }

  // Cold teardown: worklet terminated, memo nulled. The registry is NOT cleared
  // here, because a warm reopen adopts the live worklet and its handlers.
  function coldTeardown () { ensureStarted = null }

  return { reg, posted, mount, coldTeardown }
}

test('#126: repeated cold mounts leave exactly ONE handler', async () => {
  const shell = makeShell()
  await shell.mount()
  assert.equal(shell.reg.count('syncNotify'), 1, 'first mount registers one')

  for (let i = 0; i < 4; i++) {
    shell.coldTeardown()
    await shell.mount()
  }
  assert.equal(shell.reg.count('syncNotify'), 1,
    'still exactly one handler after 5 cold mount cycles')
})

test('#126: one bare event yields one notification after repeated reopens', async () => {
  const shell = makeShell()
  await shell.mount()
  shell.coldTeardown(); await shell.mount()
  shell.coldTeardown(); await shell.mount()

  // Exactly what the field report describes: ONE syncNotify from bare, after
  // the app has been closed and reopened a few times.
  shell.dispatchCount = shell.reg.dispatch('syncNotify', { title: 'Sam added Dinner' })

  assert.equal(shell.posted.length, 1,
    'one bare event must produce one notification, not one per reopen')
  assert.deepEqual(shell.posted, ['Sam added Dinner'])
})

test('#126: without the reset, the same lifecycle stacks handlers (proves the mechanism)', async () => {
  // Same shell, but the bring-up body does NOT reset first. This is the code as
  // it shipped, and it must reproduce the reported 3-identical-notifications.
  const reg = createEventRegistry()
  const posted = []
  let ensureStarted = null
  async function mount () {
    if (!ensureStarted) {
      ensureStarted = makeStartLock(async () => {
        reg.on('syncNotify', (d) => posted.push(d.title))   // no reset()
      })
    }
    await ensureStarted()
  }

  await mount()
  ensureStarted = null; await mount()
  ensureStarted = null; await mount()

  assert.equal(reg.count('syncNotify'), 3, 'three cold mounts stacked three handlers')
  reg.dispatch('syncNotify', { title: 'Sam added Dinner' })
  assert.equal(posted.length, 3,
    'ONE bare event produced THREE identical notifications - the reported bug')
})

test('#126: a warm reopen (memo intact) does not re-register', async () => {
  const shell = makeShell()
  await shell.mount()
  await shell.mount()   // warm: memo still set, body does not re-run
  assert.equal(shell.reg.count('syncNotify'), 1)
})
