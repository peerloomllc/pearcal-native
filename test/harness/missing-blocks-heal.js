// Can a device recover when it is missing BLOCKS that the shared history still
// references, or does it spin forever? (#154)
//
// This is the fault that wedged a real install on 2026-08-05: five writer cores
// present but with zero blocks held, `_ensureNodeDependencies` re-queuing ~45,000
// times in 90 seconds, ZERO peer connections completing in that window, and a
// 90s setTimeout that never fired. The device could not fetch its way out even
// though a blind seeder was holding exactly the blocks it needed.
//
// !!! THIS HARNESS DOES NOT REPRODUCE THE FAULT. Kept as a recorded negative
// result so nobody trusts it as validation.
//
// Clearing a peer's blocks and reconnecting looks like the same end state, but
// it is not: with a live peer attached and only ~80 blocks in play, plain
// hypercore replication re-fetches the cleared range on its own. Run with the
// autobase patch REVERTED and it still reports HEALED, identically. So it
// cannot distinguish patched from unpatched and proves nothing either way.
//
// What is missing is the starvation: the real fault had a backlog large enough
// that the retry loop dominated the process, so no connection ever completed.
// A valid reproduction has to recreate that, not just the missing blocks.
//
// The only faithful reproduction found so far is the real install itself:
// clear those five writer cores again on a copy of that data and watch it
// wedge. <scratchpad>/refetch.js is a proven undo for exactly that state.
//
//   node test/harness/missing-blocks-heal.js
//
// Without the autobase patch: B spins and the timer never fires.
// With it: B asks for the missing range, yields, and catches up.

const Autobase = require('autobase')
const Corestore = require('corestore')
const os = require('os')
const path = require('path')
const fs = require('fs')
const { tmpDir } = require('../helpers/tmpdir')

const root = tmpDir('heal-')
const open = store => store.get('view', { valueEncoding: 'json' })

async function apply (nodes, view, host) {
  for (const node of nodes) {
    const v = node.value
    if (!v) continue
    if (v.addWriter) { await host.addWriter(Buffer.from(v.addWriter, 'hex'), { indexer: true }); continue }
    if (v.key) await view.append({ k: v.key })
  }
}

async function mk (name, key) {
  const store = new Corestore(path.join(root, name))
  await store.ready()
  const base = new Autobase(store, key, { open, apply, valueEncoding: 'json' })
  await base.ready()
  return { store, base }
}

async function settle (list, ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    for (const x of list) await x.base.update().catch(() => {})
    await new Promise(r => setTimeout(r, 80))
  }
}

async function main () {
  const a = await mk('a', null)
  const b = await mk('b', a.base.key)

  let s1 = a.store.replicate(true)
  let s2 = b.store.replicate(false)
  s1.pipe(s2).pipe(s1)

  await a.base.append({ addWriter: b.base.local.key.toString('hex') })
  await settle([a, b], 2500)

  // A writes a good deal of history; B replicates it.
  for (let i = 0; i < 60; i++) await a.base.append({ key: 'a-' + i })
  await settle([a, b], 4000)
  console.log('after sync:      B length', b.base.length, 'indexed', b.base.indexedLength)

  // Break the link, then destroy B's copy of A's blocks. B still knows the core
  // exists and how long it is; it just cannot read it. That is the fault state.
  s1.destroy(); s2.destroy()
  await new Promise(r => setTimeout(r, 500))

  let cleared = null
  for (const w of b.base.activeWriters) {
    const c = w.core
    if (!c || !c.length) continue
    if (c.key.equals(b.base.local.key)) continue
    await c.clear(0, c.length).catch(() => {})
    cleared = c
  }
  if (!cleared) { console.log('could not clear a peer core, aborting'); process.exit(1) }
  console.log('cleared peer blocks: length', cleared.length, 'contiguous now', cleared.contiguousLength)

  // A keeps writing while B is away, so B has genuinely new work to do that
  // depends on the history it can no longer read.
  for (let i = 0; i < 20; i++) await a.base.append({ key: 'a-late-' + i })
  await settle([a], 1500)

  // Reconnect. A is reachable and holds everything, exactly like the seeder was.
  s1 = a.store.replicate(true)
  s2 = b.store.replicate(false)
  s1.pipe(s2).pipe(s1)

  // THE TEST: does a plain timer still fire while B works? On the unpatched
  // engine the retry starves the loop and it does not.
  let timerFired = false
  const t0 = Date.now()
  setTimeout(() => { timerFired = true }, 3000)

  const before = b.base.indexedLength
  await settle([a, b], 20000)
  const after = b.base.indexedLength

  console.log('\n---------------- RESULT ----------------')
  console.log('B indexed:', before, '->', after)
  console.log('peer blocks held again:', cleared.contiguousLength, 'of', cleared.length)
  console.log('a plain 3s timer fired while it worked:', timerFired ? 'YES' : 'NO  <-- event loop starved')
  console.log('elapsed', Math.round((Date.now() - t0) / 1000) + 's')
  console.log('')
  console.log(after > before && timerFired
    ? 'HEALED: it fetched what it was missing and stayed responsive.'
    : 'STUCK: it did not recover (this is the #154 failure).')

  await a.base.close().catch(() => {}); await b.base.close().catch(() => {})
  await a.store.close().catch(() => {}); await b.store.close().catch(() => {})
  fs.rmSync(root, { recursive: true, force: true })
  process.exit(0)
}

main().catch(e => { console.error('harness error:', e); process.exit(1) })
