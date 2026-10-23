// Does a long un-indexed Autobase tail make apply() re-run cost grow, and does
// it burn user CPU rather than sit idle?
//
// That is the shape #151 needs: the observed fault was 94% USER cpu sustained
// for minutes, which rules out anything blocked on I/O. Re-application is real
// computation, and its cost tracks the tail rather than the change, so it grows
// with uptime.
//
// This uses Autobase directly rather than the worklet. The question is a
// property of Autobase's linearization, not of PearCal's schema, and a direct
// rig can force the exact condition - a signed view frozen behind a dead
// indexer - which two live peers cannot be made to do on demand.
//
//   node test/harness/reapply-amplification.js
//
// Prints applied-node counts and CPU per round as the tail grows.

const Autobase = require('autobase')
const Corestore = require('corestore')
const os = require('os')
const path = require('path')
const fs = require('fs')
const { tmpDir } = require('../helpers/tmpdir')

const ROUNDS = Number(process.argv[2] || 6)
const APPENDS_PER_ROUND = Number(process.argv[3] || 40)

const root = tmpDir('reapply-')
let applyCalls = 0
let appliedNodes = 0

function open (store) {
  return store.get('view', { valueEncoding: 'json' })
}

async function apply (nodes, view, host) {
  applyCalls++
  for (const node of nodes) {
    appliedNodes++
    const v = node.value
    if (v && v.addWriter) {
      await host.addWriter(Buffer.from(v.addWriter, 'hex'), { indexer: true })
      continue
    }
    // Stand in for mirrorToLocal: a little real work per node, the way the
    // worklet decodes, compares and writes.
    if (v && v.key) await view.append({ k: v.key, at: v.at })
  }
}

function cpuMs () {
  const u = process.cpuUsage()
  return (u.user + u.system) / 1000
}

async function main () {
  const storeA = new Corestore(path.join(root, 'a'))
  await storeA.ready()
  const a = new Autobase(storeA, null, { open, apply, valueEncoding: 'json' })
  await a.ready()

  // A second and third writer, both indexers, mirroring how PearCal adds every
  // device (src/bare.js host.addWriter(..., { indexer: true })).
  const storeB = new Corestore(path.join(root, 'b'))
  await storeB.ready()
  const b = new Autobase(storeB, a.key, { open, apply, valueEncoding: 'json' })
  await b.ready()

  await a.append({ addWriter: b.local.key.toString('hex') })
  await a.update()

  const s1 = storeA.replicate(true)
  const s2 = storeB.replicate(false)
  s1.pipe(s2).pipe(s1)

  console.log('indexers now:', a.writers?.length ?? '?', '- majority needed to advance the signed view')
  console.log('')
  console.log('round | appends | nodes applied | apply() calls | cpu ms | indexed/length')
  console.log('------+---------+---------------+---------------+--------+---------------')

  for (let r = 1; r <= ROUNDS; r++) {
    const nodesBefore = appliedNodes
    const callsBefore = applyCalls
    const cpuBefore = cpuMs()

    // Both writers append independently, which is what creates the forks that
    // make Autobase re-linearize.
    for (let i = 0; i < APPENDS_PER_ROUND; i++) {
      await a.append({ key: 'a-' + r + '-' + i, at: r })
      await b.append({ key: 'b-' + r + '-' + i, at: r })
    }
    await a.update()
    await b.update()

    const cpu = Math.round(cpuMs() - cpuBefore)
    console.log(
      String(r).padStart(5), '|',
      String(APPENDS_PER_ROUND * 2).padStart(7), '|',
      String(appliedNodes - nodesBefore).padStart(13), '|',
      String(applyCalls - callsBefore).padStart(13), '|',
      String(cpu).padStart(6), '|',
      (a.indexedLength ?? '?') + '/' + (a.length ?? '?')
    )
  }

  console.log('')
  console.log('If nodes-applied per round stays flat, re-application is bounded and')
  console.log('this is NOT the #151 mechanism. If it climbs with the tail, it is.')

  await a.close(); await b.close()
  await storeA.close(); await storeB.close()
  fs.rmSync(root, { recursive: true, force: true })
}

main().catch(e => { console.error('harness error:', e); process.exit(1) })
