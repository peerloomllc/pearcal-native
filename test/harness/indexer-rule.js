// The selection rule for TODO #159: can a 3-indexer set be ESTABLISHED,
// MAINTAINED, and RECOVERED? indexer-model.js establishes the problem
// (scenarios A-H); this file establishes what a policy is allowed to assume.
//
//   node test/harness/indexer-rule.js
//
// I: 1 -> 3, both sequentially and as one batched append. The 2-indexer state
//    is a trap (majority 2, zero margin), so the question is whether it can be
//    skipped, and whether passing through it is survivable when both are up.
// J: 3 indexers, one permanently gone, swap in a replacement atomically so the
//    declared set never dips to 2.
// K: THE one that matters for installs already in the field. An over-indexed
//    group is NOT necessarily doomed. H showed a group that cannot reach quorum
//    can never recover - but a group that can still assemble a majority ONCE
//    can batch-remove its way down to 3 and be permanently healthy after.
const M = '/home/tim/peerloomllc/pearcal-native/node_modules/'
const Autobase = require(M + 'autobase')
const Corestore = require(M + 'corestore')
const os = require('os'), path = require('path'), fs = require('fs')
const { tmpDir } = require('../helpers/tmpdir')
const root = tmpDir('rule-')
let n = 0
const open = s => s.get('view', { valueEncoding: 'json' })

async function apply (nodes, view, host) {
  for (const node of nodes) {
    const v = node.value
    if (!v) continue
    if (v.addWriter) { await host.addWriter(Buffer.from(v.addWriter, 'hex'), { indexer: v.indexer !== false }); continue }
    if (v.removeWriter) { await host.removeWriter(Buffer.from(v.removeWriter, 'hex')); continue }
    if (v.key) await view.append({ k: v.key })
  }
}
async function mk (name, key) {
  const store = new Corestore(path.join(root, name + '-' + (++n)))
  await store.ready()
  const base = new Autobase(store, key, { open, apply, valueEncoding: 'json', ackInterval: 1000 })
  await base.ready()
  return { store, base }
}
function link (a, b) {
  const s1 = a.store.replicate(true), s2 = b.store.replicate(false)
  s1.pipe(s2).pipe(s1); return () => { s1.destroy(); s2.destroy() }
}
async function settle (bs, ms) {
  const end = Date.now() + ms
  while (Date.now() < end) { for (const b of bs) await b.base.update().catch(() => {}); await new Promise(r => setTimeout(r, 80)) }
}
const idx = o => o.base.linearizer?.indexers?.length
const rpt = (t, o) => console.log('   ' + t.padEnd(30) + 'indexers=' + idx(o) + ' indexed=' + o.base.indexedLength + '/' + o.base.length)

async function run (label, atomic) {
  console.log('\n=== I' + (atomic ? ' (atomic 1->3)' : ' (sequential 1->2->3)') + ': ' + label + ' ===')
  const owner = await mk('o', null)
  const m1 = await mk('m1', owner.base.key)
  const m2 = await mk('m2', owner.base.key)
  const all = [owner, m1, m2]
  link(owner, m1); link(owner, m2); link(m1, m2)
  await owner.base.append({ addWriter: m1.base.local.key.toString('hex'), indexer: false })
  await owner.base.append({ addWriter: m2.base.local.key.toString('hex'), indexer: false })
  await settle(all, 4000)
  for (let i = 0; i < 5; i++) await owner.base.append({ key: 'seed-' + i })
  await settle(all, 4000)
  rpt('after joins (plain writers):', owner)

  const k1 = m1.base.local.key.toString('hex'), k2 = m2.base.local.key.toString('hex')
  if (atomic) {
    // Both promotions in ONE append batch.
    await owner.base.append([{ addWriter: k1, indexer: true }, { addWriter: k2, indexer: true }])
  } else {
    await owner.base.append({ addWriter: k1, indexer: true })
    await settle(all, 4000)
    rpt('after promoting ONE:', owner)
    await owner.base.append({ addWriter: k2, indexer: true })
  }
  await settle(all, 8000)
  rpt('after promotion(s):', owner)

  // Does it still sign with all three present?
  const at = owner.base.length
  for (let i = 0; i < 5; i++) await owner.base.append({ key: 'post-' + i })
  await settle(all, 8000)
  rpt('after more writes:', owner)
  const healthy = owner.base.indexedLength > at
  console.log('   => reached 3 indexers:', idx(owner) === 3 ? 'YES' : 'NO (' + idx(owner) + ')',
    '| still signing:', healthy ? 'YES' : 'NO')

  // J: lose one permanently, then swap in a replacement atomically.
  if (idx(owner) === 3) {
    console.log('   --- J: lose one of three, then replace it ---')
    await m2.base.close().catch(() => {}); await m2.store.close().catch(() => {})
    const survivors = [owner, m1]
    const lossAt = owner.base.length
    for (let i = 0; i < 5; i++) await owner.base.append({ key: 'afterloss-' + i })
    await settle(survivors, 8000)
    rpt('3 minus 1 (majority 2):', owner)
    console.log('   => 2 of 3 still signs:', owner.base.indexedLength > lossAt ? 'YES' : 'NO')

    const m3 = await mk('m3', owner.base.key)
    link(owner, m3); link(m1, m3)
    await owner.base.append({ addWriter: m3.base.local.key.toString('hex'), indexer: false })
    await settle([owner, m1, m3], 5000)
    // Atomic swap: promote the newcomer AND drop the departed, one batch.
    await owner.base.append([{ addWriter: m3.base.local.key.toString('hex'), indexer: true }, { removeWriter: k2 }])
    await settle([owner, m1, m3], 10000)
    rpt('after atomic swap:', owner)
    const swapAt = owner.base.length
    for (let i = 0; i < 5; i++) await owner.base.append({ key: 'postswap-' + i })
    await settle([owner, m1, m3], 8000)
    rpt('after swap + writes:', owner)
    console.log('   => back to 3 indexers:', idx(owner) === 3 ? 'YES' : 'NO (' + idx(owner) + ')',
      '| signing:', owner.base.indexedLength > swapAt ? 'YES' : 'NO')
  }
}

async function scenarioK () {
  console.log('=== K: repair a 7-indexer group down to 3, in one coordinated moment ===')
  const owner = await mk('k-owner', null)
  const peers = []
  for (let i = 1; i < 7; i++) peers.push(await mk('k-p' + i, owner.base.key))
  const all = [owner, ...peers]
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) link(all[i], all[j])
  // Build the group the way PearCal does today: everyone an indexer.
  for (const p of peers) {
    await owner.base.append({ addWriter: p.base.local.key.toString('hex'), indexer: true })
    for (let t = 0; t < 80; t++) { await settle(all, 250); if (idx(owner) >= 2 + peers.indexOf(p)) break }
  }
  await settle(all, 5000)
  for (let i = 0; i < 5; i++) await owner.base.append({ key: 'k-seed-' + i })
  await settle(all, 6000)
  rpt('today: everyone an indexer', owner)
  if (idx(owner) !== 7) { console.log('   SETUP FAILED, only got', idx(owner)); return }

  // Show the damage: 3 of the 7 go quiet, majority 4 is now unreachable.
  const sleepers = peers.slice(3)
  const unl = []
  for (const s of sleepers) { await s.base.close().catch(() => {}); await s.store.close().catch(() => {}) }
  const awake = [owner, ...peers.slice(0, 3)]
  const damagedAt = owner.base.length
  for (let i = 0; i < 5; i++) await owner.base.append({ key: 'k-damaged-' + i })
  await settle(awake, 8000)
  rpt('3 of 7 asleep (need 4):', owner)
  console.log('   => still signing with 4 of 7 awake:', owner.base.indexedLength > damagedAt ? 'YES' : 'NO')

  // THE REPAIR: while 4 are awake (majority of 7), batch-remove 4 indexers,
  // leaving 3. One coordinated moment, one append.
  const drop = [...sleepers.map(s => s.base.local.key.toString('hex')), peers[2].base.local.key.toString('hex')]
  console.log('   repairing: removing', drop.length, 'indexers in one batch')
  await owner.base.append(drop.map(k => ({ removeWriter: k })))
  await settle(awake, 12000)
  rpt('after the repair batch:', owner)

  // Now prove it survives a loss it could never have survived before.
  const survivors = [owner, peers[0], peers[1]]
  for (const p of [peers[2]]) { await p.base.close().catch(() => {}); await p.store.close().catch(() => {}) }
  const at = owner.base.length
  for (let i = 0; i < 5; i++) await owner.base.append({ key: 'k-after-' + i })
  await settle(survivors, 10000)
  rpt('after repair + a further loss:', owner)
  console.log('   => repaired set still signs:', owner.base.indexedLength > at ? 'YES' : 'NO')
  console.log('\n   VERDICT: an over-indexed group', idx(owner) <= 3 && owner.base.indexedLength > at
    ? 'CAN be repaired in one coordinated moment.' : 'could NOT be repaired this way.')
}


;(async () => {
  await run('naive order', false)
  await run('batched', true)
  console.log('')
  await scenarioK()
  fs.rmSync(root, { recursive: true, force: true })
})().catch(e => { console.error('error:', e.message); process.exit(1) })
