// How fast can a device that has fallen behind catch up, and where does the time
// actually go?
//
// Tim's Pixel linearised a ~15,500 entry backlog at ~4.6 nodes/sec after the
// #154 fix (PR #293). The data was already on disk, so that number is about
// processing, not network. At that rate a device away for a while pays minutes
// of pegged CPU, which is how a bad state stayed invisible for 13 hours.
//
//   node test/harness/linearize-bench.js [nodes] [writers]
//   node --cpu-prof --cpu-prof-dir=/tmp/prof test/harness/linearize-bench.js
//
// Reports nodes/sec for a fresh peer catching up. Run it under --cpu-prof to see
// which calls dominate.

const Autobase = require('autobase')
const Corestore = require('corestore')
const os = require('os')
const path = require('path')
const fs = require('fs')

const NODES = Number(process.argv[2] || 3000)
const WRITERS = Number(process.argv[3] || 3)

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-'))
const open = store => store.get('view', { valueEncoding: 'json' })

let applyCalls = 0
let appliedNodes = 0

async function apply (nodes, view, host) {
  applyCalls++
  for (const node of nodes) {
    appliedNodes++
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
  return { store, base, name }
}

function link (a, b) {
  const s1 = a.store.replicate(true)
  const s2 = b.store.replicate(false)
  s1.pipe(s2).pipe(s1)
  return () => { s1.destroy(); s2.destroy() }
}

async function settle (list, ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    for (const x of list) await x.base.update().catch(() => {})
    await new Promise(r => setTimeout(r, 30))
  }
}

async function main () {
  console.log('writers:', WRITERS, '| nodes to catch up on:', NODES, '\n')

  const primary = await mk('primary', null)
  const peers = [primary]
  const unlinks = []

  for (let i = 1; i < WRITERS; i++) {
    const p = await mk('w' + i, primary.base.key)
    unlinks.push(link(primary, p))
    await primary.base.append({ addWriter: p.base.local.key.toString('hex') })
    peers.push(p)
  }
  await settle(peers, 3000)
  console.log('writers granted:', primary.base.activeWriters.size)

  // Build the backlog, spread across writers so the linearizer has real forks to
  // resolve rather than one tidy chain.
  const t0 = Date.now()
  for (let i = 0; i < NODES; i++) {
    const w = peers[i % peers.length]
    await w.base.append({ key: 'n-' + i })
  }
  await settle(peers, 6000)
  console.log('backlog built in', Math.round((Date.now() - t0) / 1000) + 's',
    '| primary length', primary.base.length, 'indexed', primary.base.indexedLength)

  for (const u of unlinks) u()
  await new Promise(r => setTimeout(r, 300))

  // THE MEASUREMENT: a brand-new device joins and has to catch up on all of it,
  // with every byte available from a peer that is right there.
  appliedNodes = 0
  applyCalls = 0
  const late = await mk('latecomer', primary.base.key)
  const unlink = link(primary, late)

  const start = Date.now()
  let last = 0
  let stable = 0
  while (Date.now() - start < 180000) {
    await late.base.update().catch(() => {})
    const len = late.base.length
    if (len === last) {
      if (++stable > 40 && len > 0) break
    } else {
      stable = 0
      last = len
    }
    await new Promise(r => setTimeout(r, 25))
  }
  const secs = (Date.now() - start) / 1000

  console.log('\n---------------- RESULT ----------------')
  console.log('caught up to length:', late.base.length, '| indexed', late.base.indexedLength)
  console.log('nodes applied:      ', appliedNodes, 'over', applyCalls, 'apply() calls')
  console.log('elapsed:            ', secs.toFixed(1) + 's')
  console.log('rate:               ', (late.base.length / secs).toFixed(1), 'nodes/sec')
  const hits = late.base._pcSysHits || 0
  const misses = late.base._pcSysMisses || 0
  if (hits + misses) {
    console.log('system reads:       ', misses, 'actual,', hits, 'served from cache',
      '(' + (hits / (hits + misses) * 100).toFixed(1) + '% avoided)')
  }
  console.log('')
  console.log('Tim\'s Pixel managed ~4.6/sec on a real 15,500 entry backlog.')

  unlink()
  for (const p of [...peers, late]) {
    await p.base.close().catch(() => {})
    await p.store.close().catch(() => {})
  }
  fs.rmSync(root, { recursive: true, force: true })
  process.exit(0)
}

main().catch(e => { console.error('bench error:', e); process.exit(1) })
