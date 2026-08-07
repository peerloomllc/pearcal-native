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
// Scenario D: reopen a frozen base under the new apply -> does an update repair it?
// Scenario E: a FRESHLY paired device joins a frozen group -> what does it get?
//             This is the field symptom reported 2026-08-07: "you can see the
//             group, but thats it. No dates."
// Scenario F: the sole indexer goes away under the fix -> how bad is that?
//             This is the "indexer handoff" gap that closed PR #291.

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

  // D: the question that actually matters for an install already in this state.
  // Freeze a base under the OLD behaviour, then reopen the same storage with the
  // NEW behaviour, exactly as shipping an update does. The indexer set lives in
  // the base's own history, so the update cannot retroactively demote anyone.
  console.log('\n=== D: does the fix repair an ALREADY-frozen base? ===')
  const dName = 'legacy'
  const dStore1 = new Corestore(path.join(root, dName))
  await dStore1.ready()
  const dOld = new Autobase(dStore1, null, { open, apply: makeApply(true), valueEncoding: 'json' })
  await dOld.ready()

  const sib = await makeBase('legacy-sib', dOld.key, true)
  const s1 = dStore1.replicate(true)
  const s2 = sib.store.replicate(false)
  s1.pipe(s2).pipe(s1)
  await dOld.append({ addWriter: sib.base.local.key.toString('hex') })
  for (let i = 0; i < 30; i++) { await dOld.update().catch(() => {}); await new Promise(r => setTimeout(r, 60)) }
  for (let i = 0; i < 5; i++) await sib.base.append({ key: 'legacy-sib-' + i })
  for (let i = 0; i < 25; i++) { await dOld.update().catch(() => {}); await sib.base.update().catch(() => {}); await new Promise(r => setTimeout(r, 60)) }

  s1.destroy(); s2.destroy()
  await sib.base.close().catch(() => {}); await sib.store.close().catch(() => {})
  for (let i = 0; i < 5; i++) await dOld.append({ key: 'legacy-after-' + i })
  for (let i = 0; i < 25; i++) { await dOld.update().catch(() => {}); await new Promise(r => setTimeout(r, 60)) }
  const frozenAt = dOld.indexedLength
  console.log('under old behaviour: length', dOld.length, 'indexed', frozenAt)
  await dOld.close().catch(() => {})
  await dStore1.close().catch(() => {})

  // Ship the update: same storage, new apply that grants non-indexers.
  const dStore2 = new Corestore(path.join(root, dName))
  await dStore2.ready()
  const dNew = new Autobase(dStore2, null, { open, apply: makeApply(false), valueEncoding: 'json' })
  await dNew.ready()
  for (let i = 0; i < 5; i++) await dNew.append({ key: 'post-update-' + i })
  for (let i = 0; i < 25; i++) { await dNew.update().catch(() => {}); await new Promise(r => setTimeout(r, 60)) }
  const afterUpdate = dNew.indexedLength
  console.log('after the update:    length', dNew.length, 'indexed', afterUpdate)
  const repaired = afterUpdate > frozenAt
  console.log('the update repaired the frozen base:', repaired ? 'YES' : 'NO  <-- still stuck')
  await dNew.close().catch(() => {})
  await dStore2.close().catch(() => {})

  // E: the field symptom. A device that joins for the first time has no local
  // history, so it has nothing to advance optimistically FROM - it can only
  // fast-forward to what the signed view says. If the signed view froze before
  // most of the data was written, the newcomer gets the frozen prefix and
  // nothing after it. Reported 2026-08-07: paired a new desktop, the group
  // appeared, no events ever did.
  console.log('\n=== E: what does a FRESHLY paired device see on a frozen group? ===')
  const eOwner = await makeBase('e-owner', null, true)
  const eSib = await makeBase('e-sib', eOwner.base.key, true)
  const eUnlink = link(eOwner, eSib)
  await eOwner.base.append({ addWriter: eSib.base.local.key.toString('hex') })
  await settle([eOwner, eSib], 2000)

  // Early data, written while both are present, so it gets signed.
  for (let i = 0; i < 5; i++) await eOwner.base.append({ key: 'early-' + i })
  await settle([eOwner, eSib], 2000)
  const signedPrefix = eOwner.base.indexedLength

  // The sibling goes quiet - not dead, just a phone that is asleep.
  eUnlink()
  await eSib.base.close().catch(() => {})
  await eSib.store.close().catch(() => {})

  // The owner keeps adding events. Majority of 2 is 2, so none of this signs.
  for (let i = 0; i < 20; i++) await eOwner.base.append({ key: 'later-' + i })
  await settle([eOwner], 2500)
  console.log('owner:      length', eOwner.base.length, 'indexed', eOwner.base.indexedLength,
    '(' + (eOwner.base.length - eOwner.base.indexedLength) + ' entries stranded in the un-indexed tail)')

  // Now a brand new device pairs in and replicates with the owner only.
  const eNew = await makeBase('e-new', eOwner.base.key, true)
  const eUnlink2 = link(eOwner, eNew)
  await settle([eOwner, eNew], 4000)

  let newcomerSees = 0
  try {
    const v = eNew.base.view
    newcomerSees = v ? v.length : 0
  } catch { newcomerSees = -1 }
  console.log('newcomer:   length', eNew.base.length, 'indexed', eNew.base.indexedLength,
    '| entries visible in its view:', newcomerSees)
  const ownerSees = eOwner.base.view ? eOwner.base.view.length : 0
  console.log('owner sees', ownerSees, 'entries; newcomer sees', newcomerSees)
  const newcomerStarved = newcomerSees < ownerSees
  console.log('newcomer is missing data the owner has:', newcomerStarved ? 'YES  <-- the field symptom' : 'NO')

  eUnlink2()
  await eNew.base.close().catch(() => {}); await eNew.store.close().catch(() => {})
  await eOwner.base.close().catch(() => {}); await eOwner.store.close().catch(() => {})

  // F: the cost of the fix. With non-indexer writers the bootstrap device is the
  // ONLY indexer, so majority is 1 and nothing can freeze it - but if that
  // device is lost, no remaining writer can sign anything. This is the handoff
  // gap that closed PR #291, quantified rather than assumed.
  console.log('\n=== F: the fix\'s own risk - the sole indexer goes away ===')
  const fOwner = await makeBase('f-owner', null, false)
  const fMember = await makeBase('f-member', fOwner.base.key, false)
  const fUnlink = link(fOwner, fMember)
  await fOwner.base.append({ addWriter: fMember.base.local.key.toString('hex') })
  await settle([fOwner, fMember], 2000)
  for (let i = 0; i < 5; i++) await fOwner.base.append({ key: 'f-early-' + i })
  await settle([fOwner, fMember], 2000)
  const fBefore = fMember.base.indexedLength
  console.log('member before owner leaves: length', fMember.base.length, 'indexed', fBefore)

  // The owner is gone for good.
  fUnlink()
  await fOwner.base.close().catch(() => {}); await fOwner.store.close().catch(() => {})

  const fCanWrite = fMember.base.writable
  for (let i = 0; i < 10; i++) await fMember.base.append({ key: 'f-orphan-' + i }).catch(() => {})
  await settle([fMember], 2500)
  console.log('member after  owner leaves: length', fMember.base.length, 'indexed', fMember.base.indexedLength)
  console.log('member can still author writes:', fCanWrite ? 'YES' : 'NO')
  const fSignsAlone = fMember.base.indexedLength > fBefore
  console.log('member can sign anything on its own:', fSignsAlone ? 'YES' : 'NO  <-- needs an indexer handoff')
  await fMember.base.close().catch(() => {}); await fMember.store.close().catch(() => {})

  console.log('\n---------------- RESULT ----------------')
  console.log('A (all indexers)      advanced after loss:', a.advanced ? 'YES' : 'NO')
  console.log('B (non-indexer writer) advanced after loss:', b.advanced ? 'YES' : 'NO')
  console.log('C (removeWriter recovery):', recovered === null ? 'n/a' : (recovered ? 'WORKS' : 'DOES NOT WORK'))
  console.log('D (update repairs an already-frozen base):', repaired ? 'YES' : 'NO')
  console.log('E (newcomer starved by a frozen view):', newcomerStarved ? 'YES' : 'NO')
  console.log('F (a lone remaining member can sign):', fSignsAlone ? 'YES' : 'NO - handoff needed')
  console.log('')
  console.log(!a.advanced && b.advanced
    ? 'FIX VALIDATED: the freeze reproduces on current behaviour and does not occur with non-indexer writers.'
    : 'INCONCLUSIVE: see the numbers above before changing any product code.')

  fs.rmSync(root, { recursive: true, force: true })
}

main().catch(e => { console.error('harness error:', e); process.exit(1) })
