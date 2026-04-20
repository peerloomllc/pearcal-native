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
const { canonicalize, signMessage, verifySignature } = require('./lib/sign.js')
const { rekeyGroup: _rekeyGroupLib } = require('./lib/rekey.js')
const {
  markerKey: migrationMarkerKey,
  buildMarker: buildMigrationMarker,
  verifyMarker: verifyMigrationMarker,
  readMarker: readMigrationMarker,
} = require('./lib/migration.js')

const send = (msg) => BareKit.IPC.write(Buffer.from(JSON.stringify(msg) + '\n'))

let db      = null   // main Hyperbee (local profile/events/groups)
let store   = null   // Corestore for Autobase
let swarm   = null   // Hyperswarm
let dataDir = null

const bases = new Map()   // groupId → Autobase
// Groups whose Autobase view contains a verified groupMigration: marker.
// Apply-level gate: once a group is migrated, further put/del/addWriter nodes
// against its OLD base become local no-ops so late writers can't create ghost
// state. Populated on joinGroup (from view) and on marker apply (live).
const migratedGroups = new Set()
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
    case 'removeBrokenGroup': return removeBrokenGroup(args[0])
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
    case 'deleteEvent:sync': return syncDeleteEvent(args[0], args[1], args[2], args[3], args[4], args[5], args[6])
    case 'putGroup:sync':    return syncPutGroup(args[0])
    case 'deleteGroup:sync':  return syncDeleteGroup(args[0])
    case 'memberLeft:sync':   return syncMemberLeft(args[0], args[1])
    case 'purgeMember:sync':      return syncPurgeMember(args[0], args[1])
    case 'reinviteMember:sync':   return syncReinviteMember(args[0], args[1])
    case 'resyncGroup':        return resyncGroup(args[0])
    case 'resyncAll':          return resyncAll()
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
    case 'scheduleMorningDigest': return scheduleMorningDigest()
    // Notifications handled on RN side
    case 'scheduleForEvent': return null
    case 'cancelForEvent':   return null
    case 'restoreAll':       return null
    case 'setMemberNickname': return setMemberNickname(args[0], args[1])
    case 'getBlindPeerKey':  return getBlindPeerKey()
    case 'setBlindPeerKey':  return setBlindPeerKey(args[0])
    case 'removeBlindPeerKey': return removeBlindPeerKey()
    case 'rekeyGroup':       return rekeyGroup(args[0])
    case 'commitRekey':      return commitRekey(args[0])
    case 'purgeMigratedGroup':    return purgeMigratedGroup(args[0], args[1] ?? {})
    case 'purgeAllMigratedGroups': return purgeAllMigratedGroups(args[0] ?? {})
    case 'auditStorage':     return auditStorage(args[0] ?? {})
    case 'purgeOrphanDataRanges': return purgeOrphanDataRanges(args[0] ?? {})
    case 'reclaimStorage': return reclaimStorage()
    case 'storageBreakdown': return storageBreakdown()
    case 'getAvatar':        return getAvatar(args[0])
    case 'listAvatarHashes': return listAvatarHashes()
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
  avatars: 'avatars:',
  deleted: 'deleted:',
}

// Tombstones (`deleted:{eventId}`) guard against sync-replay resurrection and
// duplicate delete notifications. After this window the originating delete op
// will have linearized on every peer's Autobase, so the guard is no longer
// load-bearing and the record is safe to drop.
const TOMBSTONE_TTL_MS = 180 * 24 * 60 * 60 * 1000

async function getAvatar (hash) {
  if (!hash) return null
  const node = await db.get(NS.avatars + hash).catch(() => null)
  return node?.value?.data ?? null
}

async function listAvatarHashes () {
  const hashes = []
  for await (const { key } of db.createReadStream({ gt: NS.avatars, lt: NS.avatars + '\xff' })) {
    hashes.push(key.slice(NS.avatars.length))
  }
  return hashes
}

// Hash an avatar data URI deterministically. Returns null for anything that
// isn't a data: URI (initials fallback, empty, etc.). Uses blake2b-128 (16
// bytes, 32-char hex) — collision probability is negligible at this scale.
function hashAvatar (data) {
  if (typeof data !== 'string' || !data.startsWith('data:')) return null
  const out = b4a.alloc(16)
  sodium.crypto_generichash(out, b4a.from(data))
  return b4a.toString(out, 'hex')
}

// Store an avatar data URI in the local avatars: keyspace (put-if-absent)
// and return its hash, or null if `data` is not a data: URI.
async function storeAvatarLocal (data) {
  const hash = hashAvatar(data)
  if (!hash) return null
  const existing = await db.get(NS.avatars + hash).catch(() => null)
  if (!existing) {
    const mimeMatch = /^data:([^;]+);/.exec(data)
    await db.put(NS.avatars + hash, {
      data,
      mime: mimeMatch ? mimeMatch[1] : 'image/jpeg',
      bytes: data.length,
      updatedAt: Date.now(),
    })
  }
  return hash
}

// Rewrite a list of members so inline avatars become avatarHash refs. Returns
// { members, newHashes } — newHashes contains hashes NOT yet in the given
// dedup set (caller can use to decide what avatar ops to append to Autobase).
async function splitMembersInline (members, seenHashes) {
  if (!Array.isArray(members) || members.length === 0) return { members, newHashes: [] }
  const out = []
  const newHashes = []
  for (const m of members) {
    if (!m) continue
    const inline = m.avatar
    if (typeof inline === 'string' && inline.startsWith('data:')) {
      const hash = await storeAvatarLocal(inline)
      if (hash) {
        if (seenHashes && !seenHashes.has(hash)) {
          seenHashes.add(hash)
          newHashes.push({ hash, data: inline })
        }
        // Keep avatar field omitted (hash-only on the wire)
        const { avatar, ...rest } = m
        out.push({ ...rest, avatarHash: hash })
        continue
      }
    }
    out.push(m)
  }
  return { members: out, newHashes }
}

// Append a group op to the Autobase, splitting any inline avatars in
// members[] into separate avatar ops first so each unique avatar is written
// at most once across the group's history. `baseView` lets us check whether
// a hash is already present in the Autobase view to avoid re-appending.
async function appendGroupWithAvatarSplit (base, groupValue) {
  const seen = new Set()
  // Pre-seed with hashes already in this Autobase view so we don't re-append.
  try {
    const view = base.view
    for await (const { key } of view.createReadStream({
      gt: NS.avatars, lt: NS.avatars + '\xff',
    })) {
      seen.add(key.slice(NS.avatars.length))
    }
  } catch (e) { /* view may not be ready on first append */ }
  const { members, newHashes } = await splitMembersInline(groupValue.members, seen)
  for (const { hash, data } of newHashes) {
    const mimeMatch = /^data:([^;]+);/.exec(data)
    await base.append({
      op: 'put',
      type: 'avatar',
      key: NS.avatars + hash,
      value: {
        data,
        mime: mimeMatch ? mimeMatch[1] : 'image/jpeg',
        bytes: data.length,
        updatedAt: Date.now(),
      },
    })
  }
  const value = { ...groupValue, members, updatedAt: groupValue.updatedAt || Date.now() }
  await base.append({ op: 'put', type: 'group', key: NS.groups + groupValue.id, value })
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
  if ('digestEnabled' in updates || 'digestHour' in updates || 'digestMinute' in updates) {
    scheduleMorningDigest().catch(e => console.warn('morning digest reschedule:', e.message))
  }
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
  scheduleMorningDigest().catch(e => console.warn('morning digest refresh:', e.message))
  return payload
}

// ── Morning digest ───────────────────────────────────────────────────────────
// Daily notification at user-chosen hour (default 9 AM). Pre-schedules the
// next 3 occurrences so users who ignore the app for a few days still get
// reminded to foreground — which is what actually wakes Hyperswarm and
// replicates pending group changes from peers.
const DIGEST_LOOKAHEAD_DAYS = 3

function _nthMorningMs (nowMs, n, hour, minute) {
  const d = new Date(nowMs)
  d.setHours(hour, minute, 0, 0)
  if (d.getTime() <= nowMs) d.setDate(d.getDate() + 1)
  d.setDate(d.getDate() + n)
  return d.getTime()
}

function _isoDate (ms) {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return y + '-' + m + '-' + day
}

function _formatTime (start) {
  const parts = (start ?? '').split(':')
  const h = Number(parts[0])
  const m = Number(parts[1])
  if (isNaN(h)) return ''
  const h12 = ((h + 11) % 12) + 1
  const ampm = h >= 12 ? 'pm' : 'am'
  const mStr = m === 0 ? '' : ':' + String(m).padStart(2, '0')
  return h12 + mStr + ampm
}

function _buildDigestBody (events) {
  if (!events || events.length === 0) {
    return 'No events today — tap to check for updates'
  }
  const sorted = events.slice().sort((a, b) => {
    if (a.allDay && !b.allDay) return -1
    if (!a.allDay && b.allDay) return 1
    return (a.start ?? '').localeCompare(b.start ?? '')
  })
  const previews = sorted.slice(0, 2).map(ev => {
    if (ev.allDay) return ev.title
    const t = _formatTime(ev.start)
    return t ? (t + ' ' + ev.title) : ev.title
  })
  const count = events.length
  const head = count === 1 ? '1 event today' : (count + ' events today')
  return head + ' — ' + previews.join(', ')
}

async function scheduleMorningDigest () {
  if (!db) return
  const profile = await getProfile().catch(() => null)
  // Don't schedule until onboarding is complete — avoids nagging users
  // who haven't finished setup yet.
  if (!profile?.onboardingComplete) return
  const enabled = profile?.digestEnabled !== false
  if (!enabled) {
    send({ type: 'event', event: 'cancelMorningDigest', data: null })
    return
  }
  const hour = Number.isFinite(Number(profile?.digestHour)) ? Number(profile.digestHour) : 9
  const minute = Number.isFinite(Number(profile?.digestMinute)) ? Number(profile.digestMinute) : 0
  const now = Date.now()
  const items = []
  for (let i = 0; i < DIGEST_LOOKAHEAD_DAYS; i++) {
    const fireAt = _nthMorningMs(now, i, hour, minute)
    const dateStr = _isoDate(fireAt)
    const events = await listEvents({ from: dateStr, to: dateStr }).catch(() => [])
    const visible = events.filter(e => !e.isShadow)
    items.push({
      slot: i,
      fireAt,
      title: 'Good morning',
      body: _buildDigestBody(visible),
    })
  }
  send({ type: 'event', event: 'scheduleMorningDigest', data: items })
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
  await db.put(NS.deleted + id, { date, ts: Date.now() })
}

async function pruneExpiredTombstones () {
  const cutoff = Date.now() - TOMBSTONE_TTL_MS
  const stale = []
  try {
    for await (const { key, value } of db.createReadStream({ gt: NS.deleted, lt: NS.deleted + '\xff' })) {
      const ts = value?.ts
      if (typeof ts !== 'number' || ts < cutoff) stale.push(key)
    }
    for (const key of stale) {
      await db.del(key).catch(() => {})
    }
    if (stale.length > 0) console.log('[TOMBSTONE_PRUNE] dropped', stale.length, 'expired tombstones')
  } catch (e) {
    console.warn('[TOMBSTONE_PRUNE] error:', e.message)
  }
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
    // Tombstoned by a group-migration marker — user-invisible; the new group
    // record (keyed by migratedFrom ↔ this id) carries all live state.
    if (value?.migratedTo) continue
    // Tombstoned by removeBrokenGroup — user forgot this group. Force-stop may
    // have lost the `db.del(NS.groups + id)` write before it fsynced, so the
    // record can re-appear on disk. Filter here so the UI never sees it even
    // if the startup cleanup hasn't run yet. Lazy cleanup: if we find a stray
    // record, kick off a delete in the background.
    if (value?.id && await isForgottenGroup(value.id)) {
      deleteGroup(value.id).catch(() => {})
      continue
    }
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

// Mark a group as broken on the LOCAL record only — never synced via Autobase
// (since `brokenAt`/`brokenError` are local diagnostics, not group state). UI
// reads these to render the recovery banner in Group Settings.
async function markGroupBroken (groupId, error) {
  const cur = await db.get(NS.groups + groupId).catch(() => null)
  if (!cur?.value) return
  await db.put(NS.groups + groupId, {
    ...cur.value,
    brokenAt: Date.now(),
    brokenError: String(error?.message || error || 'unknown')
  }).catch(() => {})
}

async function clearGroupBroken (groupId) {
  const cur = await db.get(NS.groups + groupId).catch(() => null)
  if (!cur?.value) return
  if (cur.value.brokenAt == null && cur.value.brokenError == null) return
  const { brokenAt, brokenError, ...rest } = cur.value
  await db.put(NS.groups + groupId, rest).catch(() => {})
}

// Durable tombstone preventing a removed broken group from being
// re-materialised by mirrorToLocal / foregroundSync / adopt on subsequent
// peer writes. Checked by every group-record writeback path.
async function isForgottenGroup (groupId) {
  const node = await db.get('forgottenGroup:' + groupId).catch(() => null)
  return !!node?.value
}

// User-initiated cleanup for a group whose base failed to open. Writes a
// tombstone first so any in-flight apply()/mirror can't race us and
// re-create the record. Leaves the swarm topic (if the groupKey is known)
// so we stop answering peer connections for it. Then closes the base if
// it somehow did open, wipes local DB state via deleteGroup, and clears
// the durable knownWriter index. Orphan namespace cores left behind in
// the corestore will be reclaimed by the next auditStorage sweep.
async function removeBrokenGroup (groupId) {
  const existing = await db.get(NS.groups + groupId).catch(() => null)
  const groupKey = existing?.value?.groupKey
  await db.put('forgottenGroup:' + groupId, { ts: Date.now() }).catch(() => {})
  if (groupKey) {
    try {
      const topic = b4a.from(groupKey.slice(0, 64).padEnd(64, '0'), 'hex')
      await swarm.leave(topic).catch(() => {})
    } catch (e) { console.warn('[REMOVE_BROKEN] swarm.leave:', e?.message) }
  }
  try { await leaveGroup(groupId) } catch (e) { console.warn('[REMOVE_BROKEN] leave:', e?.message) }
  try { await deleteGroup(groupId) } catch (e) { console.warn('[REMOVE_BROKEN] delete:', e?.message) }
  return { ok: true, groupId }
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
const recentDeleteNotifs = new Map()  // eventId → timeout handle; deduplicates cross-group delete notifications
const notifiedMemberJoins = new Map() // groupId → Set<memberId>; prevents duplicate member-join notifications across apply() replays
const pendingMemberLeaves = new Set()  // {groupId,memberId} JSON strings, pending broadcast to late-connecting peers
const notifiedRsvps = new Set()        // 'eventId:memberId:updatedAt' — prevents duplicate RSVP notifications across apply() replays
const rsvpCoalesce = new Map()         // eventId → { timeout, entries: [{ name, status }] } — debounces RSVP bursts

// De-dupe concurrent joinGroup(id) calls. The main startup loop and
// adoptGroupMigration's setTimeout cascade can race for the same group:
// both pass bases.has() before either reaches bases.set(), creating two
// Autobase instances over the same corestore namespace. The second write
// wins, but the first flight dangles awaiting base.ready() and can starve
// subsequent init() steps. Returning the in-flight promise keeps the
// post-joinGroup work on the single completion of the first call.
const _joinInFlight = new Map()

async function joinGroup (group) {
  if (bases.has(group.id)) return
  const inflight = _joinInFlight.get(group.id)
  if (inflight) return inflight
  const p = (async () => {
    try { return await _joinGroupImpl(group) }
    finally { _joinInFlight.delete(group.id) }
  })()
  _joinInFlight.set(group.id, p)
  return p
}

async function _joinGroupImpl (group) {
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

  // Detect a pre-existing migration marker so we can immediately gate further
  // writes to this (old) base. The marker may have been written in a prior
  // session; apply() won't re-fire for nodes already linearised.
  try {
    const marker = await readMigrationMarker(base.view, group.id)
    if (marker && verifyMigrationMarker(marker, {
      expectedOwnerId:   group.ownerId,
      expectedOldGroupId: group.id,
    })) {
      migratedGroups.add(group.id)
      console.log('[REKEY] old base opened in migrated state:', group.id, '→', marker.newGroupId)
      // Phase 2b: member-side auto-pickup after restart — marker was applied
      // in a prior session so apply() won't re-fire for it. Defer so the
      // surrounding joinGroup finishes setting up the old base first.
      setTimeout(() => adoptGroupMigration(group.id, marker).catch(e =>
        console.error('[REKEY] adopt error:', e.message)), 0)
    }
  } catch (e) {
    console.warn('[REKEY] marker preload error:', e.message)
  }

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
      await appendGroupWithAvatarSplit(base, { ...group, updatedAt: Date.now() })
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

  // Snapshot every writer key autobase currently knows about into the durable
  // knownWriter:{groupId}:* index. Peer writer cores have no namespace alias
  // and only live in `base.activeWriters` while the base is open, so without
  // this snapshot the orphan-sweep audit can't tell them apart from genuine
  // orphans once the base is closed (or hasn't fully drained yet).
  await snapshotKnownWriters(group.id, base).catch(e =>
    console.warn('[SNAPSHOT_WRITERS]', group.id, e?.message))

  // Open succeeded — clear any prior broken marker so the UI banner goes away.
  await clearGroupBroken(group.id)

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
        await appendGroupWithAvatarSplit(base, updatedGroup)
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

// Phase 1 wrapper around src/lib/rekey.js. Owner-only. Builds a fresh
// Autobase in a new namespace mirroring the old group's canonical state.
// Persists the descriptor under pendingMigration: so Phase 2 can pick it up
// to write the signed groupMigration marker into the old base. Does NOT
// join the swarm, register with the blind peer, or mirror the new group
// to local DB — the old group stays live for the UI until Phase 2 flips.
async function rekeyGroup (oldGroupId) {
  const profile = await getProfile()
  if (!profile?.id) throw new Error('rekeyGroup: no profile')

  const oldGroup = await getGroup(oldGroupId)
  if (!oldGroup) throw new Error('rekeyGroup: unknown group ' + oldGroupId)
  if (oldGroup.ownerId !== profile.id) throw new Error('rekeyGroup: not owner of ' + oldGroupId)

  const oldBase = bases.get(oldGroupId)
  if (!oldBase) throw new Error('rekeyGroup: base not open for ' + oldGroupId)

  const existing = await db.get('pendingMigration:' + oldGroupId).catch(() => null)
  if (existing?.value) return existing.value

  const newGroupId = 'g' + Math.random().toString(36).slice(2, 8)

  const { newBase, descriptor } = await _rekeyGroupLib({
    oldBase, oldGroupId, newGroupId, store,
  })

  bases.set(newGroupId, newBase)
  await db.put('pendingMigration:' + oldGroupId, descriptor)

  return descriptor
}

// Phase 2a: owner go-live. Consumes the pendingMigration descriptor left by
// rekeyGroup (Phase 1), signs a migration marker with the profile secret key,
// appends it into the OLD Autobase, then promotes the new base to live:
// closes the Phase-1 replay base (built with a minimal apply), persists a
// new local group record (carrying migratedFrom), marks the old group
// migratedTo locally, and re-opens the new base via joinGroup so the regular
// swarm + blind peer + full apply/mirror pipeline wires up.
//
// Idempotent: re-running after a crash with the marker already present skips
// the append and re-runs only the go-live steps.
//
// Scope: owner-side only. Member auto-pickup and old-group teardown are
// deferred to Phase 2b.
async function commitRekey (oldGroupId) {
  const profile = await getProfile()
  if (!profile?.id) throw new Error('commitRekey: no profile')
  if (!profile.secretKey || !profile.publicKey) {
    throw new Error('commitRekey: profile missing keypair')
  }

  const oldGroup = await getGroup(oldGroupId)
  if (!oldGroup) throw new Error('commitRekey: unknown group ' + oldGroupId)
  if (oldGroup.ownerId !== profile.id) {
    throw new Error('commitRekey: not owner of ' + oldGroupId)
  }

  const descNode = await db.get('pendingMigration:' + oldGroupId).catch(() => null)
  const descriptor = descNode?.value
  if (!descriptor) {
    throw new Error('commitRekey: no pendingMigration for ' + oldGroupId + ' — run rekeyGroup first')
  }

  const oldBase = bases.get(oldGroupId)
  if (!oldBase) throw new Error('commitRekey: old base not open for ' + oldGroupId)

  const mKey = migrationMarkerKey(oldGroupId)
  let markerWritten = false
  const existing = await oldBase.view.get(mKey).catch(() => null)
  if (!existing) {
    const marker = buildMigrationMarker(descriptor, profile)
    await oldBase.append({ op: 'put', type: 'migration', key: mKey, value: marker })
    await oldBase.update()
    markerWritten = true
  }
  // Apply should have added groupId to migratedGroups by now; belt-and-suspenders:
  migratedGroups.add(oldGroupId)

  // Close the Phase-1 replay base so we can re-open with the production apply.
  const preBuilt = bases.get(descriptor.newGroupId)
  if (preBuilt) {
    try { await preBuilt.close() } catch (e) { console.warn('[REKEY] preBuilt close:', e.message) }
    bases.delete(descriptor.newGroupId)
  }

  // New local group record inherits old metadata (name/emoji/color/members/
  // admins/etc.) with the new id + key and a migratedFrom tag.
  const newGroupRec = {
    ...oldGroup,
    id:           descriptor.newGroupId,
    groupKey:     descriptor.newGroupKey,
    migratedFrom: oldGroupId,
    joinedAt:     Date.now(),
    updatedAt:    Date.now(),
  }
  delete newGroupRec.migratedTo
  await putGroup(newGroupRec)

  // Mark old local group record as migrated (UI can hide / de-emphasize).
  const oldNode = await db.get(NS.groups + oldGroupId).catch(() => null)
  if (oldNode?.value) {
    await db.put(NS.groups + oldGroupId, {
      ...oldNode.value,
      migratedTo: descriptor.newGroupId,
      migratedAt: Date.now(),
      updatedAt:  Date.now(),
    })
  }

  // joinGroup runs full apply (mirrors events/rsvps to local DB), joins the
  // Hyperswarm topic for the new groupKey, and registers with the blind peer.
  await joinGroup(newGroupRec)

  // Autobase won't re-fire apply() for nodes already linearised in the
  // Phase-1 replay base, so the newly-opened production base doesn't mirror
  // events to local DB a second time — leaving local event records with
  // groups[oldGroupId]. Without this rewrite the owner's own delete/edit
  // UI would target the old base (whose ops are gated into no-ops).
  await rewriteLocalEventGroupIds(oldGroupId, descriptor.newGroupId)

  send({ type: 'event', event: 'sync', data: oldGroupId })
  send({ type: 'event', event: 'sync', data: descriptor.newGroupId })
  send({ type: 'event', event: 'groupMigrated', data: {
    oldGroupId,
    newGroupId:  descriptor.newGroupId,
    newGroupKey: descriptor.newGroupKey,
  }})

  return {
    ok:          true,
    markerWritten,
    oldGroupId,
    newGroupId:  descriptor.newGroupId,
    newGroupKey: descriptor.newGroupKey,
  }
}

// Phase 2b: member-side auto-pickup. Called when a verified migration marker
// lands on our copy of the OLD base — either live via apply(), or via the
// marker preload on a later joinGroup. Non-owners inherit local metadata from
// the old group record, reuse profile.id as memberId, open the new Autobase
// via joinGroup (which handles swarm + blind peer + broadcastSelf so the
// owner re-adds us as a writer on the new base), and tombstone the old group
// locally so the UI can de-emphasize / hide it.
//
// Idempotent on every axis so apply() replays and marker preloads across
// restarts don't duplicate work:
//   - owner short-circuits (commitRekey already handled their side)
//   - if the new group record already exists locally, we just ensure the base
//     is open (handles crash between putGroup and joinGroup)
//   - re-writing migratedTo is skipped once set
async function adoptGroupMigration (oldGroupId, marker) {
  if (!marker || typeof marker !== 'object') return
  const profile = await getProfile().catch(() => null)
  if (!profile?.id) return
  if (marker.ownerId === profile.id) return

  const newGroupId  = marker.newGroupId
  const newGroupKey = marker.newGroupKey
  if (!newGroupId || !newGroupKey) return

  // User removed the old group — don't adopt the migration into a new record.
  if (await isForgottenGroup(oldGroupId)) return
  if (await isForgottenGroup(newGroupId)) return

  const oldGroup = await getGroup(oldGroupId)
  if (!oldGroup) return

  const existingNew = await db.get(NS.groups + newGroupId).catch(() => null)
  if (!existingNew?.value) {
    const newGroupRec = {
      ...oldGroup,
      id:           newGroupId,
      groupKey:     newGroupKey,
      ownerId:      marker.ownerId,
      migratedFrom: oldGroupId,
      joinedAt:     Date.now(),
      updatedAt:    Date.now(),
    }
    delete newGroupRec.migratedTo
    await putGroup(newGroupRec)
    await joinGroup(newGroupRec)
  } else if (!bases.has(newGroupId)) {
    await joinGroup(existingNew.value)
  }

  if (!oldGroup.migratedTo) {
    await db.put(NS.groups + oldGroupId, {
      ...oldGroup,
      migratedTo: newGroupId,
      migratedAt: Date.now(),
      updatedAt:  Date.now(),
    })
  }

  // Belt-and-suspenders with the new base's own apply→mirror: ensure any
  // event record still carrying oldGroupId in groups[] is rewritten locally
  // so subsequent put/delete ops from this device target the new base.
  await rewriteLocalEventGroupIds(oldGroupId, newGroupId)

  send({ type: 'event', event: 'sync', data: oldGroupId })
  send({ type: 'event', event: 'sync', data: newGroupId })
  send({ type: 'event', event: 'groupMigrated', data: {
    oldGroupId,
    newGroupId,
    newGroupKey,
  }})
}

// Phase 3: grace period before an old (migrated) group's cores are purged
// from disk. During the grace window the tombstoned group stays dormant
// (not joined to the swarm, not mirrored) but its corestore is kept so a
// straggler member can still adopt the migration marker over a direct
// hyperswarm connection if they were offline at go-live time.
const MIGRATION_GRACE_MS = 14 * 24 * 60 * 60 * 1000

// Phase 3: purge the on-disk corestore footprint of a migrated (tombstoned)
// group. Closes the old Autobase if still open, leaves the swarm topic,
// enumerates every Hypercore in the old group's namespace and calls
// core.purge() to wipe it from storage, then deletes local DB side-metadata
// for the group and compacts RocksDB to release the freed blocks.
//
// Normally only runs once migratedAt is older than MIGRATION_GRACE_MS.
// `{ force: true }` skips the grace check (dev / explicit "Purge now").
async function purgeMigratedGroup (oldGroupId, opts = {}) {
  const force = !!opts.force
  const oldGroup = await getGroup(oldGroupId)
  if (!oldGroup) throw new Error('purgeMigratedGroup: unknown group ' + oldGroupId)
  if (!oldGroup.migratedTo) throw new Error('purgeMigratedGroup: group not migrated ' + oldGroupId)

  if (!force) {
    const migratedAt = oldGroup.migratedAt ?? 0
    const age = Date.now() - migratedAt
    if (age < MIGRATION_GRACE_MS) {
      const daysLeft = Math.ceil((MIGRATION_GRACE_MS - age) / (24 * 60 * 60 * 1000))
      throw new Error('purgeMigratedGroup: grace period not elapsed (' + daysLeft + 'd left)')
    }
  }

  console.log('[PURGE] starting purge of migrated group:', oldGroupId, 'force=' + force)

  // 1. Snapshot discovery keys held by the open base (writer cores, system,
  //    view, local). Must run BEFORE base.close() so we can enumerate the
  //    replicated-by-key cores that have no namespace alias. Namespace alias
  //    enumeration (store.list) only catches locally-named cores and misses
  //    writers adopted over replication.
  const dkSet = new Map() // hex → Buffer
  const addDk = (dk) => {
    if (!dk) return
    try {
      const buf = b4a.isBuffer(dk) ? dk : b4a.from(dk)
      dkSet.set(b4a.toString(buf, 'hex'), buf)
    } catch {}
  }
  const diag = { baseFound: false, fromLocal: 0, fromWriters: 0, fromSystem: 0, fromView: 0, fromNs: 0 }
  const base = bases.get(oldGroupId)
  if (base) {
    diag.baseFound = true
    try {
      const before = dkSet.size
      addDk(base.local?.discoveryKey)
      try {
        const hpc = require('hypercore-crypto')
        addDk(base.key && hpc.discoveryKey(base.key))
        addDk(base.bootstrap && hpc.discoveryKey(base.bootstrap))
      } catch {}
      diag.fromLocal = dkSet.size - before

      const beforeW = dkSet.size
      const writers = base.activeWriters || base.writers || []
      try {
        for (const w of writers) addDk(w?.core?.discoveryKey)
      } catch (e) { console.warn('[PURGE] writers iter:', e.message) }
      diag.fromWriters = dkSet.size - beforeW

      const beforeS = dkSet.size
      addDk(base.system?.core?.discoveryKey)
      addDk(base.core?.discoveryKey)
      diag.fromSystem = dkSet.size - beforeS

      const beforeV = dkSet.size
      addDk(base.view?.feed?.discoveryKey)
      addDk(base.view?.core?.discoveryKey)
      diag.fromView = dkSet.size - beforeV
    } catch (e) { console.warn('[PURGE] snapshot dks:', e.message) }
    try { await base.close() } catch (e) { console.warn('[PURGE] base close:', e.message) }
    bases.delete(oldGroupId)
  }

  // Also pull any cores alias-registered under the groupId namespace (covers
  // the auto-purge path where the base was never reopened this session).
  try {
    const nsBuf = store.namespace(oldGroupId).ns
    const beforeN = dkSet.size
    for await (const dk of store.list(nsBuf)) addDk(dk)
    diag.fromNs = dkSet.size - beforeN
  } catch (e) { console.warn('[PURGE] namespace enumeration:', e.message) }

  // Fallback: peer writer cores have no namespace alias and only show up via
  // base.activeWriters, so when the base wasn't open this session we miss
  // them. The durable knownWriter index covers exactly that case — read it
  // and convert to discovery keys.
  diag.fromKnownWriter = 0
  try {
    const prefix = 'knownWriter:' + oldGroupId + ':'
    const hpc = require('hypercore-crypto')
    const beforeK = dkSet.size
    for await (const { key } of db.createReadStream({ gt: prefix, lt: prefix + '\xff' })) {
      const writerHex = key.slice(prefix.length)
      try { addDk(hpc.discoveryKey(b4a.from(writerHex, 'hex'))) } catch {}
    }
    diag.fromKnownWriter = dkSet.size - beforeK
  } catch (e) { console.warn('[PURGE] knownWriter enumeration:', e.message) }

  console.log('[PURGE] dk sources for', oldGroupId, diag)

  // 2. Leave the swarm topic for this group.
  if (swarm && oldGroup.groupKey) {
    try {
      const topic = b4a.from(oldGroup.groupKey.slice(0, 64).padEnd(64, '0'), 'hex')
      await swarm.leave(topic).catch(() => {})
    } catch (e) { console.warn('[PURGE] swarm leave:', e.message) }
  }

  // 3. Purge every snapshotted core from storage. Hypercore 11.26 has a
  //    broken session.purge() (references undefined _closeAllSessions), so
  //    we open a session for each dk, capture the underlying core pointer,
  //    close the session, then call CorestoreStorage.deleteCore(ptr).
  let purgedCores = 0
  const purgeErrors = []
  for (const buf of dkSet.values()) {
    try {
      const core = store.get({ discoveryKey: buf })
      await core.ready()
      const sessionStorage = core.state?.storage
      const storeStorage = sessionStorage?.store ?? store.storage
      const ptr = sessionStorage?.core
      try { await core.close() } catch {}
      if (!ptr || !storeStorage?.deleteCore) throw new Error('no ptr/storage')
      await storeStorage.deleteCore(ptr)
      purgedCores++
    } catch (e) { purgeErrors.push(e.message) }
  }
  if (purgeErrors.length) console.warn('[PURGE] core purge errors:', purgeErrors.length, purgeErrors[0])
  console.log('[PURGE] discovery keys enumerated:', dkSet.size, 'purged:', purgedCores)

  // 4. Delete local DB side-metadata keyed by the old groupId.
  const sideDels = [
    NS.groups  + oldGroupId,
    'joinedAt:' + oldGroupId,
    'selfBroadcasted:' + oldGroupId,
    'pendingMigration:' + oldGroupId,
    'pendingLeaveKey:' + oldGroupId,
  ]
  for (const k of sideDels) { await db.del(k).catch(() => {}) }

  // Range-scoped deletes
  const rangePrefixes = [
    'knownWriter:' + oldGroupId + ':',
    'blockedWriter:' + oldGroupId + ':',
    NS.members + oldGroupId + ':',
    'pendingLeave:' + oldGroupId + ':',
  ]
  for (const prefix of rangePrefixes) {
    for await (const { key } of db.createReadStream({ gt: prefix, lt: prefix + '\xff' })) {
      await db.del(key).catch(() => {})
    }
  }

  migratedGroups.delete(oldGroupId)

  // 5. Scan the raw TL_DATA key-range and delete any stranded dataPointer
  //    sub-range that's no longer referenced by a live core. deleteCore(ptr)
  //    only clears dps listed in the current sessions[]; Autobase writer
  //    cores accumulate historical dps across truncations/snapshots that
  //    would otherwise leak on every rekey.
  const orphanDp = await purgeOrphanDataRanges({ dryRun: false }).catch(e => {
    console.warn('[PURGE] orphan-dp sweep failed:', e.message)
    return { errors: [e.message] }
  })

  // 6. Compact RocksDB to release the freed core blocks + blob bytes.
  const reclaim = await reclaimStorage().catch(e => {
    console.warn('[PURGE] reclaim failed:', e.message)
    return { errors: [e.message] }
  })

  console.log('[PURGE] done:', oldGroupId, 'cores=' + purgedCores, 'orphanDps=' + (orphanDp?.deleted ?? 0), 'freed=' + (reclaim?.freed ?? 0))
  send({ type: 'event', event: 'groupPurged', data: { oldGroupId, purgedCores, ...reclaim } })
  return { oldGroupId, purgedCores, diag, orphanDpsDeleted: orphanDp?.deleted ?? 0, firstErr: purgeErrors[0] ?? null, errCount: purgeErrors.length, ...reclaim }
}

// Scan every local group record (including tombstoned ones hidden from the
// UI) and purge any whose migration grace period has elapsed — or all of
// them unconditionally when force is set (dev override).
// Returns a per-group result array; failures are captured, not thrown.
async function purgeAllMigratedGroups (opts = {}) {
  const force = !!opts.force
  const results = []
  const candidates = []
  for await (const { value } of db.createReadStream({ gt: NS.groups, lt: NS.groups + '\xff' })) {
    if (value?.migratedTo && value?.id) candidates.push(value)
  }
  for (const g of candidates) {
    try {
      const res = await purgeMigratedGroup(g.id, { force })
      results.push({ ok: true, ...res })
    } catch (e) {
      results.push({ ok: false, oldGroupId: g.id, error: e.message })
    }
  }
  return results
}

// Persist every writer key autobase currently knows about for `groupId` to
// the knownWriter:{groupId}:{writerHex} index. This is the durable record
// orphan-sweep audit and migrated-group purge consult to identify peer writer
// cores (which have no namespace alias) without needing to crack open the
// base. Idempotent — already-recorded keys just get their ts refreshed.
async function snapshotKnownWriters (groupId, base) {
  if (!base) return
  const writerKeys = new Set()
  try { if (base.local?.key) writerKeys.add(b4a.toString(base.local.key, 'hex')) } catch {}
  try {
    for (const w of (base.activeWriters || base.writers || [])) {
      const k = w?.core?.key
      if (k) writerKeys.add(b4a.toString(k, 'hex'))
    }
  } catch {}
  for (const hex of writerKeys) {
    await db.put('knownWriter:' + groupId + ':' + hex, { ts: Date.now() }).catch(() => {})
  }
}

// Enumerate every core in store/db and classify as reachable (belongs to a
// tracked group) vs orphan. Optional `opts.purge` runs deleteCore(ptr) on
// every orphan. Returns a per-core report so the caller can sanity check
// before destroying anything.
async function auditStorage (opts = {}) {
  const purge = !!opts.purge
  const reachable = new Map() // dkHex → source tag
  const addDk = (dk, tag) => {
    if (!dk) return
    try {
      const buf = b4a.isBuffer(dk) ? dk : b4a.from(dk)
      const hex = b4a.toString(buf, 'hex')
      if (!reachable.has(hex)) reachable.set(hex, tag)
    } catch {}
  }

  const hpc = require('hypercore-crypto')
  const groups = []
  for await (const { value } of db.createReadStream({ gt: NS.groups, lt: NS.groups + '\xff' })) {
    if (value?.id) groups.push(value)
  }

  for (const g of groups) {
    const base = bases.get(g.id)
    const tag = (g.migratedTo ? 'migrated:' : '') + g.id
    if (base) {
      try {
        addDk(base.local?.discoveryKey, tag)
        if (base.key) addDk(hpc.discoveryKey(base.key), tag)
        if (base.bootstrap) addDk(hpc.discoveryKey(base.bootstrap), tag)
        for (const w of (base.activeWriters || base.writers || [])) addDk(w?.core?.discoveryKey, tag)
        addDk(base.system?.core?.discoveryKey, tag)
        addDk(base.core?.discoveryKey, tag)
        addDk(base.view?.feed?.discoveryKey, tag)
        addDk(base.view?.core?.discoveryKey, tag)
      } catch (e) { console.warn('[AUDIT] base dks for', g.id, e.message) }
    }
    try {
      if (g.groupKey) addDk(hpc.discoveryKey(b4a.from(g.groupKey, 'hex')), tag)
    } catch {}
    try {
      const nsBuf = store.namespace(g.id).ns
      for await (const dk of store.list(nsBuf)) addDk(dk, tag)
    } catch (e) { console.warn('[AUDIT] namespace list for', g.id, e.message) }
    // Durable writer index — covers peer writer cores even when the base is
    // closed (or wasn't loaded this session, e.g. migrated groups under
    // grace). Without this, sweep can't tell unaliased peer writer cores
    // apart from genuine orphans and would happily delete live data.
    try {
      const prefix = 'knownWriter:' + g.id + ':'
      for await (const { key } of db.createReadStream({ gt: prefix, lt: prefix + '\xff' })) {
        const writerHex = key.slice(prefix.length)
        try {
          addDk(hpc.discoveryKey(b4a.from(writerHex, 'hex')), 'knownWriter:' + tag)
        } catch {}
      }
    } catch (e) { console.warn('[AUDIT] knownWriter for', g.id, e.message) }
  }

  const storeStorage = store.storage
  const allCores = []
  for await (const { discoveryKey, core } of storeStorage.createCoreStream()) {
    const hex = b4a.toString(discoveryKey, 'hex')
    const reach = reachable.get(hex) || null
    allCores.push({
      dk: hex,
      corePointer: core.corePointer,
      dataPointer: core.dataPointer,
      alias: core.alias ? { namespace: b4a.toString(core.alias.namespace, 'hex'), name: core.alias.name } : null,
      reach,
    })
  }

  const orphans = allCores.filter(c => !c.reach)
  console.log('[AUDIT] total cores:', allCores.length, 'reachable:', reachable.size, 'orphans:', orphans.length)

  // Size each orphan by briefly opening the core to read byteLength. Needed
  // for the pre-purge confirmation report so the user can see how much disk
  // space will be reclaimed before committing.
  let orphanBytes = 0
  for (const o of orphans) {
    try {
      const c = store.get({ discoveryKey: b4a.from(o.dk, 'hex') })
      await c.ready()
      const bytes = c.byteLength ?? 0
      o.bytes = bytes
      o.length = c.length ?? 0
      orphanBytes += bytes
      try { await c.close() } catch {}
    } catch (e) {
      o.bytes = 0
      o.length = 0
    }
  }

  // Safety: refuse to purge if any live (non-migrated) group has no open base.
  // Without the base open we miss replicated writer cores that have no alias,
  // and purging would wipe live group data.
  const liveWithoutBase = groups
    .filter(g => !g.migratedTo && !bases.has(g.id))
    .map(g => g.id)

  let purged = 0
  let dataRangesCleared = 0
  const purgeErrors = []
  if (purge && liveWithoutBase.length) {
    return {
      totalCores: allCores.length,
      reachableCount: reachable.size,
      groupCount: groups.length,
      orphans: orphans.length,
      orphanBytes,
      orphanList: orphans.slice(0, 50),
      liveWithoutBase,
      purged: 0,
      purgeErrors: [],
      reclaim: null,
      abortedLiveWithoutBase: liveWithoutBase,
    }
  }
  if (purge && orphans.length) {
    const hsKeys = require('hypercore-storage/lib/keys.js')
    for (const o of orphans) {
      try {
        // 1. deleteCore clears auth, sessions, the core range, and any data
        //    ranges declared in the sessions list. If sessions is null the
        //    block-data keys keyed by dataPointer get left behind.
        await storeStorage.deleteCore({ corePointer: o.corePointer, dataPointer: o.dataPointer })
        purged++

        // 2. Belt-and-suspenders: delete the [core.data(dp), core.data(dp+1))
        //    range using the stream's dataPointer. Covers the sessions==null
        //    case and clears block/tree/bitfield/userData/local for that dp.
        const tx = storeStorage.db.write({ autoDestroy: true })
        const dStart = hsKeys.core.data(o.dataPointer)
        const dEnd = hsKeys.core.data(o.dataPointer + 1)
        tx.tryDeleteRange(dStart, dEnd)
        await tx.flush()
        dataRangesCleared++
      } catch (e) { purgeErrors.push(e.message) }
    }
    console.log('[AUDIT] purged orphans:', purged, 'data ranges:', dataRangesCleared, 'errors:', purgeErrors.length)
  }

  let reclaim = null
  if (purge && purged > 0) {
    reclaim = await reclaimStorage().catch(e => ({ errors: [e.message] }))
  }

  return {
    totalCores: allCores.length,
    reachableCount: reachable.size,
    groupCount: groups.length,
    orphans: orphans.length,
    orphanBytes,
    orphanList: orphans.slice(0, 50), // cap for IPC payload
    sampleReachable: allCores.filter(c => c.reach).slice(0, 5),
    liveWithoutBase,
    purged,
    dataRangesCleared,
    purgeErrors: purgeErrors.slice(0, 5),
    reclaim,
  }
}

// Scan the raw TL_DATA key-range in store/db RocksDB and delete any
// [core.data(dp), core.data(dp+1)) sub-range whose dataPointer isn't
// referenced by any live core (via core.dataPointer, sessions[].dataPointer,
// or dependency.dataPointer). Catches block/tree/bitfield/userData keys that
// got orphaned when we wiped core metadata but left stale session-dp ranges
// behind.
async function purgeOrphanDataRanges (opts = {}) {
  const dryRun = !!opts.dryRun
  const { UINT } = require('index-encoder')
  const hsKeys = require('hypercore-storage/lib/keys.js')
  const { CoreRX } = require('hypercore-storage/lib/tx.js')
  const EMPTY = require('b4a').alloc(0)
  const storeStorage = store.storage

  // 1. Build live-dp set from every core currently in storage.
  const liveDps = new Set()
  const liveCores = []
  for await (const { discoveryKey, core } of storeStorage.createCoreStream()) {
    liveCores.push({ dk: b4a.toString(discoveryKey, 'hex'), corePointer: core.corePointer, dataPointer: core.dataPointer })
    liveDps.add(core.dataPointer)
  }
  for (const c of liveCores) {
    try {
      const rx = new CoreRX({ corePointer: c.corePointer, dataPointer: c.dataPointer }, storeStorage.db, EMPTY)
      const sessionsP = rx.getSessions()
      const depP = rx.getDependency()
      rx.tryFlush()
      const sessions = await sessionsP
      const dep = await depP
      if (sessions) for (const s of sessions) liveDps.add(s.dataPointer)
      if (dep) liveDps.add(dep.dataPointer)
    } catch (e) { /* best-effort */ }
  }

  // 2. Walk the TL_DATA range one unique-dp at a time. UINT-encoded TL_DATA
  //    = 4 (single byte); end of range = UINT(5) (single byte).
  const TL_DATA_START = b4a.from([4])
  const TL_DATA_END = b4a.from([5])
  const decodeDp = (key) => {
    const state = { buffer: key, start: 0, end: key.byteLength }
    UINT.decode(state) // ns
    return UINT.decode(state)
  }

  let pos = TL_DATA_START
  const uniqueDps = []
  const orphanDps = []
  let iterations = 0
  while (iterations++ < 200000) {
    let peeked = null
    for await (const entry of storeStorage.db.iterator({ gte: pos, lt: TL_DATA_END, limit: 1 })) {
      peeked = entry
      break
    }
    if (!peeked) break
    const dp = decodeDp(peeked.key)
    uniqueDps.push(dp)
    if (!liveDps.has(dp)) orphanDps.push(dp)
    pos = hsKeys.core.data(dp + 1)
  }

  console.log('[ORPHAN-DP] live dps:', liveDps.size, 'unique in TL_DATA:', uniqueDps.length, 'orphans:', orphanDps.length)

  let deleted = 0
  const errors = []
  if (!dryRun && orphanDps.length) {
    for (const dp of orphanDps) {
      try {
        const tx = storeStorage.db.write({ autoDestroy: true })
        tx.tryDeleteRange(hsKeys.core.data(dp), hsKeys.core.data(dp + 1))
        await tx.flush()
        deleted++
      } catch (e) { errors.push(e.message) }
    }
    console.log('[ORPHAN-DP] deleted ranges:', deleted, 'errors:', errors.length)
  }

  let reclaim = null
  if (!dryRun && deleted > 0) {
    reclaim = await reclaimStorage().catch(e => ({ errors: [e.message] }))
  }

  return {
    liveCoreCount: liveCores.length,
    liveDps: liveDps.size,
    uniqueDps: uniqueDps.length,
    orphanDps: orphanDps.length,
    orphanDpSample: orphanDps.slice(0, 10),
    deleted,
    errors: errors.slice(0, 5),
    reclaim,
  }
}

// Rewrite stale groups[] references on local event records after a
// group-rekey migration. Pure local cleanup — no base.append, no updatedAt
// bump — so LWW against the new base's mirror stays a no-op.
async function rewriteLocalEventGroupIds (oldGroupId, newGroupId) {
  let count = 0
  for await (const { key, value } of db.createReadStream({ gt: NS.events, lt: NS.events + '\xff' })) {
    if (!Array.isArray(value?.groups) || !value.groups.includes(oldGroupId)) continue
    const rewritten = value.groups.map(gid => gid === oldGroupId ? newGroupId : gid)
    await db.put(key, { ...value, groups: rewritten })
    count++
  }
  if (count > 0) console.log('[REKEY] rewrote', count, 'local event groupId refs:', oldGroupId, '→', newGroupId)
}

async function syncPutEvent (groupId, event) {
  const base = bases.get(groupId)
  if (!base) throw new Error('Not in group: ' + groupId)
  // Carry _prevDate in the value so receiving devices can clean up the old key
  const { privateNote, ...shared } = event
  const value = { ...shared, updatedAt: event.updatedAt || Date.now() }
  await base.append({ op: 'put', type: 'event', key: 'events:' + event.date + ':' + event.id, value })
}

async function syncDeleteEvent (groupId, eventId, date, updatedByName, updatedById, recurrenceId, eventTitle) {
  const base = bases.get(groupId)
  if (!base) throw new Error('Not in group: ' + groupId)
  const payload = { op: 'del', type: 'event', key: 'events:' + date + ':' + eventId, updatedByName: updatedByName || 'Someone', updatedById: updatedById || '' }
  if (recurrenceId) payload.recurrenceId = recurrenceId
  if (eventTitle) payload.eventTitle = eventTitle
  await base.append(payload)
}

async function syncPutGroup (group) {
  const base = bases.get(group.id)
  console.log('[SYNC_PUT_GROUP] groupId:', group.id, 'members:', JSON.stringify((group.members??[]).map(m=>m.name)), 'updatedAt:', group.updatedAt)
  if (!base) throw new Error('Not in group: ' + group.id)
  await appendGroupWithAvatarSplit(base, group)
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
      if (await isForgottenGroup(groupId)) continue
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
  scheduleMorningDigest().catch(e => console.warn('morning digest fg:', e.message))
}

async function resyncGroup (groupId) {
  const base = bases.get(groupId)
  if (!base) return
  send({ type: 'event', event: 'syncing', data: { groupId } })
  try {
    // Bounce Hyperswarm on this group's topic — forces fresh peer discovery,
    // recovering from silently-dropped connections (backgrounded sockets, stale DHT).
    const group = await getGroup(groupId).catch(() => null)
    if (swarm && group?.groupKey) {
      try {
        const topic = b4a.from(group.groupKey.slice(0, 64).padEnd(64, '0'), 'hex')
        await swarm.leave(topic).catch(() => {})
        swarm.join(topic, { server: true, client: true })
        await swarm.flush().catch(() => {})
      } catch (e) { console.warn('[RESYNC] swarm bounce:', e?.message) }
    }

    // Re-broadcast writer-announce on open channels — if the owner has come
    // online since the last handshake, this is how they learn to grant addWriter.
    try {
      const profile = await getProfile().catch(() => null)
      const writerKey = b4a.toString(base.local.key, 'hex')
      const announce = Buffer.from(JSON.stringify({ groupId, writerKey, memberId: profile?.id ?? null }))
      for (const ch of activeChannels) {
        try { ch.send(announce) } catch (e) {}
      }
    } catch (e) { console.warn('[RESYNC] announce:', e?.message) }

    // Eagerly download every writer's core to tip. Hypercore's default is
    // lazy-pull (only fetch blocks apply() needs); this forces "pull everything
    // any connected peer will serve" so future events / membership tips land
    // even when the local apply loop wouldn't have asked for them.
    const writers = base.activeWriters || base.writers || []
    const deadline = Date.now() + 8000
    const downloads = []
    for (const w of writers) {
      const core = w?.core
      if (!core) continue
      try {
        if (typeof core.update === 'function') {
          await core.update().catch(() => {})
        }
        const end = core.length
        if (end > 0 && typeof core.download === 'function') {
          const range = core.download({ start: 0, end })
          if (range && typeof range.done === 'function') {
            downloads.push(range.done().catch(() => {}))
          }
        }
      } catch (e) {}
    }
    if (downloads.length) {
      const remaining = Math.max(0, deadline - Date.now())
      await Promise.race([
        Promise.all(downloads),
        new Promise(r => setTimeout(r, remaining)),
      ])
    }

    // Force Autobase to re-run apply() over anything that arrived.
    await base.update().catch(e => console.warn('[RESYNC] base.update:', e?.message))

    const view = base.view
    if (!view) {
      send({ type: 'event', event: 'synced', data: { groupId, ts: Date.now() } })
      return
    }
    for await (const { key, value } of view.createReadStream()) {
      if (!value) continue
      if (key.startsWith('events:')) {
        // Respect local delete tombstone — never resurrect user-deleted events
        const eventId = key.split(':').pop()
        const tombstone = await db.get(NS.deleted + eventId).catch(() => null)
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
        const { members: splitMembers } = await splitMembersInline([...mergedMap.values()])
        await db.put(key, {
          ...value,
          color:   value.color   || ev?.color,
          name:    value.name    || ev?.name,
          emoji:   value.emoji   || ev?.emoji,
          icon:    value.icon    ?? ev?.icon,
          joinedAt: ev?.joinedAt || value.joinedAt,
          removedMembers: [...removedMap.values()],
          members: splitMembers,
        })
      }
    }
    send({ type: 'event', event: 'sync', data: groupId })
    send({ type: 'event', event: 'synced', data: { groupId, ts: Date.now() } })
  } catch(e) {
    console.error('[RESYNC] error:', e.message)
    send({ type: 'event', event: 'synced', data: { groupId, ts: Date.now(), error: e.message } })
  }
}

async function resyncAll () {
  const ids = [...bases.keys()]
  for (const gid of ids) {
    await resyncGroup(gid).catch(e => console.warn('[RESYNC_ALL]', gid, e?.message))
  }
  send({ type: 'event', event: 'synced', data: { groupId: null, ts: Date.now() } })
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
        // Swallow addWriter on a migrated old base — new writers belong on the new base.
        if (migratedGroups.has(groupId)) continue
        // Check if this writer was blocked by the owner — if so skip granting access
        const writerBlocked = await db.get('blockedWriter:' + groupId + ':' + val.addWriter).catch(() => null)
        if (!writerBlocked) {
          await host.addWriter(b4a.from(val.addWriter, 'hex'), { indexer: true })
        }
        continue
      }

      // Group-migration marker — verify signature and gate further writes.
      // The marker itself is the one write we allow past a migrated gate;
      // everything after it (put/del/addWriter) becomes a local no-op for
      // this old base.
      if (val.op === 'put' && val.type === 'migration' && val.key === migrationMarkerKey(groupId)) {
        const existing = await view.get(val.key).catch(() => null)
        if (!existing) {
          const groupNode = await view.get(NS.groups + groupId).catch(() => null)
          const expectedOwnerId = groupNode?.value?.ownerId
          const ok = verifyMigrationMarker(val.value, {
            expectedOwnerId,
            expectedOldGroupId: groupId,
          })
          if (ok) {
            await view.put(val.key, val.value)
            migratedGroups.add(groupId)
            console.log('[REKEY] marker applied for', groupId, '→', val.value.newGroupId)
            send({ type: 'event', event: 'groupMigrationMarkerSeen', data: {
              oldGroupId:  groupId,
              newGroupId:  val.value.newGroupId,
              newGroupKey: val.value.newGroupKey,
              ownerId:     val.value.ownerId,
            }})
            // Defer so we don't spin up a new Autobase from inside apply().
            const _markerCopy = val.value
            setTimeout(() => adoptGroupMigration(groupId, _markerCopy).catch(e =>
              console.error('[REKEY] adopt error:', e.message)), 0)
          } else {
            console.warn('[REKEY] rejected invalid migration marker for', groupId)
          }
        }
        continue
      }

      // Migration gate: old base is dead, swallow any further ops locally.
      if (migratedGroups.has(groupId)) continue

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
            // Shadow (busy-time) events carry no invitation/commitment — silent
            if (val.value.isShadow) continue
            // Skip notification if user locally deleted this event
            const notifTombstone = await db.get(NS.deleted + val.value.id).catch(() => null)
            if (notifTombstone) continue
            // Skip notification for past events (prevents overnight flood from background sync replay).
            // Compare against LOCAL date, not UTC, since event.date is a local YYYY-MM-DD string.
            const eventDate = val.value.date
            const localToday = (() => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0') })()
            if (eventDate && eventDate < localToday) continue
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
            const { members: splitMembers } = await splitMembersInline([...mergedMap.values()])
            const merged = {
              ...winningValue,
              color:   winningValue.color   || lv?.color   || val.value.color,
              name:    winningValue.name    || lv?.name    || val.value.name,
              emoji:   winningValue.emoji   || lv?.emoji   || val.value.emoji,
              icon:    winningValue.icon    ?? lv?.icon    ?? val.value.icon,
              removedMembers: [...removedMap.values()],
              members: splitMembers,
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
            // Shadow (busy-time) deletes are silent — mirror the put side
            const isShadowKey = val.key.includes(':shadow:')
            const delTombstone = await db.get(NS.deleted + eventId).catch(() => null)
            if (!delTombstone && !isShadowKey && !recentDeleteNotifs.has(eventId)) {
              recentDeleteNotifs.set(eventId, setTimeout(() => recentDeleteNotifs.delete(eventId), 5000))
              const delRid = val.recurrenceId || val.value?.recurrenceId || null
              if (delRid) {
                const dedupKey = groupId + ':' + delRid + ':del'
                if (!recentSeriesNotifs.has(dedupKey)) {
                  recentSeriesNotifs.set(dedupKey, setTimeout(() => recentSeriesNotifs.delete(dedupKey), 5000))
                  notifySyncChange({ op: 'del', key: val.key, updatedByName: val.updatedByName, updatedById: val.updatedById, groupId, isSeries: true, eventTitle: val.eventTitle })
                }
              } else {
                notifySyncChange({ op: 'del', key: val.key, updatedByName: val.updatedByName, updatedById: val.updatedById, groupId, eventTitle: val.eventTitle })
              }
            }
            // Write tombstone AFTER notification check so re-linearization (foregroundSync, bgSync) won't re-fire
            if (!isShadowKey) {
              await db.put(NS.deleted + eventId, { ts: Date.now() }).catch(() => {})
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

async function notifySyncChange ({ op, value, key, prev, updatedByName, updatedById, groupId, isSeries = false, eventTitle = '' }) {
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
      title = who + ' removed ' + (eventTitle || 'an event')
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
    // User removed this group — don't resurrect any of its records from sync.
    if (groupId && await isForgottenGroup(groupId)) return
    if (type === 'avatar') {
      const existing = await db.get(key).catch(() => null)
      if (!existing) await db.put(key, value)
      return
    }
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
      const tombstone = await db.get(NS.deleted + value.id).catch(() => null)
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
      // Strip inline avatars into the avatars: keyspace so local DB stays
      // dedup-shaped even when incoming records arrive inline from pre-Phase2
      // peers. Does not rewrite the Autobase view — only the local mirror.
      const { members: splitMembers } = await splitMembersInline([...mergedMap.values()])
      const merged = {
        ...value,
        color:   value.color   || existing?.value?.color,
        name:    value.name    || existing?.value?.name,
        emoji:   value.emoji   || existing?.value?.emoji,
        icon:    value.icon    ?? existing?.value?.icon,
        joinedAt: existing?.value?.joinedAt || value.joinedAt,
        removedMembers: [...removedMap.values()],
        members: splitMembers,
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
    await appendGroupWithAvatarSplit(base, updatedGroup)
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
          exclusive: true, blobGarbageCollectionPolicy: 1, blobGarbageCollectionAgeCutoff: 1.0, bottommostLevelCompaction: 2,
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

  async function blobStats (dir) {
    let entries
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }) }
    catch { return { count: 0, bytes: 0 } }
    let count = 0, bytes = 0
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.blob')) continue
      try { bytes += (await fs.promises.stat(path.join(dir, e.name))).size; count++ } catch {}
    }
    return { count, bytes }
  }

  const storeDbDir = path.join(dataDir, 'store', 'db')
  const before = await dirSize(dataDir)
  const blobBefore = await blobStats(storeDbDir)
  // age_cutoff 1.0 → every blob file is GC-eligible (default 0.25 leaves
  // the newest 75% untouched, which is why huge .blob files survive purge).
  // kForce policy on its own only schedules GC eagerly; the cutoff gate
  // still applies unless we override it here.
  const opts = { exclusive: true, blobGarbageCollectionPolicy: 1, blobGarbageCollectionAgeCutoff: 1.0, bottommostLevelCompaction: 2 }
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
  const blobAfter = await blobStats(storeDbDir)
  console.log('[reclaim] blobs before:', blobBefore.count, '/', (blobBefore.bytes/1024/1024).toFixed(1), 'MB',
              '→ after:', blobAfter.count, '/', (blobAfter.bytes/1024/1024).toFixed(1), 'MB')
  return { before, after, freed: before - after, blobBefore, blobAfter, errors }
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
                  if (base) await appendGroupWithAvatarSplit(base, updated)
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

            // Record this writer in our durable index regardless of role.
            // Audit and migrated-group purge use knownWriter to identify peer
            // writer cores; without this, non-owners' audits would see them
            // as orphans and a sweep would purge live data.
            if (groupId && writerKey) {
              await db.put('knownWriter:' + groupId + ':' + writerKey, { ts: Date.now() }).catch(() => {})
            }

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
                            await appendGroupWithAvatarSplit(base, { ...g, updatedAt: Date.now() })
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

    // One-time migration: split any inline avatars in existing local records
    // into the avatars: keyspace. Rewrites group member lists in place so the
    // next re-mirror (or Rebuild Core) no longer carries inline bytes. Runs
    // once, guarded by migration:avatarDedupV1.
    try {
      const alreadyMigrated = await db.get('migration:avatarDedupV1').catch(() => null)
      if (!alreadyMigrated) {
        let splits = 0
        // Groups: rewrite members[] inline → hash
        const groupKeys = []
        for await (const { key, value } of db.createReadStream({ gt: NS.groups, lt: NS.groups + '\xff' })) {
          if (Array.isArray(value?.members) && value.members.some(m => typeof m?.avatar === 'string' && m.avatar.startsWith('data:'))) {
            groupKeys.push({ key, value })
          }
        }
        for (const { key, value } of groupKeys) {
          const { members } = await splitMembersInline(value.members)
          await db.put(key, { ...value, members })
          splits += value.members.length
        }
        // members:{groupId}:{memberId} per-member records
        const memberKeys = []
        for await (const { key, value } of db.createReadStream({ gt: NS.members, lt: NS.members + '\xff' })) {
          if (typeof value?.avatar === 'string' && value.avatar.startsWith('data:')) {
            memberKeys.push({ key, value })
          }
        }
        for (const { key, value } of memberKeys) {
          const hash = await storeAvatarLocal(value.avatar)
          if (hash) {
            const { avatar, ...rest } = value
            await db.put(key, { ...rest, avatarHash: hash })
            splits++
          }
        }
        await db.put('migration:avatarDedupV1', { ts: Date.now(), splits })
        console.log('[MIGRATION avatarDedupV1] split', splits, 'inline avatars across groups and members')
      }
    } catch (e) {
      console.error('[MIGRATION avatarDedupV1] error:', e.message)
    }
    // Drop tombstones older than TOMBSTONE_TTL_MS (and legacy tombstones with
    // no `ts`). Safe after the TTL window: the delete op has long since
    // linearized on every peer, so the sync-replay guard is no longer load-bearing.
    await pruneExpiredTombstones()

    // Re-join all existing groups
    const groups = []
    for await (const { value } of db.createReadStream({ gt: NS.groups, lt: NS.groups + '\xff' })) {
      groups.push(value)
    }

    // Fixup for devices that migrated before the event-groupId rewrite shipped:
    // any tombstoned old group still pointed to by local event records gets a
    // one-shot rewrite so the UI can target the new base. Idempotent — the
    // rewrite helper no-ops once no stale refs remain.
    try {
      for (const g of groups) {
        if (g?.migratedTo && g.id) await rewriteLocalEventGroupIds(g.id, g.migratedTo)
      }
    } catch (e) { console.warn('[REKEY] startup rewrite error:', e.message) }

    // Phase 3: auto-purge any migrated group whose grace period has elapsed.
    // Runs before joinGroup so we don't waste a swarm topic on cores we're
    // about to delete. Errors are swallowed — purge is best-effort at boot.
    try {
      const purged = await purgeAllMigratedGroups({ force: false })
      const wiped = new Set(purged.filter(r => r.ok).map(r => r.oldGroupId))
      if (wiped.size > 0) {
        console.log('[REKEY] startup purged', wiped.size, 'expired migrated groups')
        for (let i = groups.length - 1; i >= 0; i--) {
          if (wiped.has(groups[i].id)) groups.splice(i, 1)
        }
      }
    } catch (e) { console.warn('[REKEY] startup purge error:', e.message) }

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
      // Tombstoned by removeBrokenGroup — the user forgot this group. A prior
      // session may have resurrected it via mirror/foregroundSync before the
      // tombstone existed; clean up now and skip the join.
      if (await isForgottenGroup(g.id)) {
        console.log('[STARTUP] clearing resurrected forgotten group:', g.id)
        await deleteGroup(g.id).catch(() => {})
        continue
      }
      // Skip migrated source groups whose target group exists locally — adopt
      // already completed in a prior session, so re-opening the old base is
      // unnecessary. Re-opening it can crash autobase apply when peer writer
      // cores were misclassified as orphans by an earlier sweep, so we leave
      // it dormant until the grace-period purge cleans it up.
      if (g.migratedTo) {
        // If the target group is tombstoned, this old record is orphaned —
        // clean it up too so startup doesn't keep trying to re-open it.
        if (await isForgottenGroup(g.migratedTo)) {
          console.log('[STARTUP] clearing orphan migrated-from group:', g.id, '→ target', g.migratedTo, 'is forgotten')
          await deleteGroup(g.id).catch(() => {})
          continue
        }
        const target = await db.get(NS.groups + g.migratedTo).catch(() => null)
        if (target?.value) continue
      }
      await joinGroup(g).catch(async e => {
        console.error('joinGroup error:', e.message, 'groupId:', g.id)
        // STORAGE_EMPTY means the group's bootstrap Hypercore is gone from
        // the corestore. The group is unrecoverable — it can never sync again
        // without its bootstrap. Auto-delete the record so it stops
        // resurrecting after force-stop-and-reopen cycles when the tombstone
        // write from removeBrokenGroup doesn't fsync in time.
        if (/STORAGE_EMPTY/i.test(e?.message || '')) {
          console.log('[STARTUP] auto-deleting unrecoverable group:', g.id)
          await db.put('forgottenGroup:' + g.id, { ts: Date.now(), reason: 'storage_empty' }).catch(() => {})
          await deleteGroup(g.id).catch(() => {})
          return
        }
        await markGroupBroken(g.id, e)
      })
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
    scheduleMorningDigest().catch(e => console.warn('morning digest init:', e.message))
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
