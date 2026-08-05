// Does making every writer an indexer freeze the signed view, and does adding
// them as plain writers fix it?
//
// Plan: docs/superpowers/plans/2026-06-03-indexer-model-fix.md, which requires a
// deterministic harness BEFORE any code change, because this is a consensus bug
// and device cycles are too slow and flaky to settle one.
//
// Confirmed live on 2026-08-05 (project_autobase_drain_spin): a real install had
// 7 writers, all indexers, several of them dead devices, with length 1021 and
// indexedLength stuck at 849 while a core burned for 16 minutes.
//
//   node test/harness/indexer-model.js
//
// Scenario A: all-indexers, one disappears  -> does the signed view freeze?
// Scenario B: non-indexer writers           -> does it keep advancing?
// Scenario C: removeWriter on a frozen base -> does it un-stick? (Recovery
//             option 1 in the plan, flagged there as an open question.)

const Autobase = require('autobase')
const Corestore = require('corestore')
const os = require('os')
const path = require('path')
const fs = require('fs')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idx-model-'))
let caseNo = 0

function open (store) {
  return store.get('view', { valueEncoding: 'json' })
}

// Mirrors src/bare.js: apply() decides indexer-ness when it grants a writer.
function makeApply (asIndexer) {
  return async function apply (nodes, view, host) {
    for (const node of nodes) {
      const v = node.value
      if (!v) continue
      if (v.addWriter) {
        await host.addWriter(Buffer.from(v.addWriter, 'hex'), { indexer: asIndexer })
        continue
      }
      if (v.removeWriter) {
        await host.removeWriter(Buffer.from(v.removeWriter, 'hex'))
        continue
      }
      if (v.key) await view.append({ k: v.key })
    }
  }
}

async function makeBase (name, key, asIndexer) {
  const store = new Corestore(path.join(root, name + '-' + (++caseNo)))
  await store.ready()
  const base = new Autobase(store, key, { open, apply: makeApply(asIndexer), valueEncoding: 'json' })
  await base.ready()
  return { store, base }
}

function link (a, b) {
  const s1 = a.store.replicate(true)
  const s2 = b.store.replicate(false)
  s1.pipe(s2).pipe(s1)
  return () => { s1.destroy(); s2.destroy() }
}

async function settle (bases, ms = 1500) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    for (const b of bases) await b.base.update().catch(() => {})
    await new Promise(r => setTimeout(r, 100))
  }
}

async function scenario (label, asIndexer) {
  console.log('\n=== ' + label + ' ===')

  const primary = await makeBase('primary', null, asIndexer)
  const sibling = await makeBase('sibling', primary.base.key, asIndexer)

  const unlink = link(primary, sibling)
  await primary.base.append({ addWriter: sibling.base.local.key.toString('hex') })
  await settle([primary, sibling], 2000)

  console.log('sibling writable:', sibling.base.writable)

  // The sibling authors data while it is alive, and the primary applies it.
  for (let i = 0; i < 5; i++) await sibling.base.append({ key: 'sib-' + i })
  for (let i = 0; i < 5; i++) await primary.base.append({ key: 'pri-' + i })
  await settle([primary, sibling], 2500)

  const before = { len: primary.base.length, idx: primary.base.indexedLength }
  console.log('before loss:   length', before.len, 'indexed', before.idx,
    '| indexers', primary.base.linearizer?.indexers?.length)

  // The sibling is wiped: it stops replicating and never acks again.
  unlink()
  await sibling.base.close().catch(() => {})
  await sibling.store.close().catch(() => {})

  // The primary keeps working on its own.
  for (let i = 0; i < 10; i++) await primary.base.append({ key: 'after-' + i })
  await settle([primary], 2500)

  const after = { len: primary.base.length, idx: primary.base.indexedLength }
  const advanced = after.idx > before.idx
  console.log('after loss:    length', after.len, 'indexed', after.idx)
  console.log('signed view advanced after losing the other device:', advanced ? 'YES' : 'NO  <-- frozen')

  return { primary, before, after, advanced }
}

async function main () {
  // A: what ships today.
  const a = await scenario('A: every writer an indexer (current behaviour)', true)

  // C: can a frozen base be recovered by removing the dead indexer? The plan
  // flags this as unknown and warns it may be gated by the very majority it
  // cannot reach.
  console.log('\n=== C: removeWriter on the frozen base (recovery option 1) ===')
  let recovered = null
  if (!a.advanced) {
    const deadKey = a.primary.base.activeWriters
      ? [...a.primary.base.activeWriters].map(w => w.core?.key?.toString('hex')).filter(Boolean)
      : []
    console.log('writers seen by the primary:', deadKey.length)
    const idxBefore = a.primary.base.indexedLength
    // Remove every writer that is not us, i.e. the dead one.
    const meHex = a.primary.base.local.key.toString('hex')
    for (const k of deadKey) {
      if (k === meHex) continue
      await a.primary.base.append({ removeWriter: k }).catch(e => console.log('  append removeWriter failed:', e.message))
    }
    await settle([a.primary], 3000)
    recovered = a.primary.base.indexedLength > idxBefore
    console.log('indexed', idxBefore, '->', a.primary.base.indexedLength)
    console.log('removeWriter un-stuck the frozen base:', recovered ? 'YES' : 'NO')
  } else {
    console.log('skipped, scenario A did not freeze')
  }

  await a.primary.base.close().catch(() => {})
  await a.primary.store.close().catch(() => {})

  // B: the proposed fix.
  const b = await scenario('B: siblings as plain writers (the fix)', false)
  await b.primary.base.close().catch(() => {})
  await b.primary.store.close().catch(() => {})

  console.log('\n---------------- RESULT ----------------')
  console.log('A (all indexers)      advanced after loss:', a.advanced ? 'YES' : 'NO')
  console.log('B (non-indexer writer) advanced after loss:', b.advanced ? 'YES' : 'NO')
  console.log('C (removeWriter recovery):', recovered === null ? 'n/a' : (recovered ? 'WORKS' : 'DOES NOT WORK'))
  console.log('')
  console.log(!a.advanced && b.advanced
    ? 'FIX VALIDATED: the freeze reproduces on current behaviour and does not occur with non-indexer writers.'
    : 'INCONCLUSIVE: see the numbers above before changing any product code.')

  fs.rmSync(root, { recursive: true, force: true })
}

main().catch(e => { console.error('harness error:', e); process.exit(1) })
