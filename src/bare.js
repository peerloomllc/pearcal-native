const Hypercore     = require('hypercore')
const Hyperbee      = require('hyperbee')
const Hyperswarm    = require('hyperswarm')
const Autobase      = require('autobase')
const Corestore     = require('corestore')
const BlindPeering  = require('blind-peering')
const Wakeup        = require('protomux-wakeup')
const sodium        = require('sodium-native')
const b4a           = require('b4a')
const { computeTodayCache } = require('./widget-cache.js')

const send = (msg) => BareKit.IPC.write(Buffer.from(JSON.stringify(msg) + '\n'))

let db      = null   // main Hyperbee (local profile/events/groups)
let store   = null   // Corestore for Autobase
let swarm   = null   // Hyperswarm
let dataDir = null

const bases = new Map()   // groupId → Autobase
let buf = ''
let _dbReady = false
let _dbReadyResolve = null
const _dbReadyPromise = new Promise(r => { _dbReadyResolve = r })

// ── Blind peering ────────────────────────────────────────────────────────────
// Blind peer key is now user-configurable via Settings → Seed Peer.
// Stored in local Hyperbee under 'blindPeerKey'.
let blind = null                     // BlindPeering instance

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
    if (!_dbReady) await _dbReadyPromise
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
    case 'deleteEventSeries': return deleteEventSeries(args[0])
    case 'localDeleteEvent': return localDeleteEvent(args[0], args[1])
    case 'getGroup':         return getGroup(args[0])
    case 'listGroups':       return listGroups()
    case 'putGroup':         return putGroup(args[0])
    case 'deleteGroup':      return deleteGroup(args[0])
    case 'isBlockedFromGroup': return db.get('blockedFromGroup:' + args[0]).then(n => !!n).catch(() => false)
    case 'clearBlockedFromGroup': return db.del('blockedFromGroup:' + args[0]).catch(() => {})
    case 'reinviteMember':   return reinviteMember(args[0], args[1])
    case 'debugGroup':       return debugGroup(args[0])
    case 'listMembers':      return listMembers(args[0])
    case 'putMember':        return putMember(args[0], args[1])
    case 'removeMember':     return removeMember(args[0], args[1])
    case 'joinGroup':        return joinGroup(args[0])
    case 'leaveGroup':       return leaveGroup(args[0])
    case 'qrScan': send({ type: 'event', event: 'qrScan', data: {} }); break
    case 'takePhoto': send({ type: 'event', event: 'takePhoto', data: {} }); break
    case 'haptic': ipc.emit('haptic', args[0]); break
    case 'openURL': ipc.emit('openURL', args[0]); break
    case 'canOpenLightning': ipc.emit('canOpenLightning'); return null
    case 'openLightning': ipc.emit('openLightning', args[0]); break
    case 'nativeShare':      return send({ type: 'event', event: 'nativeShare', data: { title: args[0], text: args[1] } })
    case 'putEvent:sync':    return syncPutEvent(args[0], args[1])
    case 'deleteEvent:sync': return syncDeleteEvent(args[0], args[1], args[2], args[3], args[4], args[5])
    case 'putGroup:sync':    return syncPutGroup(args[0])
    case 'deleteGroup:sync':  return syncDeleteGroup(args[0])
    case 'memberLeft:sync':   return syncMemberLeft(args[0], args[1])
    case 'purgeMember:sync':      return syncPurgeMember(args[0], args[1])
    case 'reinviteMember:sync':   return syncReinviteMember(args[0], args[1])
    case 'resyncGroup':        return resyncGroup(args[0])
    case 'sync':               return bgSync()
    case 'foregroundSync':     return foregroundSync()
    case 'getReminders':     return getReminders(args[0])
    case 'putReminders':     return putReminders(args[0], args[1])
    case 'getRsvp':          return getRsvp(args[0], args[1])
    case 'listRsvps':        return listRsvps(args[0])
    case 'listMyRsvps':      return listMyRsvps()
    case 'putRsvp':          return putRsvp(args[0], args[1], args[2], args[3])
    case 'getPrivateNote':   return getPrivateNote(args[0])
    case 'putPrivateNote':   return putPrivateNote(args[0], args[1])
    case 'refreshWidgetCache': return refreshWidgetCache()
    // Notifications handled on RN side
    case 'scheduleForEvent': return null
    case 'cancelForEvent':   return null
    case 'restoreAll':       return null
    case 'setMemberNickname': return setMemberNickname(args[0], args[1])
    case 'getBlindPeerKey':  return getBlindPeerKey()
    case 'setBlindPeerKey':  return setBlindPeerKey(args[0])
    case 'removeBlindPeerKey': return removeBlindPeerKey()
    case 'reclaimStorage': return reclaimStorage()
    case 'storageBreakdown': return storageBreakdown()
    case 'analyzeStorage': return analyzeStorage(args[0])
    case 'rebuildLocalDb': return rebuildLocalDb()
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
  rsvp:    'rsvp:',
  privateNotes: 'privateNotes:',
}

async function getPrivateNote (eventId) {
  const node = await db.get(NS.privateNotes + eventId).catch(() => null)
  return node?.value?.text ?? ''
}

async function putPrivateNote (eventId, text) {
  if (!text) await db.del(NS.privateNotes + eventId).catch(() => {})
  else await db.put(NS.privateNotes + eventId, { text, updatedAt: Date.now() })
}

async function getProfile () {
  const node = await db.get(NS.profile)
  return node?.value ?? null
}

async function updateProfile (updates) {
  const current = await getProfile()
  await db.put(NS.profile, { ...current, ...updates, updatedAt: Date.now() })
}

// ── Blind peer key management ────────────────────────────────────────────────

async function getBlindPeerKey () {
  const node = await db.get('blindPeerKey')
  return node?.value?.key ?? null
}

async function setBlindPeerKey (key) {
  if (!key || typeof key !== 'string' || key.length !== 52) {
    throw new Error('Invalid seed peer key: must be a 52-character z32 string')
  }
  await db.put('blindPeerKey', { key, updatedAt: Date.now() })
  await initBlindPeering(key)
  return true
}

async function removeBlindPeerKey () {
  await db.del('blindPeerKey')
  if (blind) {
    blind.close?.()
    blind = null
    console.log('Blind peering disabled')
  }
  return true
}

async function initBlindPeering (key) {
  if (blind) {
    blind.close?.()
    blind = null
  }
  if (!key) return
  const wakeup = new Wakeup()
  blind = new BlindPeering(swarm.dht, store, { keys: [key], wakeup })
  console.log('Blind peering initialized with key:', key.slice(0, 8) + '...')
  // Re-register all active Autobases
  for (const [, base] of bases) {
    blind.addAutobaseBackground(base)
  }
}

async function listEvents (opts) {
  opts = opts || {}
  const { from, to, groupId } = opts
  const gt = NS.events + (from ?? '')
  const lt = NS.events + (to ? to + '\xff' : '\xff')
  const profile = await getProfile()
  const events = []
  for await (const { value } of db.createReadStream({ gt, lt })) {
    if (groupId && !value.groups?.includes(groupId)) continue
    if (!isInvitedToEvent(value, profile?.id)) continue
    const privateNote = await getPrivateNote(value.id)
    events.push(privateNote ? { ...value, privateNote } : value)
  }
  return events
}

async function putEvent (event) {
  const { privateNote, ...rest } = event
  await db.put(NS.events + event.date + ':' + event.id, { ...rest, updatedAt: Date.now() })
  if (privateNote !== undefined) await putPrivateNote(event.id, privateNote)
  scheduleWidgetCacheRefresh()
  return event
}

async function deleteEvent (date, id) {
  await db.del(NS.events + date + ':' + id)
  await db.del('reminders:' + id).catch(() => {})
  await db.del(NS.privateNotes + id).catch(() => {})
  await _deleteAllRsvps(id).catch(() => {})
  scheduleWidgetCacheRefresh()
}

async function deleteEventSeries (recurrenceId) {
  const toDelete = []
  for await (const { key, value } of db.createReadStream({ gt: NS.events, lt: NS.events + '\xff' })) {
    if (value.recurrenceId === recurrenceId) toDelete.push({ key, id: value.id })
  }
  for (const { key, id } of toDelete) {
    await db.del(key)
    await db.del('reminders:' + id).catch(() => {})
    await db.del(NS.privateNotes + id).catch(() => {})
    await _deleteAllRsvps(id).catch(() => {})
  }
  scheduleWidgetCacheRefresh()
}

// ── Widget cache refresh ─────────────────────────────────────────────────────
// Debounced; coalesces bursts from sync mirror loops. RN receives the payload
// via IPC event and writes it to the native widget cache location.
let _widgetRefreshTimer = null
function scheduleWidgetCacheRefresh () {
  if (_widgetRefreshTimer) return
  _widgetRefreshTimer = setTimeout(() => {
    _widgetRefreshTimer = null
    refreshWidgetCache().catch(e => console.error('widget cache refresh:', e.message))
  }, 500)
}

async function refreshWidgetCache () {
  if (!db) return null
  const profile = await getProfile().catch(() => null)
  const payload = await computeTodayCache(db, {
    profileId: profile?.id,
    isInvitedToEvent,
  })
  send({ type: 'event', event: 'widgetCache', data: payload })
  return payload
}

// ── RSVP storage & sync ───────────────────────────────────────────────────────

async function getRsvp (eventId, memberId) {
  const node = await db.get(NS.rsvp + eventId + ':' + memberId).catch(() => null)
  return node?.value ?? null
}

async function listRsvps (eventId) {
  const out = []
  for await (const { value } of db.createReadStream({
    gt: NS.rsvp + eventId + ':',
    lt: NS.rsvp + eventId + ':\xff',
  })) out.push(value)
  return out
}

async function listMyRsvps () {
  // Return Map-like object of { eventId: status } for the current profile
  const profile = await getProfile()
  const myId = profile?.id
  if (!myId) return {}
  const out = {}
  for await (const { value } of db.createReadStream({ gt: NS.rsvp, lt: NS.rsvp + '\xff' })) {
    if (value.memberId === myId) out[value.eventId] = value.status
  }
  return out
}

async function putRsvp (eventId, memberId, status, groupIds = []) {
  const record = { eventId, memberId, status, updatedAt: Date.now() }
  await db.put(NS.rsvp + eventId + ':' + memberId, record)
  // Broadcast to each group so all group members can see the response
  for (const gid of groupIds) {
    const base = bases.get(gid)
    if (!base) continue
    try {
      await base.append({ op: 'put', type: 'rsvp', key: NS.rsvp + eventId + ':' + memberId, value: record })
    } catch(e) { console.warn('[RSVP-SYNC-ERR]', e?.message) }
  }
  return record
}

async function _deleteAllRsvps (eventId) {
  const keys = []
  for await (const { key } of db.createReadStream({
    gt: NS.rsvp + eventId + ':',
    lt: NS.rsvp + eventId + ':\xff',
  })) keys.push(key)
  for (const k of keys) await db.del(k).catch(() => {})
}

async function getReminders (eventId) {
  const node = await db.get('reminders:' + eventId)
  if (node) return node.value
  // One-time migration: seed from legacy event.reminder field
  let legacyReminder = 0
  for await (const { value } of db.createReadStream({ gt: NS.events, lt: NS.events + '\xff' })) {
    if (value.id === eventId) { legacyReminder = value.reminder ?? 0; break }
  }
  if (legacyReminder > 0) {
    const migrated = [legacyReminder]
    await db.put('reminders:' + eventId, migrated)
    return migrated
  }
  return []
}

async function putReminders (eventId, reminders) {
  await db.put('reminders:' + eventId, reminders)
}

async function localDeleteEvent (date, id) {
  await db.del(NS.events + date + ':' + id)
  await db.put('deleted:' + id, { date, ts: Date.now() })
}

async function getGroup (id) {
  const node = await db.get(NS.groups + id)
  return node?.value ?? null
}

async function debugGroup (id) {
  const localNode = await db.get(NS.groups + id).catch(() => null)
  const local = localNode?.value
    ? { m: (localNode.value.members ?? []).map(m => m.name), r: (localNode.value.removedMembers ?? []).map(m => m.name || m.id) }
    : null
  const base = bases.get(id)
  if (!base) return { l: local, v: null, b: false }
  let viewData = null
  try {
    const vNode = await base.view.get(NS.groups + id)
    if (vNode?.value) {
      viewData = { m: (vNode.value.members ?? []).map(m => m.name), r: (vNode.value.removedMembers ?? []).map(m => m.name || m.id) }
    }
  } catch (e) { viewData = { err: e.message } }
  return { l: local, v: viewData, b: true }
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

async function reinviteMember (groupId, memberId) {
  const group = await getGroup(groupId)
  if (!group) return
  // Move from removedMembers → pendingInvites locally for immediate UI responsiveness
  const memberRecord = (group.removedMembers ?? []).find(m => (m.id ?? m) === memberId)
  const removedMembers = (group.removedMembers ?? []).filter(m => (m.id ?? m) !== memberId)
  const pendingInvites = [...(group.pendingInvites ?? [])]
  if (memberRecord && !pendingInvites.some(m => (m.id ?? m) === memberId)) {
    pendingInvites.push(memberRecord)
  }
  const updated = { ...group, removedMembers, pendingInvites }
  await db.put(NS.groups + group.id, updated).catch(() => {})
  // Clear all blockedWriter keys for this member locally
  for await (const { key, value } of db.createReadStream({ gt: 'blockedWriter:' + groupId + ':', lt: 'blockedWriter:' + groupId + ':ÿ' })) {
    if (value?.memberId === memberId) await db.del(key).catch(() => {})
  }
  // Append dedicated Autobase op so all devices process the reinvite deterministically
  // (the local-only group update above would lose LWW against the removal record)
  await syncReinviteMember(groupId, memberId)
}

async function deleteGroup (id) {
  await db.del(NS.groups + id)
  await db.del('joinedAt:' + id).catch(() => {})
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
  // Clear reinstated flag so future removedMembers propagation works
  await db.del('reinstated:' + groupId + ':' + memberId).catch(() => {})
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
const recentSeriesNotifs = new Map()  // groupId:recurrenceId:op → timeout handle; deduplicates recurring series notifications across apply() calls
const notifiedMemberJoins = new Map() // groupId → Set<memberId>; prevents duplicate member-join notifications across apply() replays
const pendingMemberLeaves = new Set()  // {groupId,memberId} JSON strings, pending broadcast to late-connecting peers
const notifiedRsvps = new Set()        // 'eventId:memberId:updatedAt' — prevents duplicate RSVP notifications across apply() replays
const rsvpCoalesce = new Map()         // eventId → { timeout, entries: [{ name, status }] } — debounces RSVP bursts

async function joinGroup (group) {
  if (bases.has(group.id)) return

  // Persist joinedAt as a dedicated key so it survives group record overwrites
  const joinedAtKey = 'joinedAt:' + group.id
  const existingJoin = await db.get(joinedAtKey).catch(() => null)
  if (!existingJoin) {
    await db.put(joinedAtKey, { ts: group.joinedAt || Date.now() })
  }

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

  // Owner adds self as writer, seeds group into Autobase view, then processes pending joiners
  if (isOwner) {
    try {
      const writerKey = b4a.toString(base.local.key, 'hex')
      await base.append({ addWriter: writerKey })
      // Seed the group record into the Autobase view so apply()'s existing check
      // is non-null when a joiner's broadcastSelf arrives (enables join notifications)
      await base.append({ op: 'put', type: 'group', key: NS.groups + group.id, value: { ...group, updatedAt: Date.now() } })
    } catch(e) {
    }

    // Process any writerAnnounce messages that arrived before joinGroup ran
    const pending = pendingWriterAnnouncements.get(group.id)
    if (pending) {
      for (const writerKey of pending) {
        const knownKey = 'knownWriter:' + group.id + ':' + writerKey
        const already = await db.get(knownKey).catch(() => null)
        if (already) continue
        base.append({ addWriter: writerKey })
          .then(() => db.put(knownKey, { ts: Date.now() }).catch(() => {}))
          .catch(e => console.error('[OWNER] pending addWriter error:', e.message))
      }
      pendingWriterAnnouncements.delete(group.id)
    }
  }

  bases.set(group.id, base)

  // Non-owner: broadcast our member record to Autobase once we become writable.
  // This handles the case where the owner's iOS app was in the background when we
  // joined — the invite.js broadcastSelf retries exhaust before addWriter fires.
  // The Autobase 'writable' event fires when addWriter is processed (even across
  // app restarts). A persisted flag prevents redundant re-broadcasts on restarts.
  if (!isOwner) {
    const groupId = group.id
    const doBroadcastSelf = async () => {
      try {
        const alreadyBroadcasted = await db.get('selfBroadcasted:' + groupId).catch(() => null)
        if (alreadyBroadcasted) return
        const p = await getProfile()
        if (!p?.id) return
        const g = await getGroup(groupId)
        if (!g) return
        const initials = (p.name || '').trim().split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 2) || '?'
        const myMember = { id: p.id, name: p.name, avatar: p.avatar ?? initials, publicKey: p.publicKey }
        const updatedGroup = { id: g.id, groupKey: g.groupKey, ownerId: g.ownerId, members: [myMember], updatedAt: Date.now() }
        await base.append({ op: 'put', type: 'group', key: 'groups:' + g.id, value: updatedGroup })
        await db.put('selfBroadcasted:' + groupId, { ts: Date.now() })
        console.log('[BROADCAST_SELF] auto-broadcast succeeded for group:', groupId)
      } catch (e) {
        console.error('[BROADCAST_SELF] auto-broadcast error:', e.message)
      }
    }
    base.once('writable', doBroadcastSelf)
  }

  // Register onAppend for this base so replication triggers apply() even if the
  // peer connection predates joinGroup (e.g. rejoin after voluntary leave).
  // The onopen handler only covers bases that existed when the connection opened.
  const onLateAppend = () => base.update().catch(e => console.warn('[REPL] late-join update error:', e.message))
  base.on('append', onLateAppend)

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

  // Register with blind peer so cores stay available when app is closed
  if (blind) blind.addAutobaseBackground(base)
}

async function leaveGroup (groupId) {
  const base = bases.get(groupId)
  if (base) {
    await base.close()
    bases.delete(groupId)
  }
  await db.del('selfBroadcasted:' + groupId).catch(() => {})
  // Clean up knownWriter keys so members can rejoin cleanly after group recreation
  for await (const { key } of db.createReadStream({ gt: 'knownWriter:' + groupId + ':', lt: 'knownWriter:' + groupId + ':ÿ' })) {
    await db.del(key).catch(() => {})
  }
}

async function syncPutEvent (groupId, event) {
  const base = bases.get(groupId)
  if (!base) throw new Error('Not in group: ' + groupId)
  // Carry _prevDate in the value so receiving devices can clean up the old key
  const { privateNote, ...shared } = event
  const value = { ...shared, updatedAt: event.updatedAt || Date.now() }
  await base.append({ op: 'put', type: 'event', key: 'events:' + event.date + ':' + event.id, value })
}

async function syncDeleteEvent (groupId, eventId, date, updatedByName, updatedById, recurrenceId) {
  const base = bases.get(groupId)
  if (!base) throw new Error('Not in group: ' + groupId)
  const payload = { op: 'del', type: 'event', key: 'events:' + date + ':' + eventId, updatedByName: updatedByName || 'Someone', updatedById: updatedById || '' }
  if (recurrenceId) payload.recurrenceId = recurrenceId
  await base.append(payload)
}

async function syncPutGroup (group) {
  const base = bases.get(group.id)
  console.log('[SYNC_PUT_GROUP] groupId:', group.id, 'members:', JSON.stringify((group.members??[]).map(m=>m.name)), 'updatedAt:', group.updatedAt)
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

async function syncPurgeMember (groupId, memberId) {
  const base = bases.get(groupId)
  if (!base) return
  await base.append({ op: 'purgeMember', groupId, memberId, purgedAt: Date.now() })
}

async function syncReinviteMember (groupId, memberId) {
  const base = bases.get(groupId)
  if (!base) return
  await base.append({ op: 'reinviteMember', groupId, memberId, ts: Date.now() })
}

// Called by iOS BGAppRefreshTask to process any replicated blocks while backgrounded.
// Flushes Hyperswarm to re-establish peer connections, waits for replication,
// then runs base.update() on every active group.
async function bgSync () {
  // Kick Hyperswarm to reconnect — connections drop when iOS suspends the app
  if (swarm) {
    await swarm.flush().catch(() => {})
    // Give peers a few seconds to connect and replicate cores
    await new Promise(r => setTimeout(r, 5000))
  }
  const updates = []
  for (const [, base] of bases) {
    updates.push(base.update().catch(e => console.warn('[BGSYNC] update error:', e.message)))
  }
  await Promise.all(updates)
  // Emit sync so completeBGSync is always called, even if no new data arrived.
  // apply() may have already emitted sync events for changed groups; this is a no-op fallback.
  send({ type: 'event', event: 'sync', data: null })
}

// Called when app returns to foreground — flush Hyperswarm to reconnect peers
// and update all Autobases so the UI shows fresh data immediately.
async function foregroundSync () {
  if (swarm) await swarm.flush().catch(() => {})
  for (const [groupId, base] of bases) {
    try {
      await base.update()
      // Re-mirror group record from Autobase view to local DB to catch any
      // membership changes that mirrorToLocal may have missed during apply()
      const gNode = await base.view.get(NS.groups + groupId)
      if (gNode?.value) {
        const localNode = await db.get(NS.groups + groupId).catch(() => null)
        const localMembers = localNode?.value?.members ?? []
        const viewMembers = gNode.value.members ?? []
        // If the view has fewer members (removal happened), update local DB
        if (viewMembers.length !== localMembers.length ||
            !viewMembers.every(vm => localMembers.some(lm => lm.id === vm.id))) {
          const lv = localNode?.value
          await db.put(NS.groups + groupId, {
            ...gNode.value,
            color: gNode.value.color || lv?.color,
            name:  gNode.value.name  || lv?.name,
            emoji: gNode.value.emoji || lv?.emoji,
            icon:  gNode.value.icon  ?? lv?.icon,
            joinedAt: lv?.joinedAt || gNode.value.joinedAt,
            nickname: lv?.nickname || gNode.value.nickname,
          })
          send({ type: 'event', event: 'sync', data: groupId })
        }
      }
    } catch (e) { console.warn('[FGSYNC] error:', e.message) }
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
        const existing = await db.get(key).catch(() => null)
        const localJoinedAt  = existing?.value?.joinedAt  ?? 0
        const viewUpdatedAt  = value?.updatedAt ?? 0
        // If the Autobase view state pre-dates our current join, the local members
        // written by handleInviteLink are fresher — don't let stale pre-leave data
        // (e.g. old keypair entries from a previous install) pollute the member list.
        const existingMembers = existing?.value?.members ?? []
        const incomingMembers = value.members ?? []
        const mergedMap = new Map()
        for (const m of existingMembers) mergedMap.set(m.id, m)
        for (const m of incomingMembers) {
          const prev = mergedMap.get(m.id)
          if (viewUpdatedAt < localJoinedAt) {
            // Autobase is older than our join — only replace Inviter placeholders,
            // don't add new IDs (prevents stale entries from old profiles on rejoin)
            if (prev && prev.name === 'Inviter' && m.name !== 'Inviter')
              mergedMap.set(m.id, { ...m, avatar: prev.avatar || m.avatar, nickname: m.nickname || prev?.nickname || '' })
          } else {
            if (!prev) {
              mergedMap.set(m.id, m)
            } else if (prev.name === 'Inviter' && m.name !== 'Inviter') {
              mergedMap.set(m.id, { ...m, avatar: prev.avatar || m.avatar, nickname: m.nickname || prev?.nickname || '' })
            } else {
              // Existing member — prefer local avatar (may be newer than view)
              mergedMap.set(m.id, { ...m, avatar: prev.avatar || m.avatar, nickname: prev.nickname || m.nickname || '' })
            }
          }
        }
        const dedupRemoved = deduplicateReinstalls(mergedMap, existingMembers, incomingMembers)
        // Combine removedMembers from all sources
        const removedMap = new Map()
        for (const m of (existing?.value?.removedMembers ?? [])) removedMap.set(m.id ?? m, m)
        for (const m of (value.removedMembers ?? []))           removedMap.set(m.id ?? m, m)
        for (const m of dedupRemoved)                           removedMap.set(m.id, m)
        for (const id of removedMap.keys()) mergedMap.delete(id)
        // Preserve group metadata (color/name/emoji/icon) from local DB when
        // the Autobase view record has none (e.g. joiner's broadcastSelf on rejoin)
        const ev = existing?.value
        await db.put(key, {
          ...value,
          color:   value.color   || ev?.color,
          name:    value.name    || ev?.name,
          emoji:   value.emoji   || ev?.emoji,
          icon:    value.icon    ?? ev?.icon,
          joinedAt: ev?.joinedAt || value.joinedAt,
          removedMembers: [...removedMap.values()],
          members: [...mergedMap.values()]
        })
      }
    }
    send({ type: 'event', event: 'sync', data: groupId })
  } catch(e) { console.error('[RESYNC] error:', e.message) }
}

function isInvitedToEvent (event, profileId) {
  if (!event.invitees || event.invitees.length === 0) return true
  if (event.creatorId === profileId) return true
  return event.invitees.includes(profileId)
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
        console.log('[APPLY]', val.type, val.op, 'incoming:', val.value.updatedAt, 'existing:', existing?.value?.updatedAt, 'win:', !existing || val.value.updatedAt >= (existing?.value?.updatedAt??0))
        if (!existing || !existing.value.updatedAt || !val.value.updatedAt || val.value.updatedAt >= existing.value.updatedAt) {
          // Snapshot local DB group record BEFORE mirrorToLocal so the member-join
          // notification diff sees pre-mirror state (prevents false "already known" on new joins)
          let localGroupBeforeMirror = null
          if (isRemote && val.type === 'group') {
            localGroupBeforeMirror = await db.get(NS.groups + groupId).catch(() => null)
          }
          // Fetch prev from local DB BEFORE mirroring so we can diff in notifySyncChange
          // If date changed, the old entry lives under _prevDate key, not the new key
          let localPrev = null
          if (isRemote && val.type === 'event') {
            localPrev = await db.get(val.key).then(n => n?.value ?? null).catch(() => null)
            if (!localPrev && val.value._prevDate) {
              localPrev = await db.get('events:' + val.value._prevDate + ':' + val.value.id).then(n => n?.value ?? null).catch(() => null)
            }
          }
          // Capture previous RSVP state so we only notify on status change
          let localPrevRsvp = null
          if (isRemote && val.type === 'rsvp') {
            localPrevRsvp = await db.get(val.key).then(n => n?.value ?? null).catch(() => null)
          }
          // For groups: preserve metadata AND merge members from existing view record
          // so that broadcastSelf (which only carries the joiner's member data) can't wipe
          // group metadata or other members via LWW
          let viewValue = val.value
          if (val.type === 'group' && existing?.value) {
            const existMembers = existing.value.members ?? []
            const incMembers = val.value.members ?? []
            // Union removedMembers by ID
            const existRemoved = existing.value.removedMembers ?? []
            const incRemoved = val.value.removedMembers ?? []
            const removedMap = new Map()
            for (const m of existRemoved) removedMap.set(m.id ?? m, m)
            for (const m of incRemoved) removedMap.set(m.id ?? m, m)
            const removedIds = new Set(removedMap.keys())
            // Determine if incoming record is authoritative (sent by owner with full member list)
            // vs a broadcastSelf (joiner sending only their own member record).
            // Owner records include the owner in members[]; broadcastSelf does not.
            const ownerId = val.value.ownerId || existing.value.ownerId
            const isAuthoritative = ownerId && incMembers.some(m => m.id === ownerId)
            const incIds = new Set(incMembers.map(m => m.id))
            // Authoritative: trust incoming members list (owner has full picture);
            // only filter out removedMembers.
            // Non-authoritative (broadcastSelf): union members so partial records don't wipe others.
            const merged = isAuthoritative
              ? incMembers.filter(m => !removedIds.has(m.id))
              : [...incMembers, ...existMembers.filter(m => !incIds.has(m.id))]
                  .filter(m => !removedIds.has(m.id))
            // Don't keep active members in removedMembers
            const activeIds = new Set(merged.map(m => m.id))
            const mergedRemoved = [...removedMap.values()].filter(m => !activeIds.has(m.id ?? m))
            viewValue = {
              ...val.value,
              color: val.value.color || existing.value.color,
              name:  val.value.name  || existing.value.name,
              emoji: val.value.emoji || existing.value.emoji,
              icon:  val.value.icon  ?? existing.value.icon,
              members: merged,
              removedMembers: mergedRemoved,
            }
          }
          await view.put(val.key, viewValue)
          // Always mirror so local DB has latest invitees list — listEvents filters at read time.
          await mirrorToLocal(val.type, val.key, viewValue, groupId)
          // Invitee filter: skip notifications for uninvited events (mirrorToLocal already sent sync).
          if (isRemote && val.type === 'event') {
            const profile = await getProfile()
            if (!isInvitedToEvent(val.value, profile?.id)) continue
          }
          // RSVP response — notify the event creator only
          if (isRemote && val.type === 'rsvp') {
            try { await maybeNotifyRsvp(val.value, localPrevRsvp, groupId) }
            catch (e) { console.warn('[RSVP-NOTIFY]', e?.message) }
          }
          // Notify when a new member joins — detected by diffing member lists on group update
          // Guard: if existing is null, this is first-time sync — skip to avoid spurious notifications
          if (isRemote && val.type === 'group' && existing) {
            try {
              const profile = await getProfile()
              // Skip notifications for group updates that predate our join —
              // these are historical replays during initial Autobase catch-up
              const joinedAtEntry = await db.get('joinedAt:' + groupId).catch(() => null)
              const joinedAt = joinedAtEntry?.value?.ts ?? 0
              if (val.value.updatedAt && val.value.updatedAt < joinedAt) {
                // Historical replay — skip but still track members as seen
                if (!notifiedMemberJoins.has(groupId)) notifiedMemberJoins.set(groupId, new Set())
                const notifiedSet = notifiedMemberJoins.get(groupId)
                for (const m of (val.value.members ?? [])) notifiedSet.add(m.id)
              } else {
              // Use local DB snapshot (captured before mirrorToLocal) as authoritative source —
              // Autobase view may have stale/partial member lists during view rebuilds.
              // Falls back to Autobase view, then empty (owner's first joiner case).
              const existingMembers = localGroupBeforeMirror?.value?.members ?? existing?.value?.members ?? []
              const incomingMembers = val.value.members ?? []
              const existingIds = new Set(existingMembers.map(m => m.id))
              // Dedup: seed notified set from local DB members on first encounter per group
              // so members already known before app restart don't trigger duplicate notifications
              if (!notifiedMemberJoins.has(groupId)) {
                const localMembers = localGroupBeforeMirror?.value?.members ?? []
                notifiedMemberJoins.set(groupId, new Set(localMembers.map(m => m.id)))
              }
              const notifiedSet = notifiedMemberJoins.get(groupId)
              const newMembers = incomingMembers.filter(m =>
                m.id !== profile?.id &&
                m.name !== 'Inviter' &&
                !existingIds.has(m.id) &&
                !notifiedSet.has(m.id) &&
                m.id !== val.value.ownerId  // owner was always there, never a "new" joiner
              )
              for (const m of newMembers) {
                notifiedSet.add(m.id)
                const groupName = val.value.name || existing?.value?.name || localGroupBeforeMirror?.value?.name || 'a group'
                send({ type: 'event', event: 'syncNotify', data: {
                  title: (m.nickname || m.name || 'Someone') + ' joined ' + groupName,
                  body: 'Tap to view the group',
                  tab: 'groups'
                }})
                // If rejoining member was in pendingInvites, remove them
                const localGroup = await db.get(NS.groups + groupId).catch(() => null)
                if (localGroup?.value?.pendingInvites?.some(p => p.id === m.id)) {
                  const updatedPending = { ...localGroup.value,
                    pendingInvites: (localGroup.value.pendingInvites ?? []).filter(p => p.id !== m.id) }
                  await db.put(NS.groups + groupId, updatedPending).catch(() => {})
                  send({ type: 'event', event: 'sync', data: groupId })
                }
              }
              } // end else (non-historical)
            } catch(e) { console.error('[MEMBER_JOIN_NOTIF] error:', e.message) }
          }
          // Admin role change — notify only the affected member (self-check)
          if (isRemote && val.type === 'group' && existing) {
            try {
              const profile = await getProfile()
              const existingAdmins = new Set(existing?.value?.admins ?? [])
              const incomingAdmins = new Set(val.value.admins ?? [])
              const groupName = val.value.name || existing?.value?.name || 'a group'
              if (!existingAdmins.has(profile?.id) && incomingAdmins.has(profile?.id)) {
                send({ type: 'event', event: 'syncNotify', data: {
                  title: 'You’re now an admin of ' + groupName,
                  body: 'You can remove members and manage reinvites',
                  tab: 'groups'
                }})
              } else if (existingAdmins.has(profile?.id) && !incomingAdmins.has(profile?.id)) {
                send({ type: 'event', event: 'syncNotify', data: {
                  title: 'Admin access removed in ' + groupName,
                  body: 'You’ve been returned to regular member status',
                  tab: 'groups'
                }})
              }
            } catch(e) { console.error('[ADMIN_NOTIF] error:', e.message) }
          }
          if (isRemote && val.type === 'event') {
            // Skip notification if user locally deleted this event
            const notifTombstone = await db.get('deleted:' + val.value.id).catch(() => null)
            if (notifTombstone) continue
            // Skip notification for past events (prevents overnight flood from background sync replay)
            const eventDate = val.value.date
            if (eventDate && eventDate < new Date().toISOString().slice(0, 10)) continue
            // Skip notifications for events that predate our join (initial sync flood)
            const joinNode = await db.get('joinedAt:' + groupId).catch(() => null)
            const joinedAt = joinNode?.value?.ts ?? 0
            if (joinedAt && val.value.updatedAt && val.value.updatedAt < joinedAt) continue
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
              const rid = val.value.recurrenceId
              if (rid) {
                // Deduplicate across apply() calls: only fire once per series per op within a 5s window
                const deupKey = groupId + ':' + rid + ':put'
                if (!recentSeriesNotifs.has(deupKey)) {
                  recentSeriesNotifs.set(deupKey, setTimeout(() => recentSeriesNotifs.delete(deupKey), 5000))
                  notifySyncChange({ op: 'put', value: val.value, prev: localPrev, groupId, isSeries: true })
                }
              } else {
                notifySyncChange({ op: 'put', value: val.value, prev: localPrev, groupId })
              }
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
            // Read local DB to preserve nicknames that may not be in the Autobase view yet
            const localGroup = await db.get(val.key).catch(() => null)
            const localMembersMap = new Map()
            for (const m of (localGroup?.value?.members ?? [])) localMembersMap.set(m.id, m)
            const mergedMap = new Map()
            // Seed from winning VIEW value, overlaying local DB nickname if VIEW lacks it
            for (const m of existingMembers) {
              const localM = localMembersMap.get(m.id)
              mergedMap.set(m.id, { ...m, nickname: m.nickname || localM?.nickname || '' })
            }
            // Merge incoming (losing) members, also consulting local DB for nickname.
            // Since this is the LOSING record, prefer the winning member's properties
            // (especially avatar) and only fill in gaps from the incoming member.
            for (const m of incomingMembers) {
              const prev = mergedMap.get(m.id)
              const localM = localMembersMap.get(m.id)
              if (!prev) {
                // Brand new member not in winning record — take incoming entirely
                mergedMap.set(m.id, { ...m, nickname: m.nickname || localM?.nickname || '' })
              } else if (prev.name === 'Inviter' && m.name !== 'Inviter') {
                // Replace Inviter placeholder with real data, but keep winning avatar if it exists
                mergedMap.set(m.id, { ...m, avatar: prev.avatar || m.avatar, nickname: m.nickname || localM?.nickname || prev.nickname || '' })
              } else {
                // Existing member already in winning record — preserve winning properties,
                // only backfill nickname from incoming/local if missing
                mergedMap.set(m.id, { ...prev, nickname: prev.nickname || m.nickname || localM?.nickname || '' })
              }
            }

            // Dedup reinstalls: local DB has the full member list (including stale entry)
            const localMembers = localGroup?.value?.members ?? []
            const allIncoming = [...new Map([...incomingMembers, ...existingMembers].map(m => [m.id, m])).values()]
            const dedupRemoved = deduplicateReinstalls(mergedMap, localMembers, allIncoming)
            // Combine removedMembers from all sources so removals propagate
            const removedMap = new Map()
            for (const m of (localGroup?.value?.removedMembers ?? [])) removedMap.set(m.id ?? m, m)
            for (const m of (winningValue.removedMembers ?? []))      removedMap.set(m.id ?? m, m)
            for (const m of (val.value.removedMembers ?? []))         removedMap.set(m.id ?? m, m)
            for (const m of dedupRemoved)                             removedMap.set(m.id, m)
            // Exclude reinstated members (reinvited or purged via Autobase op)
            for (const id of [...removedMap.keys()]) {
              const reinstated = await db.get('reinstated:' + groupId + ':' + id).catch(() => null)
              if (reinstated) removedMap.delete(id)
            }
            for (const id of removedMap.keys()) mergedMap.delete(id)

            // Preserve metadata: winning record (view) → local DB → losing record
            // The winning record may lack metadata (e.g. joiner's broadcastSelf on
            // rejoin). Fall back to local DB then the losing record which may carry
            // the owner's full group metadata.
            const lv = localGroup?.value
            const merged = {
              ...winningValue,
              color:   winningValue.color   || lv?.color   || val.value.color,
              name:    winningValue.name    || lv?.name    || val.value.name,
              emoji:   winningValue.emoji   || lv?.emoji   || val.value.emoji,
              icon:    winningValue.icon    ?? lv?.icon    ?? val.value.icon,
              removedMembers: [...removedMap.values()],
              members: [...mergedMap.values()]
            }
            await db.put(val.key, merged)
            send({ type: 'event', event: 'sync', data: groupId })
          } else {
            await mirrorToLocal(val.type, val.key, existing.value, groupId)
          }
        }
      } else if (val.op === 'del') {
        await view.del(val.key)
        // Skip local delete for the writer's own event del ops —
        // owner may still hold the event locally (e.g. unshared from a group).
        // For "Delete for Everyone", db.deleteEvent already ran before sync.deleteEvent.
        if (isRemote || val.type !== 'event') await deleteFromLocal(val.type, val.key)
        if (val.type === 'group' && isRemote) {
          // Owner deleted the group — clean up locally and notify UI
          await deleteGroup(groupId)
          await leaveGroup(groupId)
          send({ type: 'event', event: 'groupDeleted', data: groupId })
        } else {
          send({ type: 'event', event: 'sync', data: groupId })
          if (isRemote && val.type === 'event') {
            const eventId = val.key.split(':').pop()
            // Cancel any scheduled notification for this deleted event
            send({ type: 'event', event: 'cancelNotification', data: eventId })
            const delTombstone = await db.get('deleted:' + eventId).catch(() => null)
            if (!delTombstone) {
              const delRid = val.recurrenceId || val.value?.recurrenceId || null
              if (delRid) {
                const dedupKey = groupId + ':' + delRid + ':del'
                if (!recentSeriesNotifs.has(dedupKey)) {
                  recentSeriesNotifs.set(dedupKey, setTimeout(() => recentSeriesNotifs.delete(dedupKey), 5000))
                  notifySyncChange({ op: 'del', key: val.key, updatedByName: val.updatedByName, updatedById: val.updatedById, groupId, isSeries: true })
                }
              } else {
                notifySyncChange({ op: 'del', key: val.key, updatedByName: val.updatedByName, updatedById: val.updatedById, groupId })
              }
            }
          }
        }
      } else if (val.op === 'reinviteMember') {
        const gKey = NS.groups + val.groupId
        const gNode = await view.get(gKey)
        if (gNode?.value) {
          const memberRecord = (gNode.value.removedMembers ?? []).find(m => (m.id ?? m) === val.memberId)
          const updated = {
            ...gNode.value,
            removedMembers: (gNode.value.removedMembers ?? []).filter(m => (m.id ?? m) !== val.memberId),
            pendingInvites: [...(gNode.value.pendingInvites ?? []).filter(p => (p.id ?? p) !== val.memberId),
              ...(memberRecord ? [memberRecord] : [])],
          }
          await view.put(gKey, updated)
          await db.put(gKey, updated)
          // Mark member as reinstated so mirrorToLocal won't re-add them to removedMembers
          await db.put('reinstated:' + val.groupId + ':' + val.memberId, { ts: val.ts }).catch(() => {})
          // Clear blockedWriter and knownWriter keys for this member so they can rejoin
          for await (const { key, value } of db.createReadStream({ gt: 'blockedWriter:' + val.groupId + ':', lt: 'blockedWriter:' + val.groupId + ':ÿ' })) {
            if (value?.memberId === val.memberId) {
              await db.del(key).catch(() => {})
              // Also clear the corresponding knownWriter key so addWriter fires on rejoin
              const writerHex = key.split(':').pop()
              await db.del('knownWriter:' + val.groupId + ':' + writerHex).catch(() => {})
            }
          }
        }
        send({ type: 'event', event: 'sync', data: val.groupId })
      } else if (val.op === 'purgeMember') {
        const gKey = NS.groups + val.groupId
        const gNode = await view.get(gKey)
        if (gNode?.value) {
          const updated = {
            ...gNode.value,
            members: (gNode.value.members ?? []).filter(m => m.id !== val.memberId),
            removedMembers: (gNode.value.removedMembers ?? []).filter(m => (m.id ?? m) !== val.memberId),
          }
          await view.put(gKey, updated)
          await db.put(gKey, updated)
          await db.del(NS.members + val.groupId + ':' + val.memberId).catch(() => {})
          // Mark member as reinstated so mirrorToLocal won't re-add them to removedMembers
          await db.put('reinstated:' + val.groupId + ':' + val.memberId, { ts: val.purgedAt }).catch(() => {})
        }
        send({ type: 'event', event: 'sync', data: val.groupId })
      }
    }
  }
}

async function maybeNotifyRsvp (rsvp, prevRsvp, groupId) {
  if (!rsvp || !rsvp.eventId || !rsvp.memberId) return
  if (rsvp.status !== 'going' && rsvp.status !== 'declined') return
  if (prevRsvp && prevRsvp.status === rsvp.status) return
  const dedup = rsvp.eventId + ':' + rsvp.memberId + ':' + (rsvp.updatedAt ?? 0)
  if (notifiedRsvps.has(dedup)) return
  notifiedRsvps.add(dedup)
  // Find the event (RSVP record doesn't carry the date)
  let event = null
  for await (const { key, value } of db.createReadStream({ gt: 'events:', lt: 'events:\xff' })) {
    if (key.endsWith(':' + rsvp.eventId)) { event = value; break }
  }
  if (!event) return
  // Only the creator gets notified
  const profile = await getProfile().catch(() => null)
  if (!profile?.id || event.creatorId !== profile.id) return
  // Skip replays that predate our join (initial sync flood on rejoin)
  const joinedAtEntry = groupId ? await db.get('joinedAt:' + groupId).catch(() => null) : null
  const joinedAt = joinedAtEntry?.value?.ts ?? 0
  if (rsvp.updatedAt && joinedAt && rsvp.updatedAt < joinedAt) return
  // Resolve member name via group.members[] (nickname-aware, same as notifySyncChange)
  let name = 'Someone'
  if (groupId) {
    const gNode = await db.get(NS.groups + groupId).catch(() => null)
    const m = (gNode?.value?.members ?? []).find(x => x.id === rsvp.memberId)
    if (m && m.name !== 'Inviter') name = m.nickname || m.name || name
  }
  // Coalesce into a per-event burst. One entry per memberId — if the same
  // member flips status inside the window, overwrite so only the final state
  // counts (a single user can't appear as "2 responses").
  const entry = rsvpCoalesce.get(rsvp.eventId) ?? { timeout: null, entries: new Map(), title: event.title || 'your event' }
  entry.entries.set(rsvp.memberId, { name, status: rsvp.status })
  entry.title = event.title || entry.title
  if (entry.timeout) clearTimeout(entry.timeout)
  entry.timeout = setTimeout(() => flushRsvpCoalesce(rsvp.eventId), 5000)
  rsvpCoalesce.set(rsvp.eventId, entry)
}

function flushRsvpCoalesce (eventId) {
  const entry = rsvpCoalesce.get(eventId)
  rsvpCoalesce.delete(eventId)
  if (!entry || entry.entries.size === 0) return
  const responders = [...entry.entries.values()]
  let title, body
  const quoted = '“' + entry.title + '”'
  if (responders.length === 1) {
    const { name, status } = responders[0]
    title = status === 'going' ? name + ' is going to ' + quoted : name + ' declined ' + quoted
    body = ''
  } else {
    const going = responders.filter(e => e.status === 'going').length
    const declined = responders.filter(e => e.status === 'declined').length
    title = responders.length + ' responses to ' + quoted
    const parts = []
    if (going) parts.push(going + ' going')
    if (declined) parts.push(declined + ' declined')
    body = parts.join(' · ')
  }
  send({ type: 'event', event: 'syncNotify', data: { title, body, tab: 'calendar' } })
}

async function notifySyncChange ({ op, value, key, prev, updatedByName, updatedById, groupId, isSeries = false }) {
  try {
    let title = 'Calendar updated'
    let body  = ''
    // Resolve sender name: prefer the nickname this receiver knows them by in the shared group.
    // Look up in the group's members[] array (kept current by mirrorToLocal) rather than the
    // members: namespace, which may still hold the 'Inviter' placeholder from join time.
    const _senderId = value?.updatedById || updatedById || null
    let who = updatedByName || value?.updatedByName || 'Someone'
    if (_senderId && groupId) {
      const _groupNode = await db.get(NS.groups + groupId).catch(() => null)
      const _member = (_groupNode?.value?.members ?? []).find(m => m.id === _senderId)
      if (_member && _member.name !== 'Inviter') {
        who = _member.nickname || _member.name || who
      }
    }

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
          body  = value.date ? 'Now on ' + formatDate(value.date) + (value.allDay ? '' : ' at ' + formatTime(value.start)) : ''

        } else if (notesAdded) {
          title = 'Notes added to ' + what
          body  = value.desc

        } else if (notesEdited) {
          title = 'Notes for ' + what + ' updated by ' + who
          body  = value.desc

        } else if (!prev.location && value.location) {
          title = who + ' set location for ' + what
          body  = value.location

        } else if (prev.location && value.location && prev.location !== value.location) {
          title = who + ' updated location for ' + what
          body  = value.location

        } else if (prev.editPermission !== value.editPermission) {
          // Permission-only change — no notification needed
          return

        } else {
          // No meaningful fields changed (e.g. reminder-only edit) — skip notification
          const noChange =
            prev.title === value.title &&
            prev.date === value.date &&
            prev.start === value.start &&
            prev.end === value.end &&
            prev.allDay === value.allDay &&
            prev.desc === value.desc &&
            prev.location === value.location &&
            prev.color === value.color &&
            JSON.stringify(prev.groups) === JSON.stringify(value.groups)
          if (noChange) return
          title = who + ' updated ' + what
          body  = value.date ? formatDate(value.date) : ''
        }
      }
    }

    if (isSeries && body) body = body + ' · Recurring series'
    else if (isSeries) body = 'Recurring series'
    send({ type: 'event', event: 'syncNotify', data: { title, body, tab: 'calendar' } })
  } catch (e) {
    console.error('notifySyncChange error:', e.message)
    send({ type: 'event', event: 'syncNotify', data: { title: 'Calendar updated', body: '', tab: 'calendar' } })
  }
}
function formatTime (t) {
  if (!t) return ''
  const [hStr, mStr] = t.split(':')
  const h = parseInt(hStr, 10)
  const ampm = h >= 12 ? 'pm' : 'am'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return h12 + ':' + mStr + ampm
}

function formatDate (dateStr) {
  try {
    const [y, m, d] = dateStr.split('-').map(Number)
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
    return months[m - 1] + ' ' + d
  } catch (e) { return dateStr }
}

// Detect reinstall/wipe: a newly-added member with the same name as an existing
// member likely represents the same person with a fresh keypair.  Replace the stale
// entry so the member doesn't appear twice.  Carry over nickname from the old entry.
// Returns array of removed member objects (for adding to removedMembers).
function deduplicateReinstalls (mergedMap, existingMembers, incomingMembers) {
  const removed = []
  const existingIds = new Set(existingMembers.map(m => m.id))
  const incomingIds = new Set(incomingMembers.map(m => m.id))
  // Only look at members that are brand-new (from incoming, not already in existing)
  for (const [id, m] of mergedMap) {
    if (!incomingIds.has(id) || existingIds.has(id)) continue
    if (!m.name || m.name === 'Inviter') continue
    for (const [oldId, oldM] of mergedMap) {
      if (oldId === id) continue
      if (oldM.name === m.name && existingIds.has(oldId)) {
        // Same name, different ID — carry over nickname, remove stale entry
        if (oldM.nickname) {
          mergedMap.set(id, { ...mergedMap.get(id), nickname: oldM.nickname })
        }
        removed.push(oldM)
        mergedMap.delete(oldId)
        break
      }
    }
  }
  return removed
}

async function mirrorToLocal (type, key, value, groupId) {
  try {
    if (type === 'rsvp') {
      // LWW mirror — only overwrite local if incoming is newer
      const existing = await db.get(key).catch(() => null)
      if (!existing || !existing.value?.updatedAt || (value.updatedAt ?? 0) >= existing.value.updatedAt) {
        await db.put(key, value)
        send({ type: 'event', event: 'sync', data: groupId })
      }
      return
    }
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
      // Determine if incoming is authoritative (owner in members list = full picture)
      const ownerId = value.ownerId || existing?.value?.ownerId
      const isAuthoritative = ownerId && incomingMembers.some(m => m.id === ownerId)
      if (isAuthoritative) {
        // Authoritative: trust incoming member list, only preserve nicknames from existing
        for (const m of incomingMembers) {
          const prev = existingMembers.find(e => e.id === m.id)
          mergedMap.set(m.id, { ...m, nickname: m.nickname || prev?.nickname || '' })
        }
      } else {
        // Non-authoritative (broadcastSelf): union members so partial records don't wipe others
        for (const m of existingMembers) mergedMap.set(m.id, m)
        for (const m of incomingMembers) {
          const prev = mergedMap.get(m.id)
          if (!prev || prev.name === 'Inviter' || m.name !== 'Inviter') {
            mergedMap.set(m.id, { ...m, nickname: m.nickname || prev?.nickname || '' })
          }
        }
      }
      const dedupRemoved = deduplicateReinstalls(mergedMap, existingMembers, incomingMembers)
      // Combine removedMembers from incoming + existing + dedup so removals propagate
      const removedMap = new Map()
      for (const m of (existing?.value?.removedMembers ?? [])) removedMap.set(m.id ?? m, m)
      for (const m of (value.removedMembers ?? []))           removedMap.set(m.id ?? m, m)
      for (const m of dedupRemoved)                           removedMap.set(m.id, m)
      // Exclude members that were reinstated (reinvited or purged) — the reinstated:
      // key is set by the reinviteMember/purgeMember Autobase ops in apply()
      for (const id of [...removedMap.keys()]) {
        const reinstated = await db.get('reinstated:' + groupId + ':' + id).catch(() => null)
        if (reinstated) removedMap.delete(id)
      }
      // Filter out any member who appears in removedMembers
      for (const id of removedMap.keys()) mergedMap.delete(id)
      const merged = {
        ...value,
        color:   value.color   || existing?.value?.color,
        name:    value.name    || existing?.value?.name,
        emoji:   value.emoji   || existing?.value?.emoji,
        icon:    value.icon    ?? existing?.value?.icon,
        joinedAt: existing?.value?.joinedAt || value.joinedAt,
        removedMembers: [...removedMap.values()],
        members: [...mergedMap.values()],
        updatedAt: value.updatedAt || Date.now()
      }
      await db.put(key, merged)
    }
    // Notify UI to refresh
    send({ type: 'event', event: 'sync', data: groupId })
    if (type === 'event') scheduleWidgetCacheRefresh()
  } catch(e) {
    console.error('mirrorToLocal error:', e.message)
  }
}

async function deleteFromLocal (type, key) {
  try {
    await db.del(key)
    if (type === 'event') scheduleWidgetCacheRefresh()
  } catch(e) {}
}

// ── Member nickname ──────────────────────────────────────────────────────────────

async function setMemberNickname (groupId, nickname) {
  const profile = await getProfile()
  if (!profile) return
  const memberId = profile.id
  const group = await getGroup(groupId)
  if (!group) return
  const members = (group.members ?? []).map(m =>
    m.id === memberId ? { ...m, nickname: nickname || '' } : m
  )
  const updatedGroup = { ...group, members, updatedAt: Date.now() }
  await putGroup(updatedGroup)
  const memberNode = await db.get(NS.members + groupId + ':' + memberId).catch(() => null)
  if (memberNode?.value) {
    await db.put(NS.members + groupId + ':' + memberId, { ...memberNode.value, nickname: nickname || '' }).catch(() => {})
  }
  const base = bases.get(groupId)
  if (base) {
    await base.append({ op: 'put', type: 'group', key: NS.groups + groupId, value: updatedGroup })
      .catch(e => console.error('[NICKNAME] sync error:', e.message))
  }
  send({ type: 'event', event: 'sync', data: groupId })
}

// ── Storage diagnostics ──────────────────────────────────────────────────────

async function storageBreakdown () {
  const fs = require('bare-fs')
  const path = require('bare-path')

  // Categorize files by name pattern, tracking size + count per category.
  const cats = {
    sst:      { size: 0, count: 0 }, // *.sst — SST table files (live data)
    blob:     { size: 0, count: 0 }, // *.blob — BlobDB large-value files
    log_old:  { size: 0, count: 0 }, // LOG.old.* — rotated info logs (bloat suspect)
    log:      { size: 0, count: 0 }, // LOG, LOG.(num) — current info log + wal rotations
    wal:      { size: 0, count: 0 }, // *.log — WAL
    manifest: { size: 0, count: 0 }, // MANIFEST-* / CURRENT / OPTIONS-*
    other:    { size: 0, count: 0 },
  }
  const perDir = {}
  let total = 0

  async function walk (dir, rel) {
    let entries
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }) }
    catch { return }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { await walk(p, rel ? rel + '/' + e.name : e.name); continue }
      let size = 0
      try { size = (await fs.promises.stat(p)).size } catch { continue }
      total += size
      perDir[rel || '.'] = (perDir[rel || '.'] || 0) + size

      const n = e.name
      let cat = 'other'
      if (n.endsWith('.sst')) cat = 'sst'
      else if (n.endsWith('.blob')) cat = 'blob'
      else if (n.startsWith('LOG.old.')) cat = 'log_old'
      else if (n === 'LOG' || /^LOG\.\d+$/.test(n)) cat = 'log'
      else if (n.endsWith('.log')) cat = 'wal'
      else if (n.startsWith('MANIFEST-') || n === 'CURRENT' || n.startsWith('OPTIONS-') || n === 'IDENTITY') cat = 'manifest'
      cats[cat].size += size
      cats[cat].count += 1
    }
  }

  await walk(dataDir, '')
  return { total, cats, perDir }
}

// ── Storage analyzer ─────────────────────────────────────────────────────────
// Estimates how much of each group's writer-core bytes could be reclaimed if
// blocks before a "keep tail" were cleared + compacted.
// `keepTail` = how many most-recent blocks to preserve per writer (default 100).

async function analyzeStorage ({ keepTail = 100 } = {}) {
  const groups = []
  let totalBytes = 0
  let reclaimableBytes = 0

  // Local DB (pearcal/core) — single Hypercore under Hyperbee.
  if (db?.core) {
    const core = db.core
    const length = core.length
    const byteLength = core.byteLength
    const clearableBlocks = Math.max(0, length - keepTail)
    const estReclaim = length > 0 ? Math.floor(byteLength * clearableBlocks / length) : 0
    groups.push({
      id: '__local__', name: '(local DB)', bytes: byteLength, reclaim: 0,
      writers: [{ role: 'local', key: '-', length, byteLength, clearableBlocks: 0, estReclaim: 0 }],
    })
    totalBytes += byteLength
  }

  // Walk every core known to the corestore (incl. orphaned / deleted-group cores)
  try {
    const seen = new Set()
    for (const base of bases.values()) {
      for (const w of base.activeWriters) if (w.core?.key) seen.add(w.core.key.toString('hex'))
      const vc = base.view?.core || base.view?.feed
      if (vc?.key) seen.add(vc.key.toString('hex'))
    }
    const orphans = []
    let orphanBytes = 0
    if (store?.cores) {
      for (const core of store.cores.values()) {
        if (!core?.key) continue
        const hex = core.key.toString('hex')
        if (seen.has(hex)) continue
        orphans.push({ role: 'orphan', key: hex.slice(0, 12), length: core.length, byteLength: core.byteLength, clearableBlocks: core.length, estReclaim: core.byteLength })
        orphanBytes += core.byteLength
      }
    }
    if (orphans.length) {
      groups.push({ id: '__orphans__', name: '(orphaned cores)', bytes: orphanBytes, reclaim: orphanBytes, writers: orphans })
      totalBytes += orphanBytes
      reclaimableBytes += orphanBytes
    }
  } catch (e) { console.warn('[analyze] orphan scan failed:', e.message) }

  for (const [groupId, base] of bases.entries()) {
    const writers = []
    let groupBytes = 0
    let groupReclaim = 0

    // Collect candidate cores to analyze: all activeWriters + the view core.
    const candidates = []
    for (const w of base.activeWriters) {
      if (w.core) candidates.push({ role: 'writer', core: w.core })
    }
    // Autobase view: if it's a Hyperbee, its backing Hypercore is view.core (or view.feed).
    const view = base.view
    if (view) {
      const viewCore = view.core || view.feed
      if (viewCore) candidates.push({ role: 'view', core: viewCore })
    }

    for (const { role, core } of candidates) {
      const length = core.length
      const byteLength = core.byteLength
      const clearableBlocks = role === 'view' ? 0 : Math.max(0, length - keepTail)
      const estReclaim = length > 0 ? Math.floor(byteLength * clearableBlocks / length) : 0
      writers.push({
        role,
        key: core.key ? core.key.toString('hex').slice(0, 12) : '?',
        length,
        byteLength,
        clearableBlocks,
        estReclaim,
      })
      groupBytes += byteLength
      groupReclaim += estReclaim
    }

    // Look up group name from local DB
    let name = groupId
    try {
      const n = await db.get('groups:' + groupId)
      if (n?.value?.name) name = n.value.name
    } catch {}

    groups.push({ id: groupId, name, bytes: groupBytes, reclaim: groupReclaim, writers })
    totalBytes += groupBytes
    reclaimableBytes += groupReclaim
  }

  const pct = totalBytes > 0 ? Math.round(100 * reclaimableBytes / totalBytes) : 0
  return { keepTail, totalBytes, reclaimableBytes, pct, groups }
}

// ── Local DB rebuild ─────────────────────────────────────────────────────────
// Rewrites `pearcal/core` to drop historical Hyperbee tree nodes + stale event
// payloads. Events and member rosters get re-mirrored from each group's
// Autobase view, so group membership is unaffected.

let rebuildBusy = false

async function rebuildLocalDb () {
  if (rebuildBusy) throw new Error('rebuild already running')
  rebuildBusy = true
  const fs = require('bare-fs')
  const path = require('bare-path')

  async function dirSize (dir) {
    let total = 0
    let entries
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }) }
    catch { return 0 }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) total += await dirSize(p)
      else { try { total += (await fs.promises.stat(p)).size } catch {} }
    }
    return total
  }

  const coreDir = dataDir + '/core'
  const newDir  = dataDir + '/core.new'
  const bakDir  = dataDir + '/core.old'

  try {
    const before = await dirSize(coreDir)

    // Ensure no stale temp dirs from a prior aborted run.
    try { await fs.promises.rm(newDir, { recursive: true, force: true }) } catch {}
    try { await fs.promises.rm(bakDir, { recursive: true, force: true }) } catch {}

    const newCore = new Hypercore(newDir, { valueEncoding: 'json' })
    await newCore.ready()
    const newDb = new Hyperbee(newCore, { keyEncoding: 'utf-8', valueEncoding: 'json' })
    await newDb.ready()

    // Copy everything except events:* and members:* (those re-mirror from Autobase).
    let kept = 0
    for await (const entry of db.createReadStream()) {
      const k = entry.key
      if (k.startsWith('events:') || k.startsWith('members:')) continue
      await newDb.put(k, entry.value)
      kept++
    }

    // Re-mirror events and members from each group's Autobase view.
    let mirrored = 0
    for (const base of bases.values()) {
      if (!base.view) continue
      for await (const entry of base.view.createReadStream()) {
        const k = entry.key
        if (k.startsWith('events:') || k.startsWith('members:')) {
          await newDb.put(k, entry.value)
          mirrored++
        }
      }
    }

    await newDb.close()
    await newCore.close()
    await db.close()

    await fs.promises.rename(coreDir, bakDir)
    await fs.promises.rename(newDir, coreDir)

    const core = new Hypercore(coreDir, { valueEncoding: 'json' })
    await core.ready()
    db = new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'json' })
    await db.ready()

    try { await fs.promises.rm(bakDir, { recursive: true, force: true }) } catch {}

    // Opportunistic compaction for corestore side too.
    try {
      if (store?.storage?.db) {
        await store.storage.db.compactRange(null, null, {
          exclusive: true, blobGarbageCollectionPolicy: 1, bottommostLevelCompaction: 2,
        })
      }
    } catch (e) { console.warn('[rebuild] store compact failed:', e.message) }

    const after = await dirSize(coreDir)
    return { before, after, freed: before - after, kept, mirrored }
  } finally {
    rebuildBusy = false
  }
}

// ── Storage reclamation ──────────────────────────────────────────────────────

async function reclaimStorage () {
  const fs = require('bare-fs')
  const path = require('bare-path')

  async function dirSize (dir) {
    let total = 0
    let entries
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }) }
    catch { return 0 }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) total += await dirSize(p)
      else {
        try { total += (await fs.promises.stat(p)).size } catch {}
      }
    }
    return total
  }

  const before = await dirSize(dataDir)
  const opts = { exclusive: true, blobGarbageCollectionPolicy: 1, bottommostLevelCompaction: 2 }
  const errors = []

  try {
    if (db?.core?.state?.storage?.db) {
      await db.core.state.storage.db.compactRange(null, null, opts)
    }
  } catch (e) { errors.push('core: ' + e.message); console.warn('[reclaim] core compact failed:', e.message) }

  try {
    if (store?.storage?.db) {
      await store.storage.db.compactRange(null, null, opts)
    }
  } catch (e) { errors.push('store: ' + e.message); console.warn('[reclaim] store compact failed:', e.message) }

  const after = await dirSize(dataDir)
  return { before, after, freed: before - after, errors }
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function shutdown () {
  try {
    if (blind) { blind.close?.(); blind = null }
    if (swarm) { await swarm.destroy(); swarm = null }
    if (store) { await store.close(); store = null }
    if (db) { await db.close(); db = null }
    bases.clear()
    pendingMemberLeaves.clear()
    console.log('Shutdown complete')
  } catch(e) {
    console.error('Shutdown error:', e.message)
  }
}

let _initPromise = null
async function init (dir, attempt = 0) {
  // Prevent concurrent init calls — wait for any in-progress init to finish
  if (_initPromise && attempt === 0) {
    console.log('Init already in progress, waiting...')
    await _initPromise
    return
  }
  // If already initialized, shut down first to release DB locks cleanly
  if (db) {
    console.log('Re-init requested, shutting down first...')
    await shutdown()
  }
  _initPromise = _doInit(dir, attempt)
  try { await _initPromise } finally { _initPromise = null }
}
async function _doInit (dir, attempt = 0) {
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
            // Process any blocks that replicated before onopen fired (race fix for late joiners)
            base.update().catch(e => console.warn('[REPL] initial update error:', e.message))
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
                  // Notify removed member before deleting group
                  const ownerMember = (group?.members ?? []).find(m => m.id === group?.ownerId)
                  const ownerName = ownerMember?.name || 'The owner'
                  const groupName = group?.name || 'a group'
                  send({ type: 'event', event: 'syncNotify', data: {
                    title: ownerName + ' removed you from ' + groupName,
                    body: 'You no longer have access to this group.',
                    tab: 'groups'
                  }})
                  await db.put('blockedFromGroup:' + groupId, { ts: Date.now() }).catch(() => {})
                  await deleteGroup(groupId)
                  await leaveGroup(groupId)
                  send({ type: 'event', event: 'groupDeleted', data: groupId })
                  return
                }
                if (group && profile && group.ownerId === profile.id) {
                  const leavingMember = (group.members ?? []).find(m => m.id === memberId)
                  // Already processed — member is no longer in the group
                  if (!leavingMember) {
                    await db.del('pendingLeave:' + groupId + ':' + memberId).catch(() => {})
                    return
                  }
                  const updated = {
                    ...group,
                    members: (group.members ?? []).filter(m => m.id !== memberId),
                    updatedAt: Date.now()
                  }
                  await putGroup(updated)
                  // Clear writer announcements for this group so the member can rejoin cleanly
                  pendingWriterAnnouncements.delete(groupId)
                  // Remove persisted pending leave now that it's been processed
                  await db.del('pendingLeave:' + groupId + ':' + memberId).catch(() => {})
                  // Notify owner that member left
                  const leavingName = leavingMember?.nickname || leavingMember?.name || 'Someone'
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
                await db.put('blockedFromGroup:' + gid, { ts: Date.now() }).catch(() => {})
                await deleteGroup(gid).catch(() => {})
                await leaveGroup(gid).catch(() => {})
                send({ type: 'event', event: 'inviteBlocked', data: gid })
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
              Promise.all([getProfile(), getGroup(groupId)]).then(async ([profile, group]) => {
                const isOwner = group && group.ownerId === profile.id
                if (isOwner) {
                  const connKey = groupId + ':' + writerKey
                  if (!connSeenWriters.has(connKey)) {
                    connSeenWriters.add(connKey)
                    // Still track globally to handle duplicate announcements from same peer
                    const set = pendingWriterAnnouncements.get(groupId) || new Set()
                    set.add(writerKey)
                    pendingWriterAnnouncements.set(groupId, set)
                    // Check blocklist before granting write access — only block members
                    // explicitly removed (kicked) by the owner
                    const removedMembers = group.removedMembers ?? []
                    const parsed_memberId = parsed.memberId ?? null
                    if (parsed_memberId && removedMembers.some(m => (m.id ?? m) === parsed_memberId)) {
                      // Store writerKey so apply() can also block Autobase log replay
                      await db.put('blockedWriter:' + groupId + ':' + parsed.writerKey, { memberId: parsed_memberId, ts: Date.now() }).catch(() => {})
                      try {
                        const ownerProfile = await getProfile().catch(() => null)
                        msg.send(Buffer.from(JSON.stringify({ blocked: true, groupId, ownerName: ownerProfile?.name || 'The owner' })))
                      } catch(e) {}
                      return
                    }
                    // Clear knownWriter so addWriter fires for rejoining members
                    if (parsed_memberId) {
                      await db.del('knownWriter:' + groupId + ':' + writerKey).catch(() => {})
                    }
                    // Skip addWriter + rebroadcast if this writer is already known (persisted across restarts)
                    const knownWriterKey = 'knownWriter:' + groupId + ':' + writerKey
                    const alreadyGranted = await db.get(knownWriterKey).catch(() => null)
                    if (alreadyGranted) {
                      console.log('[ADDWRITER] writer already known, skipping:', writerKey.slice(0, 16), 'for group:', groupId)
                      return
                    }
                    console.log('[ADDWRITER] granting write to:', writerKey, 'for group:', groupId)
                    base.append({ addWriter: writerKey })
                      .then(async () => {
                        // Persist so we skip redundant addWriter on future reconnects
                        await db.put(knownWriterKey, { ts: Date.now() }).catch(() => {})
                        // Wait briefly for joiner's broadcastSelf to arrive before rebroadcasting
                        // so we can merge their real name into the group record
                        await new Promise(r => setTimeout(r, 2000))
                        try {
                          const g = await getGroup(groupId)
                          if (g) {
                            await base.append({ op: 'put', type: 'group', key: 'groups:' + groupId, value: { ...g, updatedAt: Date.now() } })
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
        name:      '',
        avatar:    '',
        publicKey: b4a.toString(pk, 'hex'),
        secretKey: b4a.toString(sk, 'hex'),
        createdAt: Date.now(),
      })
    }

    // Fix empty avatar for existing profiles that have a name but no avatar
    const profileNode = await db.get(NS.profile)
    if (profileNode?.value && !profileNode.value.avatar && profileNode.value.name?.trim()) {
      const n = profileNode.value.name
      const initials = n.trim().split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0,2) || '?'
      await db.put(NS.profile, { ...profileNode.value, avatar: initials })
    }
    // Re-join all existing groups
    const groups = []
    for await (const { value } of db.createReadStream({ gt: NS.groups, lt: NS.groups + '\xff' })) {
      groups.push(value)
    }

    // Startup dedup: clean up same-name duplicate members left over from
    // reinstall/wipe rejoins that occurred before the dedup logic was deployed.
    // Also adds stale entries to removedMembers so the cleanup propagates via Autobase.
    for (const g of groups) {
      const members = g.members ?? []
      if (members.length < 2) continue
      const nameCount = new Map()
      for (const m of members) {
        if (m.name && m.name !== 'Inviter') nameCount.set(m.name, (nameCount.get(m.name) || 0) + 1)
      }
      // Any name appearing more than once → run dedup
      if ([...nameCount.values()].some(c => c > 1)) {
        const deduped = new Map()
        for (const m of members) deduped.set(m.id, m)
        const staleRemoved = []
        const nameToId = new Map()
        for (const [id, m] of deduped) {
          if (!m.name || m.name === 'Inviter') continue
          const prevId = nameToId.get(m.name)
          if (prevId && prevId !== id) {
            const prevM = deduped.get(prevId)
            if (prevM?.nickname) deduped.set(id, { ...deduped.get(id), nickname: prevM.nickname })
            staleRemoved.push(prevM)
            deduped.delete(prevId)
          }
          nameToId.set(m.name, id)
        }
        if (deduped.size < members.length) {
          // Merge stale entries into removedMembers so the removal propagates
          const removedMap = new Map()
          for (const m of (g.removedMembers ?? [])) removedMap.set(m.id ?? m, m)
          for (const m of staleRemoved)              removedMap.set(m.id, m)
          const cleaned = { ...g, members: [...deduped.values()], removedMembers: [...removedMap.values()] }
          await db.put(NS.groups + g.id, cleaned).catch(() => {})
          console.log('[STARTUP_DEDUP] cleaned duplicate members in group:', g.id, 'removed:', staleRemoved.map(m => m.name))
        }
      }
    }

    // Initialize blind peering from user-configured key (if any)
    const savedKey = await getBlindPeerKey()
    if (savedKey) {
      await initBlindPeering(savedKey)
    }

    for (const g of groups) {
      await joinGroup(g).catch(e => console.error('joinGroup error:', e.message))
    }

    // Reload persisted pending member leaves so they can be delivered on next peer connection
    try {
      for await (const entry of db.createReadStream({ gt: 'pendingLeave:', lt: 'pendingLeave:~' })) {
        const { groupId, memberId, groupKey } = entry.value
        pendingMemberLeaves.add(JSON.stringify({ groupId, memberId }))
        if (groupKey && !bases.has(groupId)) {
          try {
            const topic = b4a.from(groupKey.slice(0, 64).padEnd(64, '0'), 'hex')
            swarm.join(topic, { server: false, client: true })
          } catch(e) {}
        }
      }
    } catch(e) {}

    console.log('DB ready, groups rejoined:', groups.length)
    _dbReady = true
    _dbReadyResolve()
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
