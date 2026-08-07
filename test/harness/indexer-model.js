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
// Scenario G: does fault tolerance actually appear at 3 indexers, as the
//             majority arithmetic says it should? 3 indexers tolerate 1 loss
//             (majority 2), where 2 indexers tolerate none (majority 2 of 2).
//             The counterintuitive consequence is that TWO indexers are
//             strictly WORSE than one.

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
  // ackInterval MUST match src/bare.js (1000). Autobase's default is 10_000,
  // and an indexer only signs a majority into place via that background ack.
  // With the default, any scenario that settles for less than 10s reports
  // FROZEN for a base that was merely still waiting to ack - which is exactly
  // how an early scenario G wrongly showed 3 indexers failing to tolerate a
  // loss they in fact tolerate.
  const base = new Autobase(store, key, { open, apply: makeApply(asIndexer), valueEncoding: 'json', ackInterval: 1000 })
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
  // The criterion is deliberately precise, because two looser ones are wrong:
  //   "did indexedLength move?"  - it moves anyway, working through history the
  //      departed device had ALREADY acked before leaving. Reports a false pass.
  //   "did it reach length?"     - it never quite does. The newest nodes are
  //      always unsigned until the next ack round, even on a perfectly healthy
  //      base. Reports a false fail.
  // What actually matters: was any work authored AFTER the loss signed?
  const advanced = after.idx > before.len
  console.log('after loss:    length', after.len, 'indexed', after.idx,
    '| signed past the point of loss (' + before.len + '):', advanced ? 'yes' : 'NO')
  console.log('signed view kept advancing after losing the other device:', advanced ? 'YES' : 'NO  <-- frozen')

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

  // G: the count is not monotonic. Majority of 1 is 1, of 2 is 2, of 3 is 2.
  // So going from one indexer to two buys nothing and costs availability, while
  // going to three buys the first real redundancy. Assert autobase agrees with
  // that arithmetic rather than assuming it.
  console.log('\n=== G: is 3 indexers genuinely fault-tolerant where 2 is not? ===')

  async function nIndexerLossTest (label, peerCount, loseCount) {
    const owner = await makeBase('g-owner', null, true)
    const peers = []
    for (let i = 1; i < peerCount; i++) peers.push(await makeBase('g-peer' + i, owner.base.key, true))
    const all = [owner, ...peers]
    const unlinks = []
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) unlinks.push(link(all[i], all[j]))
    }
    // Add them ONE AT A TIME and wait for each to land. Adding the 2nd indexer
    // moves majority from 1 to 2, so the 3rd addWriter cannot linearize until
    // the 2nd is acking. Appending them back to back and settling once left the
    // set at 2 and quietly tested the wrong thing.
    for (const p of peers) {
      await owner.base.append({ addWriter: p.base.local.key.toString('hex') })
      for (let t = 0; t < 120; t++) {
        await settle(all, 250)
        if ((owner.base.linearizer?.indexers?.length || 0) >= 2 + peers.indexOf(p)) break
      }
    }
    await settle(all, 2500)
    const got = owner.base.linearizer?.indexers?.length || 0
    if (got !== peerCount) {
      console.log('  ' + label.padEnd(34) + 'SETUP FAILED: wanted ' + peerCount + ' indexers, got ' + got)
      for (const u of unlinks) u()
      for (const x of all) { await x.base.close().catch(() => {}); await x.store.close().catch(() => {}) }
      return null
    }

    for (let i = 0; i < 5; i++) await owner.base.append({ key: 'g-early-' + i })
    await settle(all, 2500)
    const idxCount = owner.base.linearizer?.indexers?.length
    const before = owner.base.indexedLength

    // Lose `loseCount` of them.
    for (const u of unlinks) u()
    const lost = peers.slice(0, loseCount)
    for (const p of lost) { await p.base.close().catch(() => {}); await p.store.close().catch(() => {}) }
    const survivors = [owner, ...peers.slice(loseCount)]
    for (let i = 0; i < survivors.length; i++) {
      for (let j = i + 1; j < survivors.length; j++) link(survivors[i], survivors[j])
    }

    const lenAtLoss = owner.base.length
    for (let i = 0; i < 10; i++) await owner.base.append({ key: 'g-after-' + i })
    await settle(survivors, 12000)
    const after = owner.base.indexedLength
    const advanced = after > lenAtLoss               // signed work authored AFTER the loss
    console.log('  ' + label.padEnd(34) +
      'indexers=' + idxCount + ' majority=' + (Math.floor(idxCount / 2) + 1) +
      ' lost=' + loseCount + '  indexed ' + before + ' -> ' + after +
      ' (loss at ' + lenAtLoss + ', now ' + owner.base.length + ')' +
      '  ' + (advanced ? 'KEEPS SIGNING' : 'FROZEN at the point of loss'))
    for (const p of survivors) { await p.base.close().catch(() => {}); await p.store.close().catch(() => {}) }
    for (const p of survivors) { await p.store.close().catch(() => {}) }
    return advanced
  }

  const g2 = await nIndexerLossTest('2 indexers, lose 1:', 2, 1)
  const g3 = await nIndexerLossTest('3 indexers, lose 1:', 3, 1)
  const g3b = await nIndexerLossTest('3 indexers, lose 2:', 3, 2)
  const say = v => v === null ? 'SETUP FAILED' : (v ? 'YES' : 'NO')
  console.log('  => two indexers tolerate a loss:', say(g2))
  console.log('  => three tolerate one loss:      ', say(g3))
  console.log('  => three tolerate two losses:    ', say(g3b))

  console.log('\n---------------- RESULT ----------------')
  console.log('A (all indexers)      advanced after loss:', a.advanced ? 'YES' : 'NO')
  console.log('B (non-indexer writer) advanced after loss:', b.advanced ? 'YES' : 'NO')
  console.log('C (removeWriter recovery):', recovered === null ? 'n/a' : (recovered ? 'WORKS' : 'DOES NOT WORK'))
  console.log('D (update repairs an already-frozen base):', repaired ? 'YES' : 'NO')
  console.log('E (newcomer starved by a frozen view):', newcomerStarved ? 'YES' : 'NO')
  console.log('F (a lone remaining member can sign):', fSignsAlone ? 'YES' : 'NO - handoff needed')
  console.log('G (redundancy appears at 3, not 2):', (!g2 && g3 && !g3b) ? 'CONFIRMED' : 'see numbers above')
  console.log('')
  console.log(!a.advanced && b.advanced
    ? 'FIX VALIDATED: the freeze reproduces on current behaviour and does not occur with non-indexer writers.'
    : 'INCONCLUSIVE: see the numbers above before changing any product code.')

  fs.rmSync(root, { recursive: true, force: true })
}

main().catch(e => { console.error('harness error:', e); process.exit(1) })
