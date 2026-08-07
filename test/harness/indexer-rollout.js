// Is the two-release rollout in proposals/2026-08-07-non-indexer-writers.md
// actually safe? This is the check that proposal listed under Verify and never
// ran, and it is the riskiest step in the whole plan.
//
//   node test/harness/indexer-rollout.js
//
// THE HAZARD. apply() runs independently on EVERY peer over the same nodes, so
// if two peers interpret one `addWriter` op differently they build different
// system state from identical input. That is a fork: two calendars where there
// was one, and no way back. Changing who may sign is exactly that kind of
// change, which is why this has to be settled before any code ships.
//
// THREE CODE GENERATIONS:
//   old  - what ships today. Ignores any `indexer` field, always grants indexer.
//   N    - reads an explicit `indexer` field, DEFAULTS TO TRUE when absent.
//          Behaviour-preserving, meant to ship first and be given time.
//   N+1  - identical READER to N; differs only in that it WRITES indexer:false.
//
// So the peer-side apply for N and N+1 is the same function, and what varies is
// the op. The matrix below is (peer generations) x (op shape).
//
// WHAT EACH CASE PROVES:
//   A  old + old,  no field       agree   - baseline, today's behaviour
//   B  old + N,    no field       agree   - N is safe to ship alongside old
//   C  old + N,    indexer:false  DIVERGE - you must NOT write the field until
//                                           every peer reads it. This case
//                                           failing to diverge would mean the
//                                           staged rollout is unnecessary;
//                                           this case diverging is the whole
//                                           reason release N exists.
//   D  N   + N,    indexer:false  agree   - N+1 is safe once everyone is on N
//
// If B or D diverge, the rollout plan is wrong and the proposal is wrong.

const M = '/home/tim/peerloomllc/pearcal-native/node_modules/'
const Autobase = require(M + 'autobase')
const Corestore = require(M + 'corestore')
const crypto = require(M + 'hypercore-crypto')
const os = require('os'), path = require('path'), fs = require('fs')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-'))
let n = 0
const open = s => s.get('view', { valueEncoding: 'json' })

// The only difference between generations, isolated to one expression.
function makeApply (gen) {
  return async function apply (nodes, view, host) {
    for (const node of nodes) {
      const v = node.value
      if (!v) continue
      if (v.addWriter) {
        const asIndexer = gen === 'old'
          ? true                      // today: the field does not exist
          : v.indexer !== false       // N and N+1: read it, default true
        await host.addWriter(Buffer.from(v.addWriter, 'hex'), { indexer: asIndexer })
        continue
      }
      if (v.key) await view.append({ k: v.key })
    }
  }
}

async function mk (name, key, gen) {
  const store = new Corestore(path.join(root, name + '-' + (++n)))
  await store.ready()
  const base = new Autobase(store, key, {
    open, apply: makeApply(gen), valueEncoding: 'json', ackInterval: 1000
  })
  await base.ready()
  return { store, base, gen }
}

function link (a, b) {
  const s1 = a.store.replicate(true), s2 = b.store.replicate(false)
  s1.pipe(s2).pipe(s1)
  return () => { s1.destroy(); s2.destroy() }
}

async function settle (bs, ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    for (const b of bs) await b.base.update().catch(() => {})
    await new Promise(r => setTimeout(r, 80))
  }
}

// What each peer believes about the shared system state.
async function beliefs (peer, key) {
  const sys = peer.base.system
  let rec = null
  try { rec = await sys.get(Buffer.from(key, 'hex')) } catch {}
  return {
    indexers: peer.base.linearizer?.indexers?.length ?? -1,
    sysIndexers: sys?.indexers?.length ?? -1,
    isIndexer: rec ? !!rec.isIndexer : null,
    members: sys?.members ?? -1
  }
}

async function scenario (label, genA, genB, writeField, expectAgree) {
  const a = await mk('a', null, genA)
  const b = await mk('b', a.base.key, genB)
  const unlink = link(a, b)

  // Make b a writer first, with a plain op both generations read identically,
  // so b's own membership is never the thing under test.
  await a.base.append({ addWriter: b.base.local.key.toString('hex') })
  await settle([a, b], 4000)

  // The op under test names a REAL third peer, not a bare keypair. This matters:
  // a key with no core never becomes an ACTIVE indexer, so an earlier version of
  // this harness saw the two peers disagree about the stored record while their
  // majority stayed identical - which understates the hazard. With a real peer
  // replicating, a disagreement moves the consensus threshold itself.
  const c = await mk('c', a.base.key, genA)
  link(a, c); link(b, c)
  const third = c.base.local.key.toString('hex')
  const op = { addWriter: third }
  if (writeField) op.indexer = false
  await a.base.append(op)
  await settle([a, b, c], 10000)
  // Give the new writer something to author so it can actually activate.
  await c.base.append({ key: 'c-hello' }).catch(() => {})
  await settle([a, b, c], 8000)

  const ba = await beliefs(a, third)
  const bb = await beliefs(b, third)
  const agree = ba.isIndexer === bb.isIndexer &&
                ba.indexers === bb.indexers &&
                ba.members === bb.members
  const majA = Math.floor(ba.indexers / 2) + 1
  const majB = Math.floor(bb.indexers / 2) + 1

  const verdict = agree ? 'AGREE' : 'DIVERGE'
  const ok = agree === expectAgree
  console.log(
    '  ' + label.padEnd(30) +
    'A(' + genA + ')=' + String(ba.isIndexer).padEnd(5) + 'idx' + ba.indexers + '/maj' + majA +
    '   B(' + genB + ')=' + String(bb.isIndexer).padEnd(5) + 'idx' + bb.indexers + '/maj' + majB +
    '   ' + verdict.padEnd(8) + (ok ? 'as expected' : '*** UNEXPECTED ***')
  )

  unlink()
  for (const p of [a, b, c]) { await p.base.close().catch(() => {}); await p.store.close().catch(() => {}) }
  return ok
}

;(async () => {
  console.log('=== Is the two-release rollout safe? ===')
  console.log('  (isIndexer as each peer sees it for the same third key)\n')

  const results = []
  results.push(await scenario('A  old + old,  no field',   'old', 'old', false, true))
  results.push(await scenario('B  old + N,    no field',   'old', 'N',   false, true))
  results.push(await scenario('C  old + N,    indexer:false', 'old', 'N', true,  false))
  results.push(await scenario('D  N   + N,    indexer:false', 'N',   'N', true,  true))

  const allOk = results.every(Boolean)
  console.log('\n---------------- RESULT ----------------')
  console.log(allOk
    ? 'ROLLOUT PLAN HOLDS: N ships safely beside old (B), N+1 is safe once\n' +
      'everyone reads the field (D), and writing it too early really does fork\n' +
      'the group (C) - which is exactly why release N must land first.'
    : 'ROLLOUT PLAN IS WRONG: a case did not behave as the proposal assumes.\n' +
      'Do not implement until the numbers above are understood.')

  fs.rmSync(root, { recursive: true, force: true })
  process.exit(allOk ? 0 : 1)
})().catch(e => { console.error('harness error:', e); process.exit(1) })
