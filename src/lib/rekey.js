// Phase 1 of the group-rekey migration: given an existing Autobase-backed
// group whose view we consider canonical, produce a brand-new Autobase in a
// fresh corestore namespace containing the same logical state (avatars,
// group record, events, rsvps). The new base is left on disk with its
// writer key registered; nothing is wired to the swarm, blind peer, or
// local mirror yet — that is Phase 2's job.
//
// The replay rewrites event.groups[] so any reference to oldGroupId is
// substituted with newGroupId, preserving cross-group event membership
// for multi-group events.
//
// No signing of a migration marker here — Phase 2 uses src/lib/sign.js to
// write groupMigration:{oldGroupId} into the OLD base once the new base
// is ready and the owner commits to the migration.

const Autobase = require('autobase')
const Hyperbee = require('hyperbee')
const b4a      = require('b4a')

const NS = {
  events:  'events:',
  groups:  'groups:',
  rsvp:    'rsvp:',
  avatars: 'avatars:',
}

// Read every range we care about out of the old Autobase view in one pass.
// Ranges are disjoint; no special ordering needed.
async function snapshotView (view) {
  const out = { avatars: [], events: [], rsvps: [], groupRecord: null }
  for await (const { key, value } of view.createReadStream({
    gt: NS.avatars, lt: NS.avatars + '\xff',
  })) out.avatars.push({ key, value })
  for await (const { key, value } of view.createReadStream({
    gt: NS.events, lt: NS.events + '\xff',
  })) out.events.push({ key, value })
  for await (const { key, value } of view.createReadStream({
    gt: NS.rsvp, lt: NS.rsvp + '\xff',
  })) out.rsvps.push({ key, value })
  return out
}

// Minimal apply fn used during genesis replay — writes to view only,
// skips mirrorToLocal + notifications so the new group stays invisible
// to the UI until Phase 2 flips it live.
function makeReplayApply () {
  return async function apply (nodes, view, host) {
    for (const node of nodes) {
      const val = node.value
      if (!val) continue
      if (val.addWriter) {
        await host.addWriter(b4a.from(val.addWriter, 'hex'), { indexer: true })
        continue
      }
      if (val.op === 'put') {
        await view.put(val.key, val.value)
      }
    }
  }
}

// Rewrite an event record so references to oldGroupId become newGroupId.
// Leaves other group IDs in the groups[] array untouched (multi-group events).
function rewriteEventGroups (value, oldGroupId, newGroupId) {
  if (!Array.isArray(value?.groups)) return value
  const rewritten = value.groups.map(gid => (gid === oldGroupId ? newGroupId : gid))
  return { ...value, groups: rewritten }
}

async function rekeyGroup ({ oldBase, oldGroupId, newGroupId, store }) {
  if (!oldBase) throw new Error('rekeyGroup: oldBase required')
  if (!oldGroupId) throw new Error('rekeyGroup: oldGroupId required')
  if (!newGroupId) throw new Error('rekeyGroup: newGroupId required')
  if (!store) throw new Error('rekeyGroup: store required')

  const snapshot = await snapshotView(oldBase.view)

  const oldGroupNode = await oldBase.view.get(NS.groups + oldGroupId).catch(() => null)
  const oldGroupRec  = oldGroupNode?.value || null

  const newStore = store.namespace(newGroupId)
  const newBase  = new Autobase(newStore, null, {
    valueEncoding: 'json',
    open:  (s) => new Hyperbee(s.get('view'), { keyEncoding: 'utf-8', valueEncoding: 'json' }),
    apply: makeReplayApply(),
    ackInterval: 1000,
  })
  await newBase.ready()

  const newGroupKey  = b4a.toString(newBase.key, 'hex')
  const newWriterKey = b4a.toString(newBase.local.key, 'hex')

  // Genesis batch. Order matters: avatars first (so future readers resolving
  // hashes in the group record find them), then group record, then events,
  // then rsvps.
  await newBase.append({ addWriter: newWriterKey })

  for (const { key, value } of snapshot.avatars) {
    await newBase.append({ op: 'put', type: 'avatar', key, value })
  }

  const now = Date.now()
  const newGroupRec = {
    ...(oldGroupRec || {}),
    id:            newGroupId,
    groupKey:      newGroupKey,
    migratedFrom:  oldGroupId,
    updatedAt:     now,
  }
  await newBase.append({
    op: 'put', type: 'group',
    key: NS.groups + newGroupId,
    value: newGroupRec,
  })

  for (const { key, value } of snapshot.events) {
    const rewritten = rewriteEventGroups(value, oldGroupId, newGroupId)
    await newBase.append({ op: 'put', type: 'event', key, value: rewritten })
  }

  for (const { key, value } of snapshot.rsvps) {
    await newBase.append({ op: 'put', type: 'rsvp', key, value })
  }

  // Ensure everything above is indexed into the view before returning
  await newBase.update()

  return {
    newBase,
    descriptor: {
      oldGroupId,
      newGroupId,
      newGroupKey,
      newWriterKey,
      preparedAt: now,
    },
  }
}

module.exports = { rekeyGroup, snapshotView, rewriteEventGroups, NS }
