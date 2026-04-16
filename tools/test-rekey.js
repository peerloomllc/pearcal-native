// Standalone integration test for src/lib/rekey.js.
//   node tools/test-rekey.js
// Exits non-zero on failure. Uses a temp-dir Corestore that is wiped on
// startup and on exit so runs are hermetic.

const fs        = require('fs')
const os        = require('os')
const path      = require('path')
const Corestore = require('corestore')
const Autobase  = require('autobase')
const Hyperbee  = require('hyperbee')
const b4a       = require('b4a')

const { rekeyGroup, NS } = require('../src/lib/rekey.js')

let failed = 0
function check (name, ok, detail) {
  if (ok) console.log('  ok  ', name)
  else { failed++; console.log('  FAIL', name, detail ? '— ' + detail : '') }
}

// Minimal apply that matches what the old group actually runs in production:
// addWriter + op:put into the view. Used by the "old" test base below.
function makeApply () {
  return async function apply (nodes, view, host) {
    for (const node of nodes) {
      const val = node.value
      if (!val) continue
      if (val.addWriter) {
        await host.addWriter(b4a.from(val.addWriter, 'hex'), { indexer: true })
        continue
      }
      if (val.op === 'put') await view.put(val.key, val.value)
    }
  }
}

async function run () {
  console.log('building old group')

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pearcal-rekey-'))
  process.on('exit', () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {} })

  const store = new Corestore(tmpDir)
  await store.ready()

  const oldGroupId = 'gOLDXX1'
  const oldStore   = store.namespace(oldGroupId)
  const oldBase    = new Autobase(oldStore, null, {
    valueEncoding: 'json',
    open: (s) => new Hyperbee(s.get('view'), { keyEncoding: 'utf-8', valueEncoding: 'json' }),
    apply: makeApply(),
  })
  await oldBase.ready()

  const oldWriterKey = b4a.toString(oldBase.local.key, 'hex')
  await oldBase.append({ addWriter: oldWriterKey })

  // Seed avatars
  await oldBase.append({
    op: 'put', type: 'avatar',
    key: NS.avatars + 'hashA',
    value: { data: 'data:image/png;base64,AAA', mime: 'image/png', bytes: 3, updatedAt: 100 },
  })
  await oldBase.append({
    op: 'put', type: 'avatar',
    key: NS.avatars + 'hashB',
    value: { data: 'data:image/png;base64,BBB', mime: 'image/png', bytes: 3, updatedAt: 101 },
  })

  // Seed group record with members (hash-only avatars)
  const groupValue = {
    id: oldGroupId,
    name: 'Old Group',
    ownerId: 'ownerPubkey',
    groupKey: b4a.toString(oldBase.key, 'hex'),
    members: [
      { id: 'ownerPubkey', name: 'Owner', avatar: 'hashA' },
      { id: 'alicePubkey', name: 'Alice', avatar: 'hashB' },
    ],
    color: '#aabbcc',
    updatedAt: 200,
  }
  await oldBase.append({
    op: 'put', type: 'group',
    key: NS.groups + oldGroupId,
    value: groupValue,
  })

  // Seed events: one single-group, one multi-group
  await oldBase.append({
    op: 'put', type: 'event',
    key: 'events:2026-04-16:e1',
    value: { id: 'e1', title: 'Solo', date: '2026-04-16', groups: [oldGroupId], updatedAt: 300 },
  })
  await oldBase.append({
    op: 'put', type: 'event',
    key: 'events:2026-04-17:e2',
    value: { id: 'e2', title: 'Shared', date: '2026-04-17', groups: [oldGroupId, 'gOTHER'], updatedAt: 301 },
  })

  // Seed an RSVP
  await oldBase.append({
    op: 'put', type: 'rsvp',
    key: 'rsvp:e1:alicePubkey',
    value: { eventId: 'e1', memberId: 'alicePubkey', status: 'going', updatedAt: 400 },
  })

  await oldBase.update()

  console.log('running rekeyGroup')
  const newGroupId = 'gNEW888'
  const { newBase, descriptor } = await rekeyGroup({
    oldBase, oldGroupId, newGroupId, store,
  })

  console.log('descriptor shape')
  check('descriptor.oldGroupId', descriptor.oldGroupId === oldGroupId)
  check('descriptor.newGroupId', descriptor.newGroupId === newGroupId)
  check('descriptor.newGroupKey is 64-char hex',
    typeof descriptor.newGroupKey === 'string' && /^[0-9a-f]{64}$/.test(descriptor.newGroupKey))
  check('descriptor.newWriterKey is 64-char hex',
    typeof descriptor.newWriterKey === 'string' && /^[0-9a-f]{64}$/.test(descriptor.newWriterKey))
  check('newGroupKey !== oldGroupKey',
    descriptor.newGroupKey !== b4a.toString(oldBase.key, 'hex'))

  console.log('view content replayed')
  // Avatars: same keys, same values
  const newAvatarA = await newBase.view.get(NS.avatars + 'hashA')
  const newAvatarB = await newBase.view.get(NS.avatars + 'hashB')
  check('avatar hashA replayed', newAvatarA?.value?.data === 'data:image/png;base64,AAA')
  check('avatar hashB replayed', newAvatarB?.value?.data === 'data:image/png;base64,BBB')

  // Group record: new id+groupKey, everything else preserved
  const newGroupNode = await newBase.view.get(NS.groups + newGroupId)
  const newGroup = newGroupNode?.value
  check('group record exists at new key', !!newGroup)
  check('group.id rewritten', newGroup?.id === newGroupId)
  check('group.groupKey rewritten', newGroup?.groupKey === descriptor.newGroupKey)
  check('group.ownerId preserved', newGroup?.ownerId === 'ownerPubkey')
  check('group.name preserved', newGroup?.name === 'Old Group')
  check('group.color preserved', newGroup?.color === '#aabbcc')
  check('group.members count', newGroup?.members?.length === 2)
  check('group.members[0].avatar preserved (hash-only)', newGroup?.members?.[0]?.avatar === 'hashA')
  check('group.migratedFrom tag', newGroup?.migratedFrom === oldGroupId)

  // Old group record NOT present in new view
  const leaked = await newBase.view.get(NS.groups + oldGroupId)
  check('no leaked old group record', !leaked)

  // Events: groups[] rewritten for single-group; partially for multi-group
  const newE1 = await newBase.view.get('events:2026-04-16:e1')
  check('event e1 replayed', !!newE1?.value)
  check('event e1 groups[] rewritten',
    JSON.stringify(newE1?.value?.groups) === JSON.stringify([newGroupId]),
    JSON.stringify(newE1?.value?.groups))
  check('event e1 title preserved', newE1?.value?.title === 'Solo')

  const newE2 = await newBase.view.get('events:2026-04-17:e2')
  check('event e2 replayed', !!newE2?.value)
  check('event e2 groups[] partially rewritten (other group preserved)',
    JSON.stringify(newE2?.value?.groups) === JSON.stringify([newGroupId, 'gOTHER']),
    JSON.stringify(newE2?.value?.groups))

  // RSVP preserved
  const newRsvp = await newBase.view.get('rsvp:e1:alicePubkey')
  check('rsvp replayed', newRsvp?.value?.status === 'going')
  check('rsvp.memberId preserved', newRsvp?.value?.memberId === 'alicePubkey')

  // Writer set on new base
  check('new base has addWriter for new writer key',
    b4a.toString(newBase.local.key, 'hex') === descriptor.newWriterKey)

  console.log('idempotency within replay output')
  // Running snapshotView on newBase should produce the same shape.
  const { snapshotView } = require('../src/lib/rekey.js')
  const snap = await snapshotView(newBase.view)
  check('new view has 2 avatars', snap.avatars.length === 2)
  check('new view has 2 events', snap.events.length === 2)
  check('new view has 1 rsvp', snap.rsvps.length === 1)

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
