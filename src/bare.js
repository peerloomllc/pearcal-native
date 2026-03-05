const Hypercore  = require('hypercore')
const Hyperbee   = require('hyperbee')
const Hyperswarm = require('hyperswarm')
const Autobase   = require('autobase')
const Corestore  = require('corestore')
const sodium     = require('sodium-native')
const b4a        = require('b4a')

const send = (msg) => BareKit.IPC.write(Buffer.from(JSON.stringify(msg) + '\n'))

let db      = null   // main Hyperbee (local profile/events/groups)
let store   = null   // Corestore for Autobase
let swarm   = null   // Hyperswarm
let dataDir = null

const bases = new Map()   // groupId → Autobase
let buf = ''

// ── IPC ──────────────────────────────────────────────────────────────────────

BareKit.IPC.on('data', chunk => {
  buf += chunk.toString()
  const lines = buf.split('\n')
  buf = lines.pop()
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const msg = JSON.parse(line)
      if (msg.method === 'init') init(msg.dataDir)
      else dispatch(msg.method, msg.args ?? [], msg.id)
    } catch(e) { console.error('IPC parse error:', e.message) }
  }
})

async function dispatch (method, args, id) {
  try {
    const result = await handle(method, args)
    send({ type: 'response', id, result })
  } catch(e) {
    console.error('dispatch error:', method, e.message)
    send({ type: 'response', id, error: e.message })
  }
}

async function handle (method, args) {
  switch (method) {
    case 'ping':             return 'pong'
    case 'getProfile':       return getProfile()
    case 'updateProfile':    return updateProfile(args[0])
    case 'listEvents':       return listEvents(args[0])
    case 'putEvent':         return putEvent(args[0])
    case 'deleteEvent':      return deleteEvent(args[0], args[1])
    case 'localDeleteEvent': return localDeleteEvent(args[0], args[1])
    case 'getGroup':         return getGroup(args[0])
    case 'listGroups':       return listGroups()
    case 'putGroup':         return putGroup(args[0])
    case 'deleteGroup':      return deleteGroup(args[0])
    case 'listMembers':      return listMembers(args[0])
    case 'putMember':        return putMember(args[0], args[1])
    case 'removeMember':     return removeMember(args[0], args[1])
    case 'joinGroup':        return joinGroup(args[0])
    case 'leaveGroup':       return leaveGroup(args[0])
    case 'putEvent:sync':    return syncPutEvent(args[0], args[1])
    case 'deleteEvent:sync': return syncDeleteEvent(args[0], args[1], args[2], args[3])
    case 'putGroup:sync':    return syncPutGroup(args[0])
    case 'deleteGroup:sync':  return syncDeleteGroup(args[0])
    case 'memberLeft:sync':   return syncMemberLeft(args[0], args[1])
    case 'resyncGroup':        return resyncGroup(args[0])
    // Notifications handled on RN side
    case 'scheduleForEvent': return null
    case 'cancelForEvent':   return null
    case 'restoreAll':       return null
    case 'shutdown':       return shutdown()
    default: throw new Error('Unknown method: ' + method)
  }
}

// ── DB helpers ────────────────────────────────────────────────────────────────

const NS = {
  profile: 'profile',
  events:  'events:',
  groups:  'groups:',
  members: 'members:',
}

async function getProfile () {
  const node = await db.get(NS.profile)
  return node?.value ?? null
}

async function updateProfile (updates) {
  const current = await getProfile()
  await db.put(NS.profile, { ...current, ...updates, updatedAt: Date.now() })
}

async function listEvents (opts) {
  opts = opts || {}
  const { from, to, groupId } = opts
  const gt = NS.events + (from ?? '')
  const lt = NS.events + (to ? to + '\xff' : '\xff')
  const events = []
  for await (const { value } of db.createReadStream({ gt, lt })) {
    if (groupId && !value.groups?.includes(groupId)) continue
    events.push(value)
  }
  return events
}

async function putEvent (event) {
  await db.put(NS.events + event.date + ':' + event.id, { ...event, updatedAt: Date.now() })
  return event
}

async function deleteEvent (date, id) {
  await db.del(NS.events + date + ':' + id)
}

async function localDeleteEvent (date, id) {
  await db.del(NS.events + date + ':' + id)
  await db.put('deleted:' + id, { date, ts: Date.now() })
}

async function getGroup (id) {
  const node = await db.get(NS.groups + id)
  return node?.value ?? null
}

async function listGroups () {
  const groups = []
  for await (const { value } of db.createReadStream({ gt: NS.groups, lt: NS.groups + '\xff' })) {
    groups.push(value)
  }
  return groups
}

async function putGroup (group) {
  await db.put(NS.groups + group.id, { ...group, updatedAt: Date.now() })
  return group
}

async function deleteGroup (id) {
  await db.del(NS.groups + id)
  // Clean up member records
  for await (const { key } of db.createReadStream({ gt: NS.members + id, lt: NS.members + id + '\xff' })) {
    await db.del(key)
  }
  // Clean up events: remove this group from each event's groups array.
  // If an event belongs to no other groups, delete it entirely.
  for await (const { key, value } of db.createReadStream({ gt: NS.events, lt: NS.events + '\xff' })) {
    if (!value.groups?.includes(id)) continue
    const remaining = (value.groups ?? []).filter(gid => gid !== id)
    if (remaining.length === 0) {
      await db.del(key)
    } else {
      await db.put(key, { ...value, groups: remaining, updatedAt: Date.now() })
    }
  }
}

async function listMembers (groupId) {
  const members = []
  for await (const { value } of db.createReadStream({ gt: NS.members + groupId + ':', lt: NS.members + groupId + ':\xff' })) {
    members.push(value)
  }
  return members
}

async function putMember (groupId, member) {
  await db.put(NS.members + groupId + ':' + member.id, { ...member, groupId, updatedAt: Date.now() })
}

async function removeMember (groupId, memberId) {
  await db.del(NS.members + groupId + ':' + memberId)
}

// ── Sync ──────────────────────────────────────────────────────────────────────


// ── Writer handshake ─────────────────────────────────────────────────────────
// When peers connect over Hyperswarm, they exchange a single length-prefixed
// JSON message containing their Autobase writerKey and groupId(s).
// The owner reads this and calls addWriter — no separate Hypercore needed.
//
// Protocol: 4-byte big-endian length header + JSON body, sent once on connect.
//   { type: 'writerAnnounce', groupId, writerKey }

const pendingWriterAnnouncements = new Map() // groupId → Set of writerKey hex strings
const activeChannels = new Set() // active writer-announce message objects
const pendingGroupDeletes = new Set() // groupIds deleted by owner, pending broadcast to late-connecting peers
const pendingMemberLeaves = new Set()  // {groupId,memberId} JSON strings, pending broadcast to late-connecting peers

async function joinGroup (group) {
  if (bases.has(group.id)) return

  console.log('Joining group swarm:', group.id)

  const profile = await getProfile()
  const isOwner = group.ownerId === profile?.id
  const groupStore = store.namespace(group.id)

  // Owner creates with null bootstrap to get a real Autobase key
  // Joiner uses the groupKey (owner's real Autobase key) as bootstrap
  const bootstrap = isOwner ? null : b4a.from(group.groupKey, 'hex')

  const base = new Autobase(groupStore, bootstrap, {
    valueEncoding: 'json',
    open: (s) => new Hyperbee(s.get('view'), { keyEncoding: 'utf-8', valueEncoding: 'json' }),
    apply: makeApply(group.id),
    ackInterval: 1000,
  })
  await base.ready()

  const realKey = b4a.toString(base.key, 'hex')

  // Owner: persist the real Autobase key and notify UI
  if (isOwner && realKey !== group.groupKey) {
    group = { ...group, groupKey: realKey }
    await putGroup(group)
    send({ type: 'event', event: 'groupKeyUpdated', data: group })
  }

  // Owner adds self as writer, then processes any pending joiner announcements
  if (isOwner) {
    try {
      const writerKey = b4a.toString(base.local.key, 'hex')
      await base.append({ addWriter: writerKey })
    } catch(e) {
    }

    // Process any writerAnnounce messages that arrived before joinGroup ran
    const pending = pendingWriterAnnouncements.get(group.id)
    if (pending) {
      for (const writerKey of pending) {
          base.append({ addWriter: writerKey }).catch(e =>
          console.error('[OWNER] pending addWriter error:', e.message)
        )
      }
      pendingWriterAnnouncements.delete(group.id)
    }
  }

  bases.set(group.id, base)

  // Announce our writer key to any already-connected peers
  const writerKey = b4a.toString(base.local.key, 'hex')
  for (const ch of activeChannels) {
    try { ch.send(Buffer.from(JSON.stringify({ groupId: group.id, writerKey, memberId: profile?.id ?? null }))) } catch(e) {}
  }

  // Always use group.groupKey as swarm topic so both sides match
  // (owner updates groupKey to realKey before this point)
  const topicKey = group.groupKey
  const topic = b4a.from(topicKey.slice(0, 64).padEnd(64, '0'), 'hex')
  swarm.join(topic, { server: true, client: true })

  console.log('Joined group swarm:', group.id, 'topic:', topicKey.slice(0,16))
}

async function leaveGroup (groupId) {
  const base = bases.get(groupId)
  if (base) {
    await base.close()
    bases.delete(groupId)
  }
}

async function syncPutEvent (groupId, event) {
  const base = bases.get(groupId)
  if (!base) throw new Error('Not in group: ' + groupId)
  // Carry _prevDate in the value so receiving devices can clean up the old key
  const value = { ...event, updatedAt: event.updatedAt || Date.now() }
  await base.append({ op: 'put', type: 'event', key: 'events:' + event.date + ':' + event.id, value })
}

async function syncDeleteEvent (groupId, eventId, date, updatedByName) {
  const base = bases.get(groupId)
  if (!base) throw new Error('Not in group: ' + groupId)
  await base.append({ op: 'del', type: 'event', key: 'events:' + date + ':' + eventId, updatedByName: updatedByName || 'Someone' })
}

async function syncPutGroup (group) {
  const base = bases.get(group.id)
  if (!base) throw new Error('Not in group: ' + group.id)
  await base.append({ op: 'put', type: 'group', key: 'groups:' + group.id, value: group })
}

async function syncDeleteGroup (groupId) {
  pendingGroupDeletes.add(groupId)
  for (const ch of activeChannels) {
    try {
      ch.send(Buffer.from(JSON.stringify({ groupDeleted: groupId })))
    } catch(e) {}
  }
}

async function syncMemberLeft (groupId, memberId) {
  const key = JSON.stringify({ groupId, memberId })
  pendingMemberLeaves.add(key)
  // Persist including groupKey and topicHex so we can rejoin swarm after restart to deliver
  const group = await getGroup(groupId).catch(() => null)
  const topicHex = group?.groupKey ? group.groupKey.slice(0, 64).padEnd(64, '0') : null
  await db.put('pendingLeave:' + groupId + ':' + memberId, { groupId, memberId, groupKey: group?.groupKey, ts: Date.now() }).catch(() => {})
  if (topicHex) await db.put('pendingLeaveKey:' + groupId, { topicHex }).catch(() => {})
  for (const ch of activeChannels) {
    try { ch.send(Buffer.from(JSON.stringify({ memberLeft: memberId, groupId }))) } catch(e) {}
  }
}

async function resyncGroup (groupId) {
  const base = bases.get(groupId)
  if (!base) return
  // Re-mirror everything from the Autobase view to local DB.
  // Needed after rejoin when local DB was cleaned up on leave
  // but Autobase view already has entries and won't re-fire apply.
  try {
    await base.update()
    const view = base.view
    if (!view) return
    for await (const { key, value } of view.createReadStream()) {
      if (!value) continue
      if (key.startsWith('events:')) {
        // Respect local delete tombstone — never resurrect user-deleted events
        const eventId = key.split(':').pop()
        const tombstone = await db.get('deleted:' + eventId).catch(() => null)
        if (tombstone) continue
        await db.put(key, value)
      } else if (key.startsWith('groups:')) {
        // Merge members same way mirrorToLocal does
        const existing = await db.get(key).catch(() => null)
        const existingMembers = existing?.value?.members ?? []
        const incomingMembers = value.members ?? []
        const mergedMap = new Map()
        for (const m of existingMembers) mergedMap.set(m.id, m)
        for (const m of incomingMembers) {
          const prev = mergedMap.get(m.id)
          if (!prev || prev.name === 'Inviter' || m.name !== 'Inviter') mergedMap.set(m.id, m)
        }
        await db.put(key, { ...value, members: [...mergedMap.values()] })
      }
    }
    send({ type: 'event', event: 'sync', data: groupId })
  } catch(e) { console.error('[RESYNC] error:', e.message) }
}

function makeApply (groupId) {
  return async function apply (nodes, view, host) {
    const base = bases.get(groupId)
    const localKey = base ? b4a.toString(base.local.key, 'hex') : null
    for (const node of nodes) {
      const val = node.value
      if (!val) continue

      // Writer announcement — add them as a writer
      if (val.addWriter) {
        // Check if this writer was blocked by the owner — if so skip granting access
        const writerBlocked = await db.get('blockedWriter:' + groupId + ':' + val.addWriter).catch(() => null)
        if (!writerBlocked) {
          await host.addWriter(b4a.from(val.addWriter, 'hex'), { indexer: true })
        }
        continue
      }

      // Detect remote writes via node.from.key
      const nodeWriterKey = node.from?.key ? b4a.toString(node.from.key, 'hex') : null
      const isRemote = localKey && nodeWriterKey && nodeWriterKey !== localKey

      // Write to the shared Autobase view
      if (val.op === 'put') {
        // Last-write-wins: only apply if newer than existing
        const existing = await view.get(val.key)
        if (!existing || !existing.value.updatedAt || !val.value.updatedAt || val.value.updatedAt >= existing.value.updatedAt) {
          // Fetch prev from local DB BEFORE mirroring so we can diff in notifySyncChange
          // If date changed, the old entry lives under _prevDate key, not the new key
          let localPrev = null
          if (isRemote && val.type === 'event') {
            localPrev = await db.get(val.key).then(n => n?.value ?? null).catch(() => null)
            if (!localPrev && val.value._prevDate) {
              localPrev = await db.get('events:' + val.value._prevDate + ':' + val.value.id).then(n => n?.value ?? null).catch(() => null)
            }
          }
          await view.put(val.key, val.value)
          await mirrorToLocal(val.type, val.key, val.value, groupId)
          // Notify when a new member joins — detected by diffing member lists on group update
          if (isRemote && val.type === 'group') {
            try {
              const profile = await getProfile()
              const existingMembers = existing?.value?.members ?? []
              const incomingMembers = val.value.members ?? []
              const existingIds = new Set(existingMembers.map(m => m.id))
              const newMembers = incomingMembers.filter(m =>
                m.id !== profile?.id &&
                m.name !== 'Inviter' &&
                !existingIds.has(m.id) &&
                m.id !== val.value.ownerId  // owner was always there, never a "new" joiner
              )
              for (const m of newMembers) {
                const groupName = val.value.name || 'a group'
                send({ type: 'event', event: 'syncNotify', data: {
                  title: (m.name || 'Someone') + ' joined ' + groupName,
                  body: 'Tap to view the group',
                  tab: 'groups'
                }})
              }
            } catch(e) { console.error('[MEMBER_JOIN_NOTIF] error:', e.message) }
          }
          if (isRemote && val.type === 'event') {
            // Skip notification if user locally deleted this event
            const notifTombstone = await db.get('deleted:' + val.value.id).catch(() => null)
            if (notifTombstone) continue
            // Skip notification if only color changed
            const onlyColorChanged = localPrev &&
              val.value.color !== localPrev.color &&
              val.value.title === localPrev.title &&
              val.value.date === localPrev.date &&
              val.value.start === localPrev.start &&
              val.value.end === localPrev.end &&
              val.value.desc === localPrev.desc &&
              JSON.stringify(val.value.groups) === JSON.stringify(localPrev.groups)
            if (!onlyColorChanged) {
              notifySyncChange({ op: 'put', value: val.value, prev: localPrev, groupId })
            }
          }
        } else {
          // Timestamp lost — mirror the winning (existing) value to local DB.
          // BUT for groups, always merge members from the losing incoming record
          // so a joiner's broadcastSelf is never silently dropped by a timestamp race.
          if (val.type === 'group' && val.value?.members?.length > 0) {
            const winningValue = existing.value
            const existingMembers = winningValue.members ?? []
            const incomingMembers = val.value.members ?? []
            const mergedMap = new Map()
            for (const m of existingMembers) mergedMap.set(m.id, m)
            for (const m of incomingMembers) {
              const prev = mergedMap.get(m.id)
              if (!prev || prev.name === 'Inviter' || m.name !== 'Inviter') mergedMap.set(m.id, m)
            }
            const merged = { ...winningValue, members: [...mergedMap.values()] }
            await db.put(val.key, merged)
            send({ type: 'event', event: 'sync', data: groupId })
          } else {
            await mirrorToLocal(val.type, val.key, existing.value, groupId)
          }
        }
      } else if (val.op === 'del') {
        await view.del(val.key)
        await deleteFromLocal(val.type, val.key)
        if (val.type === 'group' && isRemote) {
          // Owner deleted the group — clean up locally and notify UI
          await deleteGroup(groupId)
          await leaveGroup(groupId)
          send({ type: 'event', event: 'groupDeleted', data: groupId })
        } else {
          send({ type: 'event', event: 'sync', data: groupId })
          if (isRemote && val.type === 'event') {
            const eventId = val.key.split(':').pop()
            const delTombstone = await db.get('deleted:' + eventId).catch(() => null)
            if (!delTombstone) {
              notifySyncChange({ op: 'del', key: val.key, updatedByName: val.updatedByName, groupId })
            }
          }
        }
      }
    }
  }
}

async function notifySyncChange ({ op, value, key, prev, updatedByName, groupId }) {
  try {
    let title = 'Calendar updated'
    let body  = ''
    const who  = updatedByName || value?.updatedByName || 'Someone'

    if (op === 'del') {
      const parts = (key ?? '').split(':')
      const date  = parts[1] ?? ''
      title = who + ' removed an event'
      body  = date ? 'On ' + formatDate(date) : ''

    } else if (op === 'put' && value) {
      const what = value.title || 'An event'

      if (!prev) {
        // Brand new event
        title = who + ' added ' + what
        body  = value.date ? 'On ' + formatDate(value.date) : ''

      } else {
        // Diff fields in priority order
        const titleChanged = prev.title && prev.title !== value.title
        const dateChanged  = prev.date !== value.date || prev.start !== value.start || prev.end !== value.end || prev.allDay !== value.allDay
        const notesAdded   = !prev.desc && value.desc
        const notesEdited  = prev.desc && value.desc && prev.desc !== value.desc
        const newGroups    = (value.groups ?? []).filter(gid => !(prev.groups ?? []).includes(gid))

        if (titleChanged) {
          title = who + ' renamed “' + prev.title + '”'
          body  = 'Now called “' + value.title + '”'

        } else if (newGroups.length > 0) {
          const names = []
          for (const gid of newGroups) {
            const g = await db.get('groups:' + gid).catch(() => null)
            if (g?.value?.name) names.push(g.value.name)
          }
          title = who + ' shared ' + what
          body  = names.length > 0 ? 'With ' + names.join(', ') : 'With a new group'

        } else if (dateChanged) {
          title = who + ' rescheduled ' + what
          body  = value.date ? 'Now on ' + formatDate(value.date) + (value.allDay ? '' : ' at ' + value.start) : ''

        } else if (notesAdded) {
          title = 'Notes added to ' + what
          body  = value.desc

        } else if (notesEdited) {
          title = 'Notes for ' + what + ' updated by ' + who
          body  = value.desc

        } else {
          title = who + ' updated ' + what
          body  = value.date ? formatDate(value.date) : ''
        }
      }
    }

    send({ type: 'event', event: 'syncNotify', data: { title, body } })
  } catch (e) {
    console.error('notifySyncChange error:', e.message)
    send({ type: 'event', event: 'syncNotify', data: { title: 'Calendar updated', body: '' } })
  }
}
function formatDate (dateStr) {
  try {
    const [y, m, d] = dateStr.split('-').map(Number)
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
    return months[m - 1] + ' ' + d
  } catch (e) { return dateStr }
}

async function mirrorToLocal (type, key, value, groupId) {
  try {
    if (type === 'event') {
      // If user locally deleted this event, don't resurrect it from sync
      const tombstone = await db.get('deleted:' + value.id).catch(() => null)
      if (tombstone) return
      // If date changed, remove old local entry to prevent duplicate
      if (value._prevDate && value._prevDate !== value.date) {
        await db.del('events:' + value._prevDate + ':' + value.id).catch(() => {})
      }
      const { _prevDate, ...clean } = value
      await db.put(key, { ...clean, updatedAt: value.updatedAt || Date.now() })
    } else if (type === 'group') {
      // Merge members from incoming group with existing local members
      // so no device's member list overwrites another's
      const existing = await db.get(key).catch(() => null)
      const existingMembers = existing?.value?.members ?? []
      const incomingMembers = value.members ?? []
      const mergedMap = new Map()
      // First pass: seed with existing members
      for (const m of existingMembers) mergedMap.set(m.id, m)
      // Second pass: incoming members override existing
      // - Always replace 'Inviter' placeholder
      // - Always update name/avatar (profile name changes)
      // - Add new members not yet in existing
      for (const m of incomingMembers) {
        const prev = mergedMap.get(m.id)
        if (!prev || prev.name === 'Inviter' || m.name !== 'Inviter') {
          mergedMap.set(m.id, m)
        }
      }
      const merged = { ...value, members: [...mergedMap.values()], updatedAt: value.updatedAt || Date.now() }
      await db.put(key, merged)
    }
    // Notify UI to refresh
    send({ type: 'event', event: 'sync', data: groupId })
  } catch(e) {
    console.error('mirrorToLocal error:', e.message)
  }
}

async function deleteFromLocal (type, key) {
  try {
    await db.del(key)
  } catch(e) {}
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function shutdown () {
  try {
    if (swarm) { await swarm.destroy(); swarm = null }
    if (store) { await store.close(); store = null }
    if (db) { await db.close(); db = null }
    bases.clear()
    console.log('Shutdown complete')
  } catch(e) {
    console.error('Shutdown error:', e.message)
  }
}

async function init (dir, attempt = 0) {
  // If already initialized, just re-send ready event
  if (db) {
    // Reload any persisted pending member leaves from previous sessions
  // and briefly rejoin those group swarms so we can deliver on next connection
  try {
    for await (const entry of db.createReadStream({ gt: 'pendingLeave:', lt: 'pendingLeave:~' })) {
      const { groupId, memberId, groupKey } = entry.value
      pendingMemberLeaves.add(JSON.stringify({ groupId, memberId }))
      // Rejoin swarm so Protomux onopen can deliver the leave message.
      // We stay joined until delivery succeeds (leave happens in onopen after send).
      if (groupKey && !bases.has(groupId)) {
        try {
          const topic = b4a.from(groupKey.slice(0, 64).padEnd(64, '0'), 'hex')
          swarm.join(topic, { server: false, client: true })
        } catch(e) {}
      }
    }
  } catch(e) {}
  send({ type: 'event', event: 'ready' })
    return
  }
  try {
    dataDir = dir
    console.log('Init DB at', dataDir)

    // Main local DB
    const core = new Hypercore(dataDir + '/core', { valueEncoding: 'json' })
    await core.ready()
    db = new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'json' })
    await db.ready()

    // Corestore for Autobase groups
    store = new Corestore(dataDir + '/store')
    await store.ready()

    // Hyperswarm
    swarm = new Hyperswarm()

    swarm.on('connection', async (conn, info) => {

      // Let Corestore set up replication first — this creates the protocol
      // stream and installs a Protomux muxer at stream.noiseStream.userData
      const stream = store.replicate(conn)

      // Handle stream/conn errors silently — Hyperswarm will reconnect
      stream.on('error', e => console.warn('[REPL] stream error:', e.message))
      conn.on('error', e => console.warn('[REPL] conn error:', e.message))

      // On close, trigger Hyperswarm flush so it reconnects promptly
      stream.on('close', () => {
        if (swarm) swarm.flush().catch(() => {})
      })

      // Wait for the noise handshake to complete so the muxer is ready
      await stream.noiseStream.opened

      const mux = stream.noiseStream.userData
      if (!mux) {
        console.error('[HANDSHAKE] no muxer found')
        return
      }

      // Open a dedicated Protomux channel for writer key exchange
      // Per-connection dedup set — scoped here so both onopen and onmessage can access it
      const connSeenWriters = new Set()
      const channel = mux.createChannel({
        protocol: 'pearcal/writer-announce',
        id: Buffer.from('pearcal-writer-announce-v1'),
        async onopen () {
          // Reactively call base.update() when remote blocks arrive
          // so apply() processes new events without needing a force-restart
          for (const [groupId, base] of bases) {
            const onAppend = () => base.update().catch(e => console.warn('[REPL] update error:', e.message))
            base.on('append', onAppend)
            stream.once('close', () => base.off('append', onAppend))
          }

          // Send our writerKey for every group we've joined
          const _announceProfile = await getProfile().catch(() => null)
          const _announceMemberId = _announceProfile?.id ?? null
          for (const [groupId, base] of bases) {
            const writerKey = b4a.toString(base.local.key, 'hex')
            msg.send(Buffer.from(JSON.stringify({ groupId, writerKey, memberId: _announceMemberId })))
          }
          // Send any pending group deletes to this new peer
          for (const groupId of pendingGroupDeletes) {
            try { msg.send(Buffer.from(JSON.stringify({ groupDeleted: groupId }))) } catch(e) {}
          }
          // Send any pending member leaves to this new peer and clear from DB after sending
          for (const key of pendingMemberLeaves) {
            try {
              const { groupId, memberId } = JSON.parse(key)
              msg.send(Buffer.from(JSON.stringify({ memberLeft: memberId, groupId })))
              pendingMemberLeaves.delete(key)
              db.del('pendingLeave:' + groupId + ':' + memberId).catch(() => {})
              // Leave the temporary swarm rejoin now that delivery is done
              if (!bases.has(groupId)) {
                const leaveEntry = await db.get('pendingLeaveKey:' + groupId).catch(() => null)
                if (leaveEntry?.value?.topicHex) {
                  const topic = b4a.from(leaveEntry.value.topicHex, 'hex')
                  swarm.leave(topic).catch(() => {})
                }
                db.del('pendingLeaveKey:' + groupId).catch(() => {})
              }
            } catch(e) {}
          }
          activeChannels.add(msg)
        },
        onclose () {
          activeChannels.delete(msg)
        }
      })

      if (!channel) {
        return
      }

      // Single message type: JSON buffer
      const msg = channel.addMessage({
        onmessage: async function (buf) {
          try {
            const parsed = JSON.parse(buf.toString())
            // Handle member left broadcast from non-owner
            if (parsed.memberLeft) {
              const { memberLeft: memberId, groupId } = parsed
              try {
                const group = await getGroup(groupId)
                const profile = await getProfile()
                // If we are the removed member, treat as group deletion
                if (profile && memberId === profile.id) {
                  await deleteGroup(groupId)
                  await leaveGroup(groupId)
                  send({ type: 'event', event: 'groupDeleted', data: groupId })
                  return
                }
                if (group && profile && group.ownerId === profile.id) {
                  const updated = { ...group, members: (group.members ?? []).filter(m => m.id !== memberId), updatedAt: Date.now() }
                  await putGroup(updated)
                  // Clear writer announcements for this group so the member can rejoin cleanly
                  pendingWriterAnnouncements.delete(groupId)
                  // Remove persisted pending leave now that it's been processed
                  await db.del('pendingLeave:' + groupId + ':' + memberId).catch(() => {})
                  // Notify owner that member left
                  const leavingMember = (group.members ?? []).find(m => m.id === memberId)
                  const leavingName = leavingMember?.name || 'Someone'
                  send({ type: 'event', event: 'syncNotify', data: {
                    title: leavingName + ' left ' + (group.name || 'your group'),
                    body: 'Tap to view the group',
                    tab: 'groups'
                  }})
                  // Rebroadcast so other members see the updated list
                  const base = bases.get(groupId)
                  if (base) await base.append({ op: 'put', type: 'group', key: 'groups:' + groupId, value: updated })
                  send({ type: 'event', event: 'sync', data: groupId })
                }
              } catch(e) { console.error('[MEMBER_LEFT] error:', e.message) }
              return
            }
            // Handle blocked message — owner rejected our writer key (we were removed)
            if (parsed.blocked) {
              const gid = parsed.groupId
              if (gid) {
                const blockedGroup = await getGroup(gid).catch(() => null)
                const blockedOwnerName = parsed.ownerName || 'The owner'
                const blockedGroupName = blockedGroup?.name || 'a group'
                send({ type: 'event', event: 'syncNotify', data: {
                  title: blockedOwnerName + ' removed you from ' + blockedGroupName,
                  body: 'You no longer have access to this group',
                  tab: 'groups'
                }})
                await deleteGroup(gid).catch(() => {})
                await leaveGroup(gid).catch(() => {})
                send({ type: 'event', event: 'groupDeleted', data: gid })
              }
              return
            }
            // Handle group delete broadcast from owner
            if (parsed.groupDeleted) {
              const gid = parsed.groupDeleted
              await deleteGroup(gid)
              await leaveGroup(gid)
              send({ type: 'event', event: 'groupDeleted', data: gid })
              return
            }
            const { groupId, writerKey } = parsed

            const base = bases.get(groupId)
            if (base) {
              Promise.all([getProfile(), getGroup(groupId)]).then(([profile, group]) => {
                const isOwner = group && group.ownerId === profile.id
                if (isOwner) {
                  const connKey = groupId + ':' + writerKey
                  if (!connSeenWriters.has(connKey)) {
                    connSeenWriters.add(connKey)
                    // Still track globally to handle duplicate announcements from same peer
                    const set = pendingWriterAnnouncements.get(groupId) || new Set()
                    const alreadyKnown = set.has(writerKey)
                    set.add(writerKey)
                    pendingWriterAnnouncements.set(groupId, set)
                    // Check blocklist before granting write access
                    const removedMembers = group.removedMembers ?? []
                    const parsed_memberId = parsed.memberId ?? null
                    if (parsed_memberId && removedMembers.includes(parsed_memberId)) {
                      // Store writerKey so apply() can also block Autobase log replay
                      await db.put('blockedWriter:' + groupId + ':' + parsed.writerKey, { memberId: parsed_memberId, ts: Date.now() }).catch(() => {})
                      try {
                        const ownerProfile = await getProfile().catch(() => null)
                        msg.send(Buffer.from(JSON.stringify({ blocked: true, groupId, ownerName: ownerProfile?.name || 'The owner' })))
                      } catch(e) {}
                      return
                    }
                    base.append({ addWriter: writerKey })
                      .then(async () => {
                        // Rebroadcast full group so joiner gets real member names
                        try {
                          const g = await getGroup(groupId)
                          if (g) {
                            await base.append({ op: 'put', type: 'group', key: 'groups:' + groupId, value: { ...g, updatedAt: Date.now() } })
                            // Notification handled in apply() where real member name is available
                          }
                        } catch(e) { console.error('[ADDWRITER] rebroadcast error:', e.message) }
                      })
                      .catch(e => console.error('[ADDWRITER] error:', e.message))
                  }
                }
              }).catch(e => console.error('[HANDSHAKE] ownership check error:', e.message))
            } else {
              const set = pendingWriterAnnouncements.get(groupId) || new Set()
              set.add(writerKey)
              pendingWriterAnnouncements.set(groupId, set)
              }
          } catch (e) {
            console.error('[HANDSHAKE] parse error:', e.message)
          }
        }
      })

      channel.open()
    })

    // Bootstrap profile
    const existing = await db.get(NS.profile)
    if (!existing) {
      const pk = b4a.allocUnsafe(sodium.crypto_sign_PUBLICKEYBYTES)
      const sk = b4a.allocUnsafe(sodium.crypto_sign_SECRETKEYBYTES)
      sodium.crypto_sign_keypair(pk, sk)
      await db.put(NS.profile, {
        id:        b4a.toString(pk, 'hex'),
        name:      'My Name',
        avatar:    'MN',
        publicKey: b4a.toString(pk, 'hex'),
        secretKey: b4a.toString(sk, 'hex'),
        createdAt: Date.now(),
      })
    }

    // Fix empty avatar for existing profiles
    const profileNode = await db.get(NS.profile)
    if (profileNode?.value && !profileNode.value.avatar) {
      const n = profileNode.value.name ?? 'My Name'
      const initials = n.trim().split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0,2) || '?'
      await db.put(NS.profile, { ...profileNode.value, avatar: initials })
    }
    // Re-join all existing groups
    const groups = []
    for await (const { value } of db.createReadStream({ gt: NS.groups, lt: NS.groups + '\xff' })) {
      groups.push(value)
    }
    for (const g of groups) {
      await joinGroup(g).catch(e => console.error('joinGroup error:', e.message))
    }

    console.log('DB ready, groups rejoined:', groups.length)
    send({ type: 'event', event: 'ready' })
  } catch(e) {
    console.error('Init failed:', e.message)
    if (e.message && e.message.includes('lock') && attempt < 20) {
      await new Promise(r => setTimeout(r, 1000))
      return init(dir, attempt + 1)
    }
    send({ type: 'event', event: 'error', data: e.message })
  }
}

send({ type: 'event', event: 'bareReady' })
