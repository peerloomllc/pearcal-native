// Standalone integration test for Phase 2a of the group-rekey migration:
// marker build/verify + old-base apply-fn gate.
//
//   node tools/test-rekey-phase2a.js
//
// Exits non-zero on failure. Uses a temp-dir Corestore that is wiped on
// startup and on exit so runs are hermetic.
//
// This test does NOT load src/bare.js (which depends on BareKit); instead it
// pulls in the pure src/lib/migration.js + src/lib/rekey.js helpers and
// simulates the production apply-fn gate with a hand-rolled equivalent.

const fs        = require('fs')
const os        = require('os')
const path      = require('path')
const Corestore = require('corestore')
const Autobase  = require('autobase')
const Hyperbee  = require('hyperbee')
const sodium    = require('sodium-native')
const b4a       = require('b4a')

const { rekeyGroup, NS } = require('../src/lib/rekey.js')
const {
  MARKER_VERSION,
  markerKey,
  buildMarker,
  verifyMarker,
  readMarker,
} = require('../src/lib/migration.js')

let failed = 0
function check (name, ok, detail) {
  if (ok) console.log('  ok  ', name)
  else { failed++; console.log('  FAIL', name, detail ? '— ' + detail : '') }
}

// Production-shaped apply fn: writer add, marker handling with signature
// verification, migration gate, ordinary put. Shares the migratedGroups set
// with the test for assertion of gate state.
function makeMarkerAwareApply (groupId, migratedGroups) {
  return async function apply (nodes, view, host) {
    for (const node of nodes) {
      const val = node.value
      if (!val) continue

      if (val.addWriter) {
        if (migratedGroups.has(groupId)) continue
        await host.addWriter(b4a.from(val.addWriter, 'hex'), { indexer: true })
        continue
      }

      // Marker node — verified and gated like bare.js does.
      if (val.op === 'put' && val.type === 'migration' && val.key === markerKey(groupId)) {
        const existing = await view.get(val.key).catch(() => null)
        if (!existing) {
          const groupNode = await view.get(NS.groups + groupId).catch(() => null)
          const expectedOwnerId = groupNode?.value?.ownerId
          const ok = verifyMarker(val.value, {
            expectedOwnerId,
            expectedOldGroupId: groupId,
          })
          if (ok) {
            await view.put(val.key, val.value)
            migratedGroups.add(groupId)
          }
        }
        continue
      }

      if (migratedGroups.has(groupId)) continue

      if (val.op === 'put') await view.put(val.key, val.value)
    }
  }
}

function makeProfile () {
  const pk = b4a.allocUnsafe(sodium.crypto_sign_PUBLICKEYBYTES)
  const sk = b4a.allocUnsafe(sodium.crypto_sign_SECRETKEYBYTES)
  sodium.crypto_sign_keypair(pk, sk)
  const hex = b4a.toString(pk, 'hex')
  return { id: hex, publicKey: hex, secretKey: b4a.toString(sk, 'hex') }
}

async function run () {
  console.log('setup')
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pearcal-rekey-p2a-'))
  process.on('exit', () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {} })

  const store = new Corestore(tmpDir)
  await store.ready()

  const ownerProfile = makeProfile()
  const otherProfile = makeProfile()
  const oldGroupId = 'gOLD2A'
  const migratedGroups = new Set()

  const oldStore = store.namespace(oldGroupId)
  const oldBase = new Autobase(oldStore, null, {
    valueEncoding: 'json',
    open: (s) => new Hyperbee(s.get('view'), { keyEncoding: 'utf-8', valueEncoding: 'json' }),
    apply: makeMarkerAwareApply(oldGroupId, migratedGroups),
  })
  await oldBase.ready()
  await oldBase.append({ addWriter: b4a.toString(oldBase.local.key, 'hex') })

  // Seed group record owned by ownerProfile
  await oldBase.append({
    op: 'put', type: 'group', key: NS.groups + oldGroupId,
    value: {
      id: oldGroupId,
      name: 'Old',
      ownerId: ownerProfile.id,
      groupKey: b4a.toString(oldBase.key, 'hex'),
      members: [{ id: ownerProfile.id, name: 'Owner' }],
      updatedAt: 100,
    },
  })
  // One event
  await oldBase.append({
    op: 'put', type: 'event', key: 'events:2026-04-16:e1',
    value: { id: 'e1', title: 'Pre-migration', date: '2026-04-16', groups: [oldGroupId], updatedAt: 200 },
  })
  await oldBase.update()

  console.log('phase 1 replay')
  const newGroupId = 'gNEW2A'
  const { newBase, descriptor } = await rekeyGroup({
    oldBase, oldGroupId, newGroupId, store,
  })
  check('descriptor carries newGroupId', descriptor.newGroupId === newGroupId)
  check('descriptor.newGroupKey looks right',
    /^[0-9a-f]{64}$/.test(descriptor.newGroupKey))

  console.log('pure marker helpers')
  const marker = buildMarker(descriptor, ownerProfile)
  check('marker has v=1', marker.v === MARKER_VERSION)
  check('marker.ownerId matches profile', marker.ownerId === ownerProfile.id)
  check('marker.ownerPubKey matches profile', marker.ownerPubKey === ownerProfile.publicKey)
  check('marker has sig', typeof marker.sig === 'string' && marker.sig.length > 0)
  check('verifyMarker accepts fresh marker',
    verifyMarker(marker, { expectedOwnerId: ownerProfile.id, expectedOldGroupId: oldGroupId }))
  check('verifyMarker rejects wrong-owner',
    !verifyMarker(marker, { expectedOwnerId: otherProfile.id, expectedOldGroupId: oldGroupId }))
  check('verifyMarker rejects wrong oldGroupId',
    !verifyMarker(marker, { expectedOwnerId: ownerProfile.id, expectedOldGroupId: 'gBOGUS' }))
  // Tamper: flip newGroupKey (a byte)
  const tampered = { ...marker, newGroupKey: '00' + marker.newGroupKey.slice(2) }
  check('verifyMarker rejects tampered payload',
    !verifyMarker(tampered, { expectedOwnerId: ownerProfile.id, expectedOldGroupId: oldGroupId }))
  // Wrong signer
  const forged = buildMarker(descriptor, otherProfile)
  check('verifyMarker rejects marker signed by non-owner when owner pinned',
    !verifyMarker(forged, { expectedOwnerId: ownerProfile.id, expectedOldGroupId: oldGroupId }))
  // Sanity: unsigned marker rejected
  const { sig: _drop, ...noSig } = marker
  check('verifyMarker rejects unsigned marker',
    !verifyMarker(noSig, { expectedOwnerId: ownerProfile.id, expectedOldGroupId: oldGroupId }))
  // Version mismatch
  check('verifyMarker rejects wrong version',
    !verifyMarker({ ...marker, v: 999 }, { expectedOwnerId: ownerProfile.id, expectedOldGroupId: oldGroupId }))

  console.log('marker applied to old base view')
  await oldBase.append({ op: 'put', type: 'migration', key: markerKey(oldGroupId), value: marker })
  await oldBase.update()

  const read = await readMarker(oldBase.view, oldGroupId)
  check('readMarker returns the stored marker', !!read && read.sig === marker.sig)
  check('stored marker verifies',
    verifyMarker(read, { expectedOwnerId: ownerProfile.id, expectedOldGroupId: oldGroupId }))
  check('apply populated migratedGroups', migratedGroups.has(oldGroupId))

  console.log('apply gate swallows subsequent writes')
  await oldBase.append({
    op: 'put', type: 'event', key: 'events:2026-04-17:e2-ghost',
    value: { id: 'e2', title: 'Post-migration ghost', date: '2026-04-17', groups: [oldGroupId], updatedAt: 500 },
  })
  await oldBase.update()
  const ghost = await oldBase.view.get('events:2026-04-17:e2-ghost').catch(() => null)
  check('post-marker event not present in old view', !ghost)
  // Pre-marker event still there
  const preEvent = await oldBase.view.get('events:2026-04-16:e1')
  check('pre-marker event still in old view', preEvent?.value?.title === 'Pre-migration')

  console.log('forged marker rejected by gate')
  // Build a new test group where we try to slip in a forged marker first.
  const oldGroupId2 = 'gOLD2B'
  const gated2 = new Set()
  const oldStore2 = store.namespace(oldGroupId2)
  const oldBase2 = new Autobase(oldStore2, null, {
    valueEncoding: 'json',
    open: (s) => new Hyperbee(s.get('view'), { keyEncoding: 'utf-8', valueEncoding: 'json' }),
    apply: makeMarkerAwareApply(oldGroupId2, gated2),
  })
  await oldBase2.ready()
  await oldBase2.append({ addWriter: b4a.toString(oldBase2.local.key, 'hex') })
  await oldBase2.append({
    op: 'put', type: 'group', key: NS.groups + oldGroupId2,
    value: {
      id: oldGroupId2, ownerId: ownerProfile.id,
      groupKey: b4a.toString(oldBase2.key, 'hex'),
      members: [{ id: ownerProfile.id, name: 'Owner' }],
      updatedAt: 1,
    },
  })
  await oldBase2.update()
  // Forged by `otherProfile` targeting oldGroupId2 whose real owner is ownerProfile.
  const forged2 = buildMarker({
    oldGroupId: oldGroupId2,
    newGroupId: 'gFORGE',
    newGroupKey: '00'.repeat(32),
    preparedAt: Date.now(),
  }, otherProfile)
  await oldBase2.append({ op: 'put', type: 'migration', key: markerKey(oldGroupId2), value: forged2 })
  await oldBase2.update()
  const forgedRead = await oldBase2.view.get(markerKey(oldGroupId2)).catch(() => null)
  check('forged marker not accepted into view', !forgedRead)
  check('forged marker did not flip gate', !gated2.has(oldGroupId2))
  // Subsequent legit writes still land
  await oldBase2.append({
    op: 'put', type: 'event', key: 'events:2026-04-18:e-legit',
    value: { id: 'e-legit', title: 'Still writable', date: '2026-04-18', groups: [oldGroupId2], updatedAt: 2 },
  })
  await oldBase2.update()
  const legit = await oldBase2.view.get('events:2026-04-18:e-legit')
  check('legit write still accepted after forged-marker rejection',
    legit?.value?.title === 'Still writable')

  console.log('restart detection: reopened base sees marker in view')
  await oldBase.close()
  // A fresh Autobase over the same store should retain the view, including the
  // marker from earlier. Simulates app restart after Phase 2a commit.
  const reopenedGated = new Set()
  const reopened = new Autobase(store.namespace(oldGroupId), null, {
    valueEncoding: 'json',
    open: (s) => new Hyperbee(s.get('view'), { keyEncoding: 'utf-8', valueEncoding: 'json' }),
    apply: makeMarkerAwareApply(oldGroupId, reopenedGated),
  })
  await reopened.ready()
  const reopenedMarker = await readMarker(reopened.view, oldGroupId)
  check('reopened base has marker in view', !!reopenedMarker && reopenedMarker.newGroupId === newGroupId)
  check('reopened base marker still verifies',
    verifyMarker(reopenedMarker, { expectedOwnerId: ownerProfile.id, expectedOldGroupId: oldGroupId }))
  await reopened.close()
  await oldBase2.close()
  await newBase.close()

  console.log('')
  if (failed > 0) {
    console.log(failed + ' assertion(s) FAILED')
    process.exit(1)
  }
  console.log('all assertions passed')
  process.exit(0)
}

run().catch(e => {
  console.error('test crashed:', e)
  process.exit(1)
})
