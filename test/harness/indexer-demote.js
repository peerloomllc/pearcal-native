// Can a signer be DEMOTED with the op every v2 peer already reads? (TODO #159)
//
//   node test/harness/indexer-demote.js
//
// indexer-rule.js J and K take signers off the list with `removeWriter`, which
// PearCal's apply() does not handle, so using it would need a new op and a
// second gated release. Autobase's system.add() also accepts an EXISTING
// indexer with isIndexer false and drops it from the indexer set
// (autobase/lib/system.js _updateIndexer). That is `{ addWriter: k,
// indexer: false }`, which release N (v1.0.43) already reads. If demotion
// works, the swap and the repair need no new op at all.
//
// L: K's repair, 7 -> 3, done by demotion instead of removal.
// M: J's swap, 3 with one gone, demote the dead one and promote a live one in
//    one batch.
// N: the demoted device comes back. It must still be able to write, must agree
//    it is no longer a signer, and the group must keep signing.
const M = '/home/tim/peerloomllc/pearcal-native/node_modules/'
const Autobase = require(M + 'autobase')
const Corestore = require(M + 'corestore')
const os = require('os'), path = require('path'), fs = require('fs')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'demote-'))
const open = s => s.get('view', { valueEncoding: 'json' })

// Same shape as PearCal's group apply: addWriter with the indexer field read
// default-true, and NO removeWriter branch.
async function apply (nodes, view, host) {
  for (const node of nodes) {
    const v = node.value
    if (!v) continue
    if (v.addWriter) { await host.addWriter(Buffer.from(v.addWriter, 'hex'), { indexer: v.indexer !== false }); continue }
    if (v.key) await view.append({ k: v.key })
  }
}
async function mk (name, key) {
  const store = new Corestore(path.join(root, name))
  await store.ready()
  const base = new Autobase(store, key, { open, apply, valueEncoding: 'json', ackInterval: 1000 })
  await base.ready()
  return { name, store, base }
}
function link (a, b) {
  const s1 = a.store.replicate(true), s2 = b.store.replicate(false)
  s1.pipe(s2).pipe(s1); return () => { s1.destroy(); s2.destroy() }
}
function linkAll (group) {
  for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) link(group[i], group[j])
}
async function settle (bs, ms) {
  const end = Date.now() + ms
  while (Date.now() < end) { for (const b of bs) await b.base.update().catch(() => {}); await new Promise(r => setTimeout(r, 80)) }
}
const idx = o => o.base.linearizer?.indexers?.length
const rpt = (t, o) => console.log('   ' + t.padEnd(32) + 'indexers=' + idx(o) + ' indexed=' + o.base.indexedLength + '/' + o.base.length)
const hex = o => o.base.local.key.toString('hex')
const close = async o => { await o.base.close().catch(() => {}); await o.store.close().catch(() => {}) }
async function signs (o, group, tag) {
  const at = o.base.indexedLength
  for (let i = 0; i < 5; i++) await o.base.append({ key: tag + '-' + i })
  await settle(group, 8000)
  return o.base.indexedLength > at
}
let failed = 0
function check (label, ok) {
  console.log('   => ' + label + ': ' + (ok ? 'YES' : 'NO'))
  if (!ok) failed++
}

async function scenarioL () {
  console.log('\n=== L: repair 7 -> 3 by DEMOTION, no removeWriter ===')
  const owner = await mk('l-owner', null)
  const peers = []
  for (let i = 1; i < 7; i++) peers.push(await mk('l-p' + i, owner.base.key))
  const all = [owner, ...peers]
  linkAll(all)
  // Build the group the way PearCal does today: everyone an indexer.
  for (const p of peers) {
    await owner.base.append({ addWriter: hex(p) })
    for (let t = 0; t < 80; t++) { await settle(all, 250); if (idx(owner) >= 2 + peers.indexOf(p)) break }
  }
  await settle(all, 5000)
  rpt('today: everyone an indexer', owner)
  if (idx(owner) !== 7) { console.log('   SETUP FAILED, only got', idx(owner)); failed++; return }

  const sleepers = peers.slice(3)
  for (const s of sleepers) await close(s)
  const awake = [owner, ...peers.slice(0, 3)]
  check('4 of 7 awake still signs', await signs(owner, awake, 'l-damaged'))

  const drop = [...sleepers.map(hex), hex(peers[2])]
  await owner.base.append(drop.map(k => ({ addWriter: k, indexer: false })))
  await settle(awake, 12000)
  rpt('after the demotion batch:', owner)
  check('down to 3 signers', idx(owner) === 3)
  check('every awake peer agrees on 3', awake.every(o => idx(o) === 3))

  // peers[2] was demoted while awake: it must still be a writer.
  const len = owner.base.length
  await peers[2].base.append({ key: 'from-demoted' })
  await settle(awake, 6000)
  check('demoted device can still write', owner.base.length > len)

  await close(peers[2])
  const survivors = [owner, peers[0], peers[1]]
  check('3 signers survive losing one more device', await signs(owner, survivors, 'l-after'))
  for (const o of survivors) await close(o)
}

async function scenarioMN () {
  console.log('\n=== M: swap a dead signer for a live one, by demotion ===')
  const owner = await mk('m-owner', null)
  const a = await mk('m-a', owner.base.key)
  let b = await mk('m-b', owner.base.key)
  const c = await mk('m-c', owner.base.key)
  linkAll([owner, a, b, c])
  const bKey = hex(b)
  await owner.base.append([{ addWriter: hex(a) }, { addWriter: bKey }, { addWriter: hex(c), indexer: false }])
  for (let t = 0; t < 80; t++) { await settle([owner, a, b, c], 250); if (idx(owner) === 3) break }
  rpt('3 signers + 1 plain writer:', owner)
  if (idx(owner) !== 3) { console.log('   SETUP FAILED'); failed++; return }

  await close(b)
  const live = [owner, a, c]
  check('2 of 3 still signs with b gone', await signs(owner, live, 'm-loss'))

  await owner.base.append([{ addWriter: hex(c), indexer: true }, { addWriter: bKey, indexer: false }])
  await settle(live, 10000)
  rpt('after swap:', owner)
  check('still 3 signers', idx(owner) === 3)
  check('all live peers agree', live.every(o => idx(o) === 3))
  check('signs after the swap', await signs(owner, live, 'm-swap'))

  console.log('\n=== N: the demoted device comes back ===')
  b = await mk('m-b', owner.base.key)
  check('reopened as the same writer', hex(b) === bKey)
  linkAll([owner, a, c, b])
  const group = [owner, a, c, b]
  await settle(group, 8000)
  rpt('b back, caught up:', b)
  check('b agrees there are 3 signers', idx(b) === 3)
  check('b is not one of them', !b.base.isIndexer)
  const len = owner.base.length
  await b.base.append({ key: 'b-returns' })
  await settle(group, 6000)
  check('b can still write', owner.base.length > len)
  check('group still signs with b back', await signs(owner, group, 'n-after'))
  for (const o of group) await close(o)
}

;(async () => {
  await scenarioL()
  await scenarioMN()
  fs.rmSync(root, { recursive: true, force: true })
  console.log('\n' + (failed ? 'FAILED: ' + failed + ' check(s)' : 'ALL CHECKS PASSED'))
  process.exit(failed ? 1 : 0)
})().catch(e => { console.error('error:', e.stack); process.exit(1) })
