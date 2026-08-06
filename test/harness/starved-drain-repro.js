// Reproduce the #154 fault: a device missing blocks the shared history needs
// spins so hard that it cannot complete the networking that would fetch them.
//
// Observed on a real install 2026-08-05: ~45,000 dependency declines in 90s,
// ZERO peer connections completed in that window, and a plain 90s setTimeout
// that never fired, while an always-on seeder sat there holding the blocks.
//
// An earlier attempt (missing-blocks-heal.js) failed to reproduce it and is kept
// as a recorded negative result. Two things were missing, and both matter:
//
//   SCALE. With ~80 blocks the drain finishes and hands control back before
//   anything notices. The starvation only appears once the retry loop has enough
//   work to dominate, because `await` on an already-resolved promise is a
//   MICROtask: it never yields to the I/O phase. A drain that resolves from
//   cache can therefore run indefinitely without letting a socket be read.
//
//   REAL SOCKETS. Two stores piped together in memory replicate through stream
//   callbacks that ride the same microtask queue, so they can appear to work
//   even while I/O is starved. Loopback TCP puts the transfer in the I/O phase,
//   where genuine starvation actually shows.
//
//   node test/harness/starved-drain-repro.js [nodes]
//
// STATUS 2026-08-05: STILL DOES NOT REPRODUCE. Third attempt, recorded so the
// next person starts from what is known rather than repeating it.
//
// What was learned, and it narrows the problem usefully:
//
//   1. With a peer attached, ordinary hypercore replication refills the cleared
//      range by itself and everything heals - patched AND unpatched, identically
//      (verified both ways, twice). So the "request the missing range" half of
//      the patch may well be unnecessary; the real defect looks like it is
//      purely the connection never being established.
//
//   2. The distinguishing feature of the real fault is therefore NOT the missing
//      blocks. It is that a saturated loop could not complete a Hyperswarm
//      connection - DHT queries and a noise handshake need many I/O turns, where
//      an already-open loopback socket needs almost none. Handing this harness a
//      live peer up front skips exactly the thing that broke.
//
//   3. The "dial only once the drain is hot" variant below is the right shape,
//      but as written it hangs during setup, before ever reaching MEASURE_START,
//      for reasons not yet diagnosed. Fix that before trusting any verdict here.
//
// A faithful reproduction probably needs real Hyperswarm rather than loopback
// TCP, so that connection establishment itself has to compete with the drain.

const Autobase = require('autobase')
const Corestore = require('corestore')
const net = require('net')
const os = require('os')
const path = require('path')
const fs = require('fs')

const NODES = Number(process.argv[2] || 2500)
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'starve-'))
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
    await new Promise(r => setTimeout(r, 50))
  }
}

async function main () {
  console.log('building a', NODES, 'node history ...')
  const a = await mk('a', null)
  const b = await mk('b', a.base.key)

  // Phase 1: in-memory link, just to grant the writer and share the history.
  let s1 = a.store.replicate(true)
  let s2 = b.store.replicate(false)
  s1.pipe(s2).pipe(s1)
  await a.base.append({ addWriter: b.base.local.key.toString('hex') })
  await settle([a, b], 2500)

  // Individually, NOT as one batch: a batch append is a single node, and what
  // this needs is many nodes for the drain to grind through.
  for (let i = 0; i < NODES; i++) {
    await a.base.append({ key: 'a-' + i })
    if (i % 500 === 0) await a.base.update().catch(() => {})
  }
  await settle([a, b], 10000)
  console.log('synced:   B length', b.base.length, 'indexed', b.base.indexedLength)

  // Phase 2: cut the link and destroy B's copy of A's blocks. B still knows the
  // core and its length; it simply cannot read any of it. That is the fault.
  s1.destroy(); s2.destroy()
  await new Promise(r => setTimeout(r, 500))

  let victim = null
  for (const w of b.base.activeWriters) {
    const c = w.core
    if (!c || !c.length) continue
    if (c.key.equals(b.base.local.key)) continue
    await c.clear(0, c.length).catch(() => {})
    victim = c
  }
  console.log('cleared:  peer core length', victim.length, 'contiguous', victim.contiguousLength)

  // A keeps working while B is away, so B has fresh nodes to apply that all
  // depend on history it can no longer read.
  for (let i = 0; i < 400; i++) await a.base.append({ key: 'late-' + i })
  await settle([a], 2000)

  // Phase 3: reconnect over REAL loopback TCP, so replication needs the I/O
  // phase rather than riding the microtask queue.
  const server = net.createServer(sock => {
    const st = a.store.replicate(false)
    st.pipe(sock).pipe(st)
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  // Start the drain HOT first, with no peer, so the retry loop is already
  // saturating the process. THEN attempt the connection. This is the ordering
  // the real device was in and the one both earlier attempts skipped: they
  // handed B a live peer before it ever got busy, so replication refilled the
  // cleared range and nothing was ever starved.
  let hot = true
  ;(async () => { while (hot) { await b.base.update().catch(() => {}) } })()
  await new Promise(r => setImmediate(r))

  const connectArmed = Date.now()
  let connectedAfter = null
  const sock = net.connect(port, '127.0.0.1', () => { connectedAfter = Date.now() - connectArmed })
  const bst = b.store.replicate(true)
  bst.pipe(sock).pipe(bst)
  console.log('drain running hot, THEN dialled 127.0.0.1:' + port + ' (A holds everything)\n')

  // THE MEASUREMENT: a plain timer. If the loop is starved it fires late or not
  // at all, which is precisely what was seen on the real device.
  const armed = Date.now()
  let firedAfter = null
  setTimeout(() => { firedAfter = Date.now() - armed }, 3000)

  // Drive the drain from HERE and keep the bookkeeping inline. `settle` sleeps
  // on a timer, and under this fault timers never fire, so waiting that way just
  // hangs and reports nothing - which is exactly what the first run of this did.
  // The point is to survive the starvation well enough to describe it.
  // NOTHING IN-PROCESS CAN REPORT THE FAULT, so the verdict is made from
  // outside. Under the fault `base.update()` never resolves and timers never
  // fire, so any in-process reporting - a setTimeout, a settle() sleep, even a
  // Date.now() check between awaits - is unreachable. Run this with an external
  // timeout and read it this way:
  //
  //   MEASURE_START printed, RESULT never printed  -> REPRODUCED (starved+stuck)
  //   RESULT printed with recovery                 -> HEALED
  console.log('MEASURE_START (if RESULT never appears, it starved and stuck)')
  const before = b.base.indexedLength
  const runUntil = Date.now() + 30000
  while (Date.now() < runUntil) {
    await b.base.update().catch(() => {})
  }
  hot = false
  const after = b.base.indexedLength

  console.log('---------------- RESULT ----------------')
  console.log('B indexed:            ', before, '->', after)
  console.log('peer blocks recovered:', victim.contiguousLength, 'of', victim.length)
  console.log('3s timer fired after: ', firedAfter === null ? 'NEVER' : firedAfter + 'ms')
  console.log('TCP connect completed: ', connectedAfter === null ? 'NEVER' : connectedAfter + 'ms')
  const starved = firedAfter === null || firedAfter > 8000
  const recovered = after > before
  console.log('')
  console.log('event loop starved:', starved ? 'YES' : 'no')
  console.log('recovered:         ', recovered ? 'YES' : 'no')
  console.log('')
  console.log(starved && !recovered
    ? 'REPRODUCED the #154 failure: starved and stuck.'
    : recovered && !starved
      ? 'HEALED: fetched what it was missing and stayed responsive.'
      : 'INCONCLUSIVE - tune the node count and look at the numbers above.')

  sock.destroy(); server.close()
  await a.base.close().catch(() => {}); await b.base.close().catch(() => {})
  await a.store.close().catch(() => {}); await b.store.close().catch(() => {})
  fs.rmSync(root, { recursive: true, force: true })
  process.exit(0)
}

main().catch(e => { console.error('harness error:', e); process.exit(1) })
