const Hypercore     = require('hypercore')
const Hyperbee      = require('hyperbee')
const Hyperswarm    = require('hyperswarm')
const Autobase      = require('autobase')
const Corestore     = require('corestore')
const BlindPeering  = require('blind-peering')
const Wakeup        = require('protomux-wakeup')
const sodium        = require('sodium-native')
const b4a           = require('b4a')
const IdentityKey   = require('keet-identity-key')
const bip39         = require('bip39-mnemonic')
const { computeTodayCache } = require('./widget-cache.js')
const { canonicalize, signMessage, verifySignature } = require('./lib/sign.js')
const { rekeyGroup: _rekeyGroupLib } = require('./lib/rekey.js')
const { raceAppend, APPEND_TIMEOUT_MS } = require('./lib/appendTimeout.js')
const { shouldSwallowFault, parseConflictLog } = require('./lib/conflictSeatbelt.js')
const { writerRewindStatus } = require('./lib/rewindGuard.js')
const { createStoreFlusher } = require('./lib/storeFlush.js')
const {
  computeReminderFireTime,
  computeStartFireTime,
  buildReminderBody,
  buildStartBody,
} = require('./lib/reminders.js')
const {
  markerKey: migrationMarkerKey,
  buildMarker: buildMigrationMarker,
  verifyMarker: verifyMigrationMarker,
  readMarker: readMigrationMarker,
} = require('./lib/migration.js')

// Mobile shells inject `BareKit.IPC` (a duplex over the worklet bridge).
// Pear's bare worker exposes the same shape via `Pear.worker.pipe()`. Pick once
// at module load — both paths use the JSON-newline envelope identically.
const _isDesktopPear = typeof BareKit === 'undefined' && typeof Pear !== 'undefined'
const ipc = _isDesktopPear ? Pear.worker.pipe() : BareKit.IPC
const send = (msg) => ipc.write(Buffer.from(JSON.stringify(msg) + '\n'))

// Per-groupId debounce so clustered apply()/mirror emits (one peer reconnect
// can linearise dozens of blocks) collapse into a single UI refetch instead
// of paying serialize → IPC bridge → deserialize → re-render per block.
// A delta ({ changedEvents, removedIds, groupChanged, rsvpsChanged, fullReload })
// may be supplied so the UI patches local state instead of re-running listEvents().
// Omitting the second arg defaults to { fullReload: true } — lets unmigrated sites
// keep working while the delta path is being rolled out.
const SYNC_EMIT_DEBOUNCE_MS = 50
const _syncEmitTimers = new Map()
const _syncEmitPending = new Map()
function mergeSyncDelta (a, b) {
  if (!a) return b
  if (!b) return a
  const out = {}
  if (a.fullReload || b.fullReload) out.fullReload = true
  if (a.groupChanged || b.groupChanged) out.groupChanged = true
  if (a.rsvpsChanged || b.rsvpsChanged) out.rsvpsChanged = true
  const eventMap = new Map()
  for (const e of (a.changedEvents ?? [])) eventMap.set(e.id, e)
  for (const e of (b.changedEvents ?? [])) eventMap.set(e.id, e)
  const removed = new Set([...(a.removedIds ?? []), ...(b.removedIds ?? [])])
  for (const id of removed) eventMap.delete(id)
  if (eventMap.size) out.changedEvents = [...eventMap.values()]
  if (removed.size) out.removedIds = [...removed]
  return out
}
function emitSync (groupId, delta) {
  const key = groupId == null ? '__global__' : groupId
  const incoming = delta ?? { fullReload: true }
  _syncEmitPending.set(key, mergeSyncDelta(_syncEmitPending.get(key), incoming))
  const existing = _syncEmitTimers.get(key)
  if (existing) clearTimeout(existing)
  _syncEmitTimers.set(key, setTimeout(() => {
    _syncEmitTimers.delete(key)
    const merged = _syncEmitPending.get(key)
    _syncEmitPending.delete(key)
    send({ type: 'event', event: 'sync', data: { groupId, delta: merged } })
  }, SYNC_EMIT_DEBOUNCE_MS))
}

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

// Personal (multi-device) Autobase — TODO #11 Phase 3. One per user, shared
// across a user's devices. Stays null for single-device users who never enable
// multi-device (most installs today). Created/opened by ensurePersonalBase()
// when personalMeta:bootstrap is set in local DB.
let personalBase = null
// Platform string ('ios' | 'android' | …) supplied by the RN shell on init.
// Used to seed deviceMeta:{writerKey}.platform for the linked-devices list.
let _platform = null
let buf = ''
let _dbReady = false
let _dbReadyResolve = null
const _dbReadyPromise = new Promise(r => { _dbReadyResolve = r })

// ── Reliability helpers (proposal 2026-07-11-reliability-helpers) ─────────────
// safeAppend bounds every append so a wedged/forked base can't freeze the serial
// IPC dispatcher; the conflict seatbelt keeps a fork from crash-looping the
// worklet; the writer rewind guard stops a truncated writer core from
// self-forking; the store flusher bounds the RocksDB WAL. Pure logic lives in
// src/lib/{appendTimeout,conflictSeatbelt,rewindGuard,storeFlush}.js.
let _lastConflictAt = 0                 // ts of the most recent hypercore 'conflict'; gates the seatbelt
let _faultHandlersInstalled = false
const _degradedBases = new WeakSet()    // bases whose append timed out or forked -> skip further appends
const _rewoundBases = new WeakSet()     // log-once marker for a detected writer rewind

const STORE_FLUSH_INTERVAL_MS = 5 * 60 * 1000
let _storeFlushTimer = null
let _durabilityFlushTimer = null
const flushStore = createStoreFlusher({ getStore: () => store, warn: console.warn })

// Coalesced flush shortly after a writer append, so the WAL-loss window a
// force-kill can open stays small without flushing on every single write.
function scheduleDurabilityFlush () {
  if (_durabilityFlushTimer) return
  _durabilityFlushTimer = setTimeout(() => {
    _durabilityFlushTimer = null
    flushStore('writer-append').catch(() => {})
  }, 3000)
  if (_durabilityFlushTimer && _durabilityFlushTimer.unref) _durabilityFlushTimer.unref()
}

// Interval flush so a busy device's first-ever flush is never the giant 64 MB
// one whose cold-start replay trips Android's ANR watchdog. Unref'd.
function startStoreFlushCadence () {
  if (_storeFlushTimer) return
  _storeFlushTimer = setInterval(() => { flushStore('interval').catch(() => {}) }, STORE_FLUSH_INTERVAL_MS)
  if (_storeFlushTimer && _storeFlushTimer.unref) _storeFlushTimer.unref()
}

// Drop-in for `await base.append(op)`. Bounds the append (raceAppend) so it can
// never wedge the dispatcher: on timeout it flags the base and skips further
// appends to it, returning false. A normal rejection returns false too. Returns
// true iff the row appended. Callers that ignored append's (void) return are
// unaffected on the happy path and simply no longer hang on a corrupt base.
async function safeAppend (base, op, label) {
  if (!base) return false
  if (_degradedBases.has(base)) return false
  if (writerRewindBlocked(base)) return false   // never append past a truncated tip -> fork
  const { ok, timedOut } = await raceAppend(base.append(op), APPEND_TIMEOUT_MS)
  if (timedOut) {
    _degradedBases.add(base)
    console.warn('[bare] append timed out (' + (label || '') + '); base flagged, skipping further appends')
  } else if (ok) {
    scheduleDurabilityFlush()
  }
  return ok
}

// Synchronous, never-throws guard on the writer-append path. Blocks the append
// when our own writer core (base.local) is shorter than the longest copy a
// connected peer advertises for it -- which can only mean we were truncated
// (WAL loss), since nobody else signs our core. Appending past that tip would
// fork it, so we kick off a background download of the original tail and skip
// this append; it self-clears once we catch up. No peer connected =
// authoritative, proceed.
function writerRewindBlocked (base) {
  try {
    const local = base && base.local
    if (!local || !local.peers || local.peers.length === 0) return false
    let networkLen = 0
    for (const p of local.peers) { const rl = (p && p.remoteLength) || 0; if (rl > networkLen) networkLen = rl }
    const status = writerRewindStatus({ localLength: local.length, networkLength: networkLen })
    if (!status.behind) { _rewoundBases.delete(base); return false }
    if (!_rewoundBases.has(base)) {
      _rewoundBases.add(base)
      console.warn('[bare] writer rewind detected, pulling tail', status.downloadFrom, '->', status.downloadTo)
    }
    try { local.download({ start: status.downloadFrom, end: status.downloadTo }) } catch (e) { /* best-effort */ }
    return true
  } catch (e) { return false } // a guard bug must never block all appends
}

// Post-conflict seatbelt. A hypercore fork tears down sessions and leaks a
// 'Closed' rejection through the replicator; with no handler Bare aborts the
// whole worklet (the 17x crash loop). Swallow ONLY a conflict's fallout inside
// the grace window; fail fast on everything else so real bugs keep their stack.
function onWorkletFault (err, kind) {
  if (shouldSwallowFault(err, _lastConflictAt, Date.now())) {
    console.warn('[bare] swallowed post-conflict ' + kind + ': ' + ((err && err.message) || err))
    return
  }
  console.error('[bare] fatal ' + kind + ': ' + ((err && err.stack) || (err && err.message) || err))
  if (typeof Bare !== 'undefined' && Bare.exit) { try { Bare.exit(1); return } catch (e) {} }
  throw err
}

// Attach 'conflict' listeners to a base's writer + view Hypercore sessions so a
// fork stamps _lastConflictAt (arming the seatbelt) and flags the base. Safe to
// call repeatedly; fully defensive so a fork can't break the mount.
function attachConflictListeners (base) {
  if (!base) return
  for (const core of [base.local, base.view]) {
    try {
      if (core && typeof core.on === 'function') {
        core.on('conflict', () => { _lastConflictAt = Date.now(); _degradedBases.add(base) })
      }
    } catch (e) { /* never let listener wiring break a mount */ }
  }
}

// Install the global seatbelt once. Bare.on catches the leaked rejection;
// overriding console.log taps hypercore's '[hypercore] conflict detected in ...'
// line so a REMOTE member's fork (which per-core listeners never see) also arms
// the seatbelt. Guarded for the desktop Pear runtime where Bare is absent.
function installFaultHandlers () {
  if (_faultHandlersInstalled) return
  _faultHandlersInstalled = true
  if (typeof Bare !== 'undefined' && Bare.on) {
    Bare.on('uncaughtException', (err) => onWorkletFault(err, 'uncaughtException'))
    Bare.on('unhandledRejection', (err) => onWorkletFault(err, 'unhandledRejection'))
  }
  const _origConsoleLog = console.log.bind(console)
  console.log = function (...consoleArgs) {
    try { if (parseConflictLog(consoleArgs[0])) _lastConflictAt = Date.now() } catch (e) { /* logging must never throw */ }
    return _origConsoleLog(...consoleArgs)
  }
}

// ── Blind peering ────────────────────────────────────────────────────────────
// Blind peer key is now user-configurable via Settings → Seed Peer.
// Stored in local Hyperbee under 'blindPeerKey'.
let blind = null                     // BlindPeering instance

// ── Identity (seed-word-derived) ─────────────────────────────────────────────
// Cached IdentityKey instance for the life of the worklet. Derived from the
// device mnemonic via SLIP-48; identityPublicKey survives wipes.
let _identity = null                 // IdentityKey instance

// ── IPC ──────────────────────────────────────────────────────────────────────

// Bare→RN request/response: Bare sends {type:'nativeRequest', nativeId, method, args},
// RN replies with {type:'nativeResponse', nativeId, result|error}.
let _nativeNextId = 1
const _nativePending = new Map()
function nativeRequest (method, args = []) {
  return new Promise((resolve, reject) => {
    const nativeId = _nativeNextId++
    _nativePending.set(nativeId, { resolve, reject })
    send({ type: 'nativeRequest', nativeId, method, args })
  })
}

ipc.on('data', chunk => {
  buf += chunk.toString()
  const lines = buf.split('\n')
  buf = lines.pop()
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const msg = JSON.parse(line)
      if (msg.type === 'nativeResponse') {
        const pending = _nativePending.get(msg.nativeId)
        if (pending) {
          _nativePending.delete(msg.nativeId)
          if (msg.error) pending.reject(new Error(msg.error))
          else pending.resolve(msg.result)
        }
        continue
      }
      if (msg.method === 'init') init(msg.dataDir, { platform: msg.platform })
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
    case 'createGroup':      return createGroup(args[0], args[1])
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
    case 'computeUpcomingReminders': return computeUpcomingReminders(args[0], args[1])
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
    case 'listLinkedDevices': return listLinkedDevices()
    case 'setDeviceNickname': return setDeviceNickname(args[0])
    case 'removeDeviceFromList': return removeDeviceFromList(args[0])
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
    case 'getBackupStatus':  return nativeRequest('getBackupStatus')
    case 'setBackupEnabled': return nativeRequest('setBackupEnabled', [args[0]])
    case 'revealMnemonic':   return nativeRequest('getMnemonic')
    case 'restoreMnemonic':  return restoreMnemonic(args[0])
    case 'listPendingRejoins': return listPendingRejoins()
    case 'approveRejoin':    return approveRejoin(args[0], args[1])
    case 'denyRejoin':       return denyRejoin(args[0], args[1])
    case 'listPendingApprovals': return listPendingApprovals()
    case 'transferOwnership': return transferOwnership(args[0], args[1])
    case 'claimOwnership':   return claimOwnership(args[0])
    case 'enablePersonalSync':   return enablePersonalSync()
    case 'getPersonalSyncStatus': return getPersonalSyncStatus()
    case 'startPairing':      return startPairing()
    case 'cancelPairing':     return cancelPairing()
    case 'consumePairLink':   return consumePairLink(args[0])
    case 'getPairingStatus':  return getPairingStatus()
    case 'shutdown':       return shutdown()
    default: throw new Error('Unknown method: ' + method)
  }
}

// ── DB helpers ────────────────────────────────────────────────────────────────

const NS = {
  profile: 'profile',
  events:  'events:',
  groups:  'groups:',
  groupMembers: 'groupMembers:',
  members: 'members:',
  rsvp:    'rsvp:',
  privateNotes: 'privateNotes:',
  avatars: 'avatars:',
  deleted: 'deleted:',
}

// Extract the event id from an "events:{date}:{eventId}" key. Cannot use
// split(':').pop() because shadow ids contain colons (e.g.
// "shadow:src:fwd:gid"), which would return the last colon segment ("gid")
// instead of the full shadow id. Skips the "events:" prefix and the
// "YYYY-MM-DD:" date segment.
function eventIdFromKey (key) {
  const first = key.indexOf(':')
  if (first < 0) return key
  const second = key.indexOf(':', first + 1)
  if (second < 0) return key.slice(first + 1)
  return key.slice(second + 1)
}

// Strip occurrence + version suffixes to derive the series-root id from any
// occurrence id. For one-off events and the series root itself this is a
// no-op. Reminders are stored under the series-root key so all occurrences
// share one reminders record — see TODO #82 Phase 1.
//
// Suffix shapes:
//   `{rid}`             one-off / series root        -> `{rid}`
//   `{rid}_r{N}`        original-cadence occurrence  -> `{rid}`
//   `{rid}_v{V}`        regen series root (TODO #80) -> `{rid}`
//   `{rid}_v{V}_r{N}`   regen-cadence occurrence     -> `{rid}`
function reminderKeyId (eventId) {
  if (typeof eventId !== 'string') return eventId
  return eventId.replace(/(_v\d+)?(_r\d+)?$/, '')
}

// Tombstones (`deleted:{eventId}`) guard against sync-replay resurrection and
// duplicate delete notifications. After this window the originating delete op
// will have linearized on every peer's Autobase, so the guard is no longer
// load-bearing and the record is safe to drop.
const TOMBSTONE_TTL_MS = 180 * 24 * 60 * 60 * 1000

// Ownership-transfer: a non-owner can claim ownership only after the current
// owner has gone this long without authoring an Autobase write. Drop to a
// small number (e.g. 30e3) for manual E2E testing of the claim path.
const CLAIM_OWNERSHIP_INACTIVITY_MS = 30 * 24 * 60 * 60 * 1000

// Upper bound on how many `promoteOwner` entries we retain on the group
// record. Cap is defensive: a compromised or malicious client could otherwise
// ping-pong promotions and grow every peer's group blob without limit. Oldest
// entries are pruned first; UI shows most-recent-first anyway.
const PROMOTION_LOG_MAX = 20

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
    await safeAppend(base, {
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
  await safeAppend(base, { op: 'put', type: 'group', key: NS.groups + groupValue.id, value })
}

async function getPrivateNote (eventId) {
  const node = await db.get(NS.privateNotes + eventId).catch(() => null)
  return node?.value?.text ?? ''
}

async function putPrivateNote (eventId, text) {
  if (!text) {
    await db.del(NS.privateNotes + eventId).catch(() => {})
    // Empty text = delete. The helper turns null into a del op.
    await personalBaseAppendNote(eventId, null).catch(() => {})
    // Clear the consolidation marker: the del is in our own core now, so the
    // orphaned-marker sweep needn't re-push it.
    await db.del('cons:note:' + eventId).catch(() => {})
  } else {
    const value = { text, updatedAt: Date.now() }
    await db.put(NS.privateNotes + eventId, value)
    await personalBaseAppendNote(eventId, value).catch(() => {})
    // Consolidation marker (backup-integrity): own note already in our core.
    await db.put('cons:note:' + eventId, { updatedAt: value.updatedAt }).catch(() => {})
  }
}

async function getProfile () {
  const node = await db.get(NS.profile)
  return node?.value ?? null
}

async function updateProfile (updates) {
  const current = await getProfile()
  const updatedAt = Date.now()
  const next = { ...current, ...updates, updatedAt }
  await db.put(NS.profile, next)
  if ('digestEnabled' in updates || 'digestHour' in updates || 'digestMinute' in updates) {
    scheduleMorningDigest().catch(e => console.warn('morning digest reschedule:', e.message))
  }
  // Identity-scoped fields (name/avatar) sync across paired devices via
  // personal base. No-op when personal base is closed or not writable.
  if ('name' in updates || 'avatar' in updates) {
    personalBaseAppendIdentityProfile({
      name: next.name,
      avatar: next.avatar,
      updatedAt,
    }).catch(() => {})
  }
}

// Ensure a device mnemonic exists in RN secure storage. Generates one on first
// boot, otherwise returns the existing one. 16 bytes entropy → 12 BIP39 words;
// 128 bits is already beyond any practical brute-force threshold for an
// Ed25519-derived identity.
async function ensureMnemonic () {
  const has = await nativeRequest('hasMnemonic')
  if (!has) {
    const fresh = bip39.generateMnemonic({ entropy: bip39.generateEntropy(16) })
    await nativeRequest('setMnemonic', [fresh])
    console.log('[identity] generated fresh mnemonic (' + fresh.split(' ').length + ' words)')
    return fresh
  }
  const existing = await nativeRequest('getMnemonic')
  console.log('[identity] loaded existing mnemonic (' + (existing?.split(' ').length ?? 0) + ' words)')
  return existing
}

// Derive the device IdentityKey from the persisted mnemonic and cache it in
// memory. Idempotent — safe to call multiple times.
async function ensureIdentity () {
  if (_identity) return _identity
  const mnemonic = await ensureMnemonic()
  _identity = await IdentityKey.from({ mnemonic })
  console.log('[identity] derived identityPublicKey:',
    b4a.toString(_identity.identityPublicKey, 'hex').slice(0, 16) + '…')
  return _identity
}

// Validate a user-typed 12-word phrase, persist it to native storage, and
// re-derive the in-memory identity. Called by the onboarding "I already use
// PearCal → Enter recovery phrase" path.
//
// Also rewrites the local profile's id + identityPublicKey to the
// mnemonic-derived values so the restored user can be recognised by groups
// they originally owned (group.ownerId is the mnemonic-derived id).
// Safe in onboarding because no groups exist yet under the fresh profile.
async function restoreMnemonic (mnemonic) {
  if (typeof mnemonic !== 'string') throw new Error('restoreMnemonic: not a string')
  const normalised = mnemonic.trim().replace(/\s+/g, ' ').toLowerCase()
  if (!bip39.validateMnemonic(normalised)) {
    throw new Error('restoreMnemonic: invalid BIP39 phrase')
  }
  await nativeRequest('setMnemonic', [normalised])
  _identity = null
  _writerProofs.clear()
  await ensureIdentity()

  // Propagate the restored identity into the profile record. Without this the
  // local profile.id stays tied to whatever fresh random mnemonic ensureIdentity
  // minted at first boot — so every owner-recovery check that compares
  // profile.id against group.ownerId silently fails.
  const idHex  = b4a.toString(_identity.identityPublicKey, 'hex')
  const newId  = deriveProfileIdFromIdentity(_identity.identityPublicKey)
  const existing = await db.get(NS.profile).catch(() => null)
  if (existing?.value) {
    // Refuse to rebrand a profile that already has local groups/events —
    // rewriting id here would orphan every invitee/RSVP/member reference.
    // Onboarding restore runs before any groups exist, so this is only a
    // guardrail against accidentally hitting this path later.
    let hasGroups = false
    for await (const _ of db.createReadStream({ gt: NS.groups, lt: NS.groups + 'ÿ', limit: 1 })) {
      hasGroups = true; break
    }
    if (hasGroups && existing.value.id !== newId) {
      throw new Error('restoreMnemonic: local groups exist under a different id; wipe before restore')
    }
    await db.put(NS.profile, {
      ...existing.value,
      id: newId,
      identityPublicKey: idHex,
      updatedAt: Date.now(),
    })
  }

  return { identityPublicKey: idHex }
}

// Deterministic profile.id derived from identityPublicKey so the same seed
// phrase yields the same id across reinstalls. 16-byte blake2b → 32 hex chars,
// matching the width of the legacy hex(ed25519 pub) format.
function deriveProfileIdFromIdentity (identityPublicKey) {
  const out = b4a.alloc(16)
  sodium.crypto_generichash(out, identityPublicKey)
  return b4a.toString(out, 'hex')
}

// Per-groupId cache of the proof binding this device's Autobase writer key
// (base.local.key) to the mnemonic-derived identity. Persisted under
// 'writerProof:{groupId}' so epoch stays stable across restarts; invalidated
// automatically if the writerKey or identityPublicKey stored alongside no
// longer match the current ones. Receivers recover identityPublicKey via
// IdentityKey.verify(proof, writerKey).
const _writerProofs = new Map()

async function getOrCreateWriterProof (groupId, writerKey) {
  const cached = _writerProofs.get(groupId)
  if (cached) return cached
  if (!_identity) return null

  const currentIdentityHex = b4a.toString(_identity.identityPublicKey, 'hex')
  const persisted = await db.get('writerProof:' + groupId).catch(() => null)
  if (
    persisted?.value?.proofHex &&
    persisted.value.writerKey === writerKey &&
    persisted.value.identityPublicKey === currentIdentityHex
  ) {
    const buf = b4a.from(persisted.value.proofHex, 'hex')
    _writerProofs.set(groupId, buf)
    return buf
  }

  const proof = await IdentityKey.bootstrap(
    { identity: _identity.identityKeyPair },
    b4a.from(writerKey, 'hex')
  )
  _writerProofs.set(groupId, proof)
  await db.put('writerProof:' + groupId, {
    proofHex: b4a.toString(proof, 'hex'),
    writerKey,
    identityPublicKey: currentIdentityHex,
    createdAt: Date.now(),
  }).catch(e => console.warn('[identity] writerProof persist failed:', e.message))
  console.log('[identity] minted writerProof for', groupId, '(' + writerKey.slice(0, 12) + '…)')
  return proof
}

// Multi-device self-authorship check (TODO #11 Phase 4). Returns true iff the
// given `nodeWriterKey` belongs to any device of MY identity — meaning the
// op authored by that writer is a self-initiated action, not a remote peer's.
// Callers suppress their own notifications when this returns true.
//
// Uses the `writerIdentity:{groupId}:{writerKey}` index populated by every
// verified writer-announce, so a paired-sibling device's writerKey resolves
// to the shared identity within a few seconds of first connection.
async function isSelfAuthoredOp (groupId, nodeWriterKey) {
  if (!_identity || !nodeWriterKey) return false
  const myIdentityHex = b4a.toString(_identity.identityPublicKey, 'hex')
  const wi = await db.get('writerIdentity:' + groupId + ':' + nodeWriterKey).catch(() => null)
  return wi?.value?.identityPublicKey === myIdentityHex
}

// Build a writer-announce payload Buffer. If identity is available, attaches
// identityPublicKey + proof so the receiver can bind this writerKey to the
// identity (and recognise wipe+rejoin of an existing member in Phase 2).
// Falls back to the legacy shape when identity hasn't derived yet — receivers
// tolerate missing fields in Phase 1.
async function buildWriterAnnounce (groupId, writerKey, memberId) {
  const payload = { groupId, writerKey, memberId: memberId ?? null }
  try {
    const prof = await getProfile().catch(() => null)
    if (prof?.name) payload.name = prof.name
  } catch (e) {}
  try {
    const proof = await getOrCreateWriterProof(groupId, writerKey)
    if (proof && _identity) {
      payload.identityPublicKey = b4a.toString(_identity.identityPublicKey, 'hex')
      payload.proof = b4a.toString(proof, 'hex')
    }
  } catch (e) {
    console.warn('[identity] buildWriterAnnounce: proof unavailable for', groupId, e.message)
  }
  return Buffer.from(JSON.stringify(payload))
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
  const ownedGroupIds = await listOwnedGroupIds(profile?.id)
  // Dedupe by id keeping highest updatedAt — out-of-order Autobase replay can
  // leave a stale events:OLD_DATE:id sibling next to events:NEW_DATE:id when
  // the create message arrives after the edit-with-_prevDate message.
  const byId = new Map()
  for await (const { value } of db.createReadStream({ gt, lt })) {
    if (groupId && !value.groups?.includes(groupId)) continue
    if (!isInvitedToEvent(value, profile?.id, ownedGroupIds)) continue
    const prev = byId.get(value.id)
    if (!prev || (value.updatedAt ?? 0) >= (prev.updatedAt ?? 0)) byId.set(value.id, value)
  }
  const matched = [...byId.values()]
  // Batch-fetch private notes: one sequential scan over `privateNotes:` beats
  // N per-event `db.get()` calls (each pays tree traversal + proof verify).
  // Only matters if any matched event actually had a note; otherwise skip.
  if (matched.length === 0) return matched
  const notes = new Map()
  for await (const { key, value } of db.createReadStream({ gt: NS.privateNotes, lt: NS.privateNotes + '\xff' })) {
    const text = value?.text
    if (text) notes.set(key.slice(NS.privateNotes.length), text)
  }
  return matched.map(ev => {
    const note = notes.get(ev.id)
    return note ? { ...ev, privateNote: note } : ev
  })
}

async function dedupeStaleEventKeys () {
  if (!db) return
  const byId = new Map()
  for await (const { key, value } of db.createReadStream({ gt: NS.events, lt: NS.events + '\xff' })) {
    if (!value?.id) continue
    const list = byId.get(value.id) ?? []
    list.push({ key, updatedAt: value.updatedAt ?? 0 })
    byId.set(value.id, list)
  }
  let removed = 0
  for (const [, entries] of byId) {
    if (entries.length < 2) continue
    entries.sort((a, b) => b.updatedAt - a.updatedAt)
    for (let i = 1; i < entries.length; i++) {
      await db.del(entries[i].key).catch(() => {})
      removed++
    }
  }
  if (removed > 0) {
    console.log('[DEDUPE] removed', removed, 'stale event keys')
    scheduleWidgetCacheRefresh()
  }
}

async function putEvent (event) {
  const { privateNote, ...rest } = event
  const toStore = { ...rest, updatedAt: Date.now() }
  await db.put(NS.events + event.date + ':' + event.id, toStore)
  if (privateNote !== undefined) await putPrivateNote(event.id, privateNote)
  // Mirror to personal base if this is a personal-scope event (no groups) and
  // multi-device is enabled. No-op otherwise.
  await personalBaseAppendEvent(toStore).catch(() => {})
  // Consolidation marker (TODO #11 backup-integrity): record that this device's
  // own core already carries this event version, so runPersonalConsolidation
  // won't redundantly re-publish events we authored. Personal-scope only.
  if (!(toStore.groups && toStore.groups.length)) {
    await db.put('consolidated:' + event.id, { updatedAt: toStore.updatedAt }).catch(() => {})
  }
  scheduleWidgetCacheRefresh()
  return event
}

async function deleteEvent (date, id) {
  // Read the event first so we can decide whether to wipe reminders. Series
  // reminders live at the series-root key (TODO #82 Phase 1) and must
  // outlive any single-occurrence delete; only one-off events own their
  // reminders key.
  const node = await db.get(NS.events + date + ':' + id).catch(() => null)
  const ev = node?.value
  await db.del(NS.events + date + ':' + id)
  if (!ev?.recurrenceId) {
    await db.del('reminders:' + id).catch(() => {})
  }
  await db.del(NS.privateNotes + id).catch(() => {})
  await _deleteAllRsvps(id).catch(() => {})
  // Tombstone guards against mirror-replay resurrection. localDeleteEvent
  // already writes one for non-creator deletes; this path covers creator
  // deletes and shadow deletes where the del op never passes through the
  // remote-apply branch that writes the tombstone downstream.
  await db.put(NS.deleted + id, { date, ts: Date.now() }).catch(() => {})
  await personalBaseDeleteEvent(date, id).catch(() => {})
  scheduleWidgetCacheRefresh()
}

async function deleteEventSeries (recurrenceId) {
  const toDelete = []
  for await (const { key, value } of db.createReadStream({ gt: NS.events, lt: NS.events + '\xff' })) {
    if (value.recurrenceId === recurrenceId) toDelete.push({ key, id: value.id, date: value.date })
  }
  for (const { key, id, date } of toDelete) {
    await db.del(key)
    await db.del(NS.privateNotes + id).catch(() => {})
    await _deleteAllRsvps(id).catch(() => {})
    await db.put(NS.deleted + id, { date, ts: Date.now() }).catch(() => {})
    await personalBaseDeleteEvent(date, id).catch(() => {})
  }
  // Series-level reminders cleanup (one entry per series under the root id).
  await db.del('reminders:' + recurrenceId).catch(() => {})
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
  const ownedGroupIds = await listOwnedGroupIds(profile?.id).catch(() => new Set())
  const payload = await computeTodayCache(db, {
    profileId: profile?.id,
    isInvitedToEvent,
    ownedGroupIds,
    use24h: profile?.use24h,
    widgetShowUpcoming: profile?.widgetShowUpcoming,
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
      await safeAppend(base, { op: 'put', type: 'rsvp', key: NS.rsvp + eventId + ':' + memberId, value: record })
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
  const id = reminderKeyId(eventId)
  const node = await db.get('reminders:' + id)
  if (node) return node.value
  // Pre-Phase-1 fallback: occurrences may have been written under their own
  // occurrence id (`{rootId}_r{N}`). Rescue once and migrate forward to the
  // series-root key.
  if (id !== eventId) {
    const legacy = await db.get('reminders:' + eventId)
    if (legacy) {
      await db.put('reminders:' + id, legacy.value).catch(() => {})
      return legacy.value
    }
  }
  // One-time migration: seed from legacy event.reminder field
  let legacyReminder = 0
  for await (const { value } of db.createReadStream({ gt: NS.events, lt: NS.events + '\xff' })) {
    if (value.id === eventId) { legacyReminder = value.reminder ?? 0; break }
  }
  if (legacyReminder > 0) {
    const migrated = [legacyReminder]
    await db.put('reminders:' + id, migrated)
    return migrated
  }
  return []
}

async function putReminders (eventId, reminders) {
  const id = reminderKeyId(eventId)
  await db.put('reminders:' + id, reminders)
  await personalBaseAppendReminders(id, reminders).catch(() => {})
  // Consolidation marker (backup-integrity): own records are already in our
  // core, so runPersonalConsolidation skips them. Reminders carry no updatedAt,
  // so the token is the serialized value.
  await db.put('cons:rem:' + id, { token: JSON.stringify(reminders) }).catch(() => {})
}

// Top-K next firings across all events. The RN shell calls this on boot,
// foreground, and after each save/delete, then schedules into a fixed
// alarm-id range so the iOS 64-slot quota stays honored even with thousands
// of recurring-series occurrences. See TODO #82 Phase 2.
async function computeUpcomingReminders (K, tzName) {
  const k = Number.isFinite(K) && K > 0 ? K : 50
  const profile = await getProfile().catch(() => null)
  const myId = profile?.id
  const now = Date.now()
  const triples = []

  // Cache per-series reminders so a 500-occurrence run only reads them once.
  const reminderCache = new Map()
  async function remindersFor (ev) {
    const key = reminderKeyId(ev.id)
    if (reminderCache.has(key)) return reminderCache.get(key)
    const r = await getReminders(ev.id).catch(() => [])
    reminderCache.set(key, r || [])
    return r || []
  }

  for await (const { value: ev } of db.createReadStream({ gt: NS.events, lt: NS.events + '\xff' })) {
    if (!ev || ev.isShadow) continue

    if (myId) {
      const rsvpNode = await db.get(NS.rsvp + ev.id + ':' + myId).catch(() => null)
      if (rsvpNode?.value?.status === 'declined') continue
    }

    const reminders = await remindersFor(ev)
    for (const r of reminders) {
      const fireAt = computeReminderFireTime(ev, r, tzName)
      if (fireAt && fireAt > now) {
        triples.push({
          eventId: ev.id,
          fireAt,
          title:   ev.title,
          body:    buildReminderBody(ev, r),
          tab:     'calendar',
        })
      }
    }

    const startMs = computeStartFireTime(ev, tzName)
    if (startMs && startMs > now) {
      triples.push({
        eventId: ev.id,
        fireAt:  startMs,
        title:   (ev.title || 'Event') + ' is starting now',
        body:    buildStartBody(ev),
        tab:     'calendar',
      })
    }
  }

  triples.sort((a, b) => a.fireAt - b.fireAt)
  return triples.slice(0, k)
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

// Phase 1 read-both shim for TODO #70. When a Phase 2+ peer writes split ops
// (`type: 'groupMembers'`), the members list lives in `groupMembers:{id}` and
// the `groups:{id}` record holds metadata only. Rehydrate to the unified shape
// so every existing `group.members` reader keeps working.
async function rehydrateGroupMembers (groupValue) {
  if (!groupValue?.id) return groupValue
  const gm = await db.get(NS.groupMembers + groupValue.id).catch(() => null)
  if (gm?.value?.members) return { ...groupValue, members: gm.value.members }
  return groupValue
}

async function getGroup (id) {
  const node = await db.get(NS.groups + id)
  return rehydrateGroupMembers(node?.value ?? null)
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
    groups.push(await rehydrateGroupMembers(value))
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
  // Phase 5: clear identity-level block locally for immediate UI parity with
  // the Autobase apply branch.
  if (memberRecord?.identityPublicKey) {
    await db.del('blockedIdentity:' + groupId + ':' + memberRecord.identityPublicKey).catch(() => {})
  }
  // Append dedicated Autobase op so all devices process the reinvite deterministically
  // (the local-only group update above would lose LWW against the removal record)
  await syncReinviteMember(groupId, memberId)
}

async function deleteGroup (id) {
  await db.del(NS.groups + id)
  await db.del(NS.groupMembers + id).catch(() => {})
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

async function createGroup (name, metadata) {
  const profile = await getProfile()
  if (!profile?.id) throw new Error('createGroup: no profile')

  const groupId = 'g' + Math.random().toString(36).slice(2, 8)
  const groupStore = store.namespace(groupId)

  // bootstrap=null mints a fresh Autobase key — that becomes the real groupKey.
  const base = new Autobase(groupStore, null, {
    valueEncoding: 'json',
    open: (s) => new Hyperbee(s.get('view'), { keyEncoding: 'utf-8', valueEncoding: 'json' }),
    apply: makeApply(groupId),
    ackInterval: 1000,
  })
  // Without an 'error' listener Autobase calls crashSoon() on internal
  // failures (e.g., Hypercore "Truncation breaks prologue" during drain),
  // killing the bare runtime. The listener turns those into recoverable
  // events so the runtime stays alive and other groups keep working.
  base.on('error', e => console.error('[group] base error (createGroup):', groupId, e?.message))
  await base.ready()
  attachConflictListeners(base)
  const groupKey = b4a.toString(base.key, 'hex')
  const writerKey = b4a.toString(base.local.key, 'hex')

  const meta = metadata || {}
  const initials = (profile.name || '').trim().split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 2) || '?'
  const ownerMember = {
    id: profile.id,
    name: profile.name,
    avatar: profile.avatar ?? initials,
    publicKey: profile.publicKey,
    writerKey,
  }
  if (profile.identityPublicKey) ownerMember.identityPublicKey = profile.identityPublicKey

  const now = Date.now()
  const group = {
    id: groupId,
    name: (name || '').trim() || 'Group',
    color: meta.color,
    emoji: meta.emoji,
    icon: meta.icon,
    ownerId: profile.id,
    members: [ownerMember],
    groupKey,
    removedMembers: [],
    joinedAt: now,
    updatedAt: now,
    lastOwnerActivityTs: now,
    lastPromoteTs: 0,
    promotionLog: [],
  }

  await putGroup(group)
  await putMember(groupId, ownerMember)
  await db.put('joinedAt:' + groupId, { ts: group.joinedAt })

  // Seed owner as writer + the group record into the Autobase view so
  // apply()'s non-null group check passes when joiners' broadcastSelf arrives.
  try {
    if (await safeAppend(base, { addWriter: writerKey })) {
      await db.put('knownWriter:' + groupId + ':' + writerKey, { ts: Date.now() }).catch(() => {})
    }
    await appendGroupWithAvatarSplit(base, group)
  } catch (e) {
    console.warn('[createGroup] seed error:', e.message)
  }

  await base.close()
  await joinGroup(group)
  return group
}

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

  // All peers (incl. restored owner) open the existing Autobase by groupKey.
  // For the real-first-time group-creator path, see createGroup() above.
  const bootstrap = b4a.from(group.groupKey, 'hex')

  const base = new Autobase(groupStore, bootstrap, {
    valueEncoding: 'json',
    open: (s) => new Hyperbee(s.get('view'), { keyEncoding: 'utf-8', valueEncoding: 'json' }),
    apply: makeApply(group.id),
    ackInterval: 1000,
  })
  // Without an 'error' listener Autobase calls crashSoon() on internal
  // failures (e.g., Hypercore "Truncation breaks prologue" during drain),
  // killing the bare runtime. The listener turns those into recoverable
  // events so the runtime stays alive and other groups keep working.
  base.on('error', e => console.error('[group] base error (joinGroup):', group.id, e?.message))
  await base.ready()
  attachConflictListeners(base)

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

  // Owner's own write-access: if this is the same-device owner, base.writable
  // is already true (bootstrap.writable = true → used as local). For a restored
  // owner on a fresh device, base.writable is false — they wait for another
  // member to grant addWriter via writer-announce admission (see §3 in plan).
  // Owner-side pending-announce drain (owner rubber-stamps writerKeys queued
  // before joinGroup finished — legacy behaviour kept for back-compat).
  if (isOwner) {
    const pending = pendingWriterAnnouncements.get(group.id)
    if (pending) {
      for (const writerKey of pending) {
        const knownKey = 'knownWriter:' + group.id + ':' + writerKey
        const already = await db.get(knownKey).catch(() => null)
        if (already) continue
        safeAppend(base, { addWriter: writerKey })
          .then((ok) => { if (ok) db.put(knownKey, { ts: Date.now() }).catch(() => {}) })
          .catch(e => console.error('[OWNER] pending addWriter error:', e.message))
      }
      pendingWriterAnnouncements.delete(group.id)
    }
  }

  bases.set(group.id, base)

  // Warm up the identity→writer-key proof so writer-announce can attach it.
  // Fire-and-forget: writer-announce retries and re-calls this helper, so a
  // one-off failure here (e.g. identity unavailable mid-boot) is recoverable.
  try {
    const localWriterKey = base.local?.key ? b4a.toString(base.local.key, 'hex') : null
    if (localWriterKey) {
      getOrCreateWriterProof(group.id, localWriterKey)
        .catch(e => console.warn('[identity] writerProof warmup failed for', group.id, e.message))
    }
  } catch (e) {
    console.warn('[identity] writerProof warmup threw for', group.id, e.message)
  }

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
        // Restored-owner guard: after Autobase replay corrects ownerId back to
        // the mnemonic-derived profile.id, the joiner turns out to be the owner.
        // A self-thin authoritative broadcast (members=[self]) would wipe every
        // other member. Suppress permanently in that case.
        if (g.ownerId === p.id) {
          await db.put('selfBroadcasted:' + groupId, { ts: Date.now() }).catch(() => {})
          return
        }
        const initials = (p.name || '').trim().split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 2) || '?'
        const selfWriterKey = b4a.toString(base.local.key, 'hex')
        const myMember = { id: p.id, name: p.name, avatar: p.avatar ?? initials, publicKey: p.publicKey, writerKey: selfWriterKey }
        const updatedGroup = { id: g.id, groupKey: g.groupKey, ownerId: g.ownerId, members: [myMember], updatedAt: Date.now() }
        await appendGroupWithAvatarSplit(base, updatedGroup)
        await db.put('selfBroadcasted:' + groupId, { ts: Date.now() })
        console.log('[BROADCAST_SELF] auto-broadcast succeeded for group:', groupId)
      } catch (e) {
        console.error('[BROADCAST_SELF] auto-broadcast error:', e.message)
      }
    }
    // On rejoin (same namespace = same writerKey, addWriter already linearized),
    // the base opens already writable and 'writable' never re-fires, so the
    // once-handler would hang indefinitely. Check synchronously first and
    // invoke directly in that case — this is the JS one-shot-init pattern.
    if (base.writable) doBroadcastSelf()
    else base.once('writable', doBroadcastSelf)
  }

  // Owner post-upgrade bootstrap: for groups created before the ownership-
  // transfer feature landed, the owner's member record in the shared view
  // carries no writerKey. Without it, the apply()-side owner-activity
  // heartbeat can't tell which Autobase author is the owner, so
  // lastOwnerActivityTs never bumps and non-owners eventually hit the
  // inactivity gate on a still-active owner. Fix once, idempotently: stamp
  // our writerKey onto the owner's member record via an authoritative
  // group-put. Skip when the view already has it.
  if (isOwner) {
    const stampOwnerWriterKey = async () => {
      try {
        // Multi-device guard (TODO #11 Phase 4 regression fix). On a secondary
        // device paired from an existing primary, `isOwner` is true because the
        // group's ownerId matches our identity-derived profile.id — but the
        // primary is the active owner writer, not us. Stamping here would
        // append {members: [self-only], updatedAt: now} to the group's
        // Autobase; the apply() LWW rule then treats it as authoritative
        // (owner-id present in incoming members), dropping every other member
        // including the primary's entry. The owner-activity heartbeat from PR
        // #129 already matches any device of the owner's identity, so the
        // stamp isn't needed for a paired sibling. `claimOwnership` handles
        // the "primary permanently gone" case separately.
        const pairMeta = await db.get('personalMeta:bootstrap').catch(() => null)
        if (pairMeta?.value?.adoptedFromPair) {
          console.log('[OWNER_WRITERKEY_STAMP] skipping — paired-sibling device:', group.id)
          return
        }
        const ownerWriterKey = b4a.toString(base.local.key, 'hex')
        const g = await getGroup(group.id)
        if (!g) return
        const ownerM = (g.members ?? []).find(m => m.id === profile?.id)
        if (ownerM?.writerKey === ownerWriterKey) return
        const updatedMembers = (g.members ?? []).map(m =>
          m.id === profile?.id ? { ...m, writerKey: ownerWriterKey } : m
        )
        const updated = { ...g, members: updatedMembers, updatedAt: Date.now() }
        await appendGroupWithAvatarSplit(base, updated)
        console.log('[OWNER_WRITERKEY_STAMP] stamped writerKey on', group.id)
      } catch (e) { console.warn('[OWNER_WRITERKEY_STAMP]', e?.message) }
    }
    if (base.writable) stampOwnerWriterKey()
    else base.once('writable', stampOwnerWriterKey)
  }

  // Announce our writer key to any already-connected peers
  const writerKey = b4a.toString(base.local.key, 'hex')
  const announceBuf = await buildWriterAnnounce(group.id, writerKey, profile?.id)
  for (const ch of activeChannels) {
    try { ch.send(announceBuf) } catch(e) {}
  }

  // Always use group.groupKey as swarm topic so both sides match
  // (owner updates groupKey to realKey before this point)
  const topicKey = group.groupKey
  const topic = b4a.from(topicKey.slice(0, 64).padEnd(64, '0'), 'hex')
  swarm.join(topic, { server: true, client: true })

  console.log('Joined group swarm:', group.id, 'topic:', topicKey.slice(0,16))

  // Register with blind peer so cores stay available when app is closed
  if (blind) blind.addAutobaseBackground(base)

  // Multi-device membership log: record that this identity is in this group
  // so sibling devices discover it via the personal base (Phase 5).
  await personalBaseAddGroup(group).catch(() => {})
  // Multi-device write redundancy (Phase A): advertise this device's per-group
  // writer key so sibling devices that are writers here can cross-grant it.
  // No-op if the personal base isn't writable yet — the redundancy sweep
  // re-publishes once it becomes writable.
  await personalBaseAddGroupWriter(group.id, writerKey).catch(() => {})
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
  // Personal-base mirror: if multi-device is on, drop this group from the
  // personal base's group-membership log so sibling devices also leave.
  await personalBaseRemoveGroup(groupId).catch(() => {})
  // Drop this device's group-writer advertisement (Phase A) too.
  await personalBaseRemoveGroupWriter(groupId).catch(() => {})
}

// ── Personal Autobase (multi-device identity, TODO #11 Phase 3) ──────────────
// One per user, shared across devices. Keyspaces in the view mirror the
// personal-scope slice of local DB: events without groups, deleted tombstones,
// reminders, private notes, plus group-membership records so new devices
// discover which groups this identity is in.
//
// Creation is LAZY — single-device installs never pay the ~2-4× append-
// amplification cost. Callers who write personal-scope data (putEvent,
// putReminders, putPrivateNote, joinGroup, leaveGroup) funnel through the
// personalBase*() helpers below, which no-op when personalBase is null.
//
// Bootstrap strategy for PR #A: first device's base key is random and stored
// under personalMeta:bootstrap. Siblings receive the key via pairing (PR #C).
// Follow-up: switch to deterministic bootstrap via `_identity.profileDiscoveryKeyPair`
// so mnemonic-alone restore can open the same base without a live peer (Fork A,
// full form). Locking that in needs the pairing UX and isn't forced by PR #A.

function makePersonalApply () {
  return async function apply (nodes, view, host) {
    for (const node of nodes) {
      const val = node.value
      if (!val) continue

      if (val.addWriter) {
        const blocked = await db.get('blockedWriter:personal:' + val.addWriter).catch(() => null)
        if (!blocked) {
          await host.addWriter(b4a.from(val.addWriter, 'hex'), { indexer: true })
        }
        continue
      }

      if (val.op === 'put' && val.type === 'event' && val.key && val.value) {
        await view.put(val.key, val.value)
        await mirrorToLocal('event', val.key, val.value, null)
        continue
      }
      if (val.op === 'del' && val.type === 'event' && val.key) {
        await view.del(val.key)
        const eid = eventIdFromKey(val.key)
        if (eid) {
          // Read the event before deleting so we can preserve series-level
          // reminders (TODO #82 Phase 1). Worst case the local copy is
          // already gone — `db.del('reminders:' + eid)` below would be a
          // no-op anyway under the new keying.
          const evNode = await db.get(val.key).catch(() => null)
          const evRec = evNode?.value
          // Persist the event date in the tombstone (extracted from the op key
          // `events:{date}:{id}`) so the consolidation sweep can re-publish this
          // deletion under the exact key — without it, a sibling-originated
          // delete couldn't be re-keyed and a deleted event could resurrect on
          // a freshly-paired device from a previously-consolidated put.
          const _rest = val.key.slice(NS.events.length)
          const _ci = _rest.indexOf(':')
          const _evDate = _ci > 0 ? _rest.slice(0, _ci) : null
          await db.put(NS.deleted + eid, { ts: Date.now(), date: _evDate }).catch(() => {})
          await db.del(val.key).catch(() => {})
          if (!evRec?.recurrenceId) {
            await db.del('reminders:' + eid).catch(() => {})
          }
          await db.del(NS.privateNotes + eid).catch(() => {})
          // Emit sync so sibling-device UIs refresh in real-time. Without
          // this the personal-base del replicates to local DB but the calendar
          // state keeps the stale event until the app reopens.
          emitSync(null, { removedIds: [eid] })
        }
        scheduleWidgetCacheRefresh()
        continue
      }

      if (val.op === 'put' && val.type === 'reminders' && val.key) {
        await view.put(val.key, val.value)
        await db.put(val.key, val.value).catch(() => {})
        continue
      }
      if (val.op === 'del' && val.type === 'reminders' && val.key) {
        await view.del(val.key)
        await db.del(val.key).catch(() => {})
        continue
      }

      if (val.op === 'put' && val.type === 'note' && val.key) {
        await view.put(val.key, val.value)
        await db.put(val.key, val.value).catch(() => {})
        continue
      }
      if (val.op === 'del' && val.type === 'note' && val.key) {
        await view.del(val.key)
        await db.del(val.key).catch(() => {})
        continue
      }

      // Identity-scoped profile fields (name, avatar). LWW between siblings is
      // enforced at the view level — incoming op is rejected only if its
      // updatedAt is older than the view's known record. Don't gate on local
      // profile.updatedAt: that timestamp is multi-purpose (settings edits,
      // _handlePairGranted's identity rewrite) and unrelated to identity-field
      // edit history. Comparing against it caused freshly-paired secondaries
      // to silently reject the primary's identityProfile because pair-grant
      // had just bumped local profile.updatedAt past the primary's older
      // name-set timestamp.
      if (val.op === 'put' && val.type === 'identityProfile' && val.key && val.value) {
        const prev = await view.get(val.key).catch(() => null)
        const prevTs = prev?.value?.updatedAt ?? 0
        const incomingTs = val.value?.updatedAt ?? 0
        if (incomingTs < prevTs) continue
        await view.put(val.key, val.value)
        const existing = (await db.get(NS.profile).catch(() => null))?.value ?? {}
        await db.put(NS.profile, {
          ...existing,
          name: val.value.name ?? existing.name ?? '',
          avatar: val.value.avatar ?? existing.avatar ?? '',
        })
        send({ type: 'event', event: 'profileChanged', data: null })
        continue
      }

      // Per-device metadata for the linked-devices list (TODO #95). Each device
      // self-writes its own row keyed by writer key. Authoritative gate uses
      // node.from.key (the Autobase-attested authoring writer) — value.writerKey
      // is just data and could be lied about; node.from.key cannot. LWW by
      // updatedAt against the LOCAL DB mirror.
      // Skips view.put on purpose: writing to the linearized view triggers
      // Autobase's truncate-vs-prologue crash on already-paired secondaries
      // when the view rebase rolls back across deviceMeta blocks. Cross-device
      // sync still works because apply runs on every peer for every writer's
      // ops, so each peer's db.put converges independently.
      // Op shape: { op: 'put', type: 'deviceMeta', key: 'deviceMeta:{writerKey}',
      //   value: { writerKey, nickname, platform, pairedAt, updatedAt } }
      if (val.op === 'put' && val.type === 'deviceMeta' && val.key && val.value) {
        const rowWriter = val.value.writerKey
        const fromKey = node.from?.key ? b4a.toString(node.from.key, 'hex') : null
        // Only the device whose writerKey === Autobase-attested author may put
        // its row. Reject when fromKey is missing or differs.
        if (!rowWriter || !fromKey || rowWriter !== fromKey) continue
        if (val.key !== 'deviceMeta:' + rowWriter) continue
        const prevDb = (await db.get(val.key).catch(() => null))?.value
        const prevTs = prevDb?.updatedAt ?? 0
        const incomingTs = val.value?.updatedAt ?? 0
        if (incomingTs < prevTs) continue
        await db.put(val.key, val.value).catch(() => {})
        // A fresh deviceMeta put unmutes the device — covers a removed device
        // coming back online (factory-reset return, user rename after remove).
        await db.del('deviceMetaHidden:' + rowWriter).catch(() => {})
        send({ type: 'event', event: 'linkedDevicesChanged', data: null })
        continue
      }
      // Cosmetic remove via removeDeviceFromList (proposal 2026-04-27). Any
      // paired writer can author this — paired devices are trust-equivalent.
      // Drops the local row AND stamps deviceMetaHidden:{key} so the
      // synthesise-from-activeWriters path in listLinkedDevices doesn't
      // resurrect a placeholder. Cleared automatically when a fresh put
      // arrives for the same writer (above).
      if (val.op === 'del' && val.type === 'deviceMeta' && val.key) {
        const writerKey = val.key.slice('deviceMeta:'.length)
        if (!writerKey) continue
        // Each device must always see itself in the list. If a sibling
        // authored a remove for OUR writer (e.g., the user "removed" this
        // device on another paired device, then this one came back online),
        // ignore the mute locally — they remove us from THEIR view but our
        // self row stays. Renaming on this device re-puts the row, which
        // clears the hidden marker on siblings via the put branch above.
        const localKey = personalBase?.local?.key
          ? b4a.toString(personalBase.local.key, 'hex') : null
        if (writerKey === localKey) {
          send({ type: 'event', event: 'linkedDevicesChanged', data: null })
          continue
        }
        await db.del(val.key).catch(() => {})
        await db.put('deviceMetaHidden:' + writerKey, { ts: Date.now() }).catch(() => {})
        send({ type: 'event', event: 'linkedDevicesChanged', data: null })
        continue
      }

      // Per-group writer-key advertisements for multi-device write redundancy
      // (Phase A). Each device publishes its OWN per-group Autobase writer key
      // here so sibling devices that are already writers on the group can grant
      // it write access ("cross-grant") — no external group member needed to
      // re-authorize a wiped/late-paired device. Authorial gate mirrors
      // deviceMeta: node.from.key (the Autobase-attested author) must equal the
      // row's personalWriterKey; value fields are untrusted for the gate. db.put
      // only (no view.put) to dodge the truncate-vs-prologue rebase crash, same
      // as the deviceMeta branch. LWW by updatedAt against the local mirror.
      if (val.op === 'put' && val.type === 'deviceGroupWriter' && val.key && val.value) {
        const rowWriter = val.value.personalWriterKey
        const fromKey = node.from?.key ? b4a.toString(node.from.key, 'hex') : null
        if (!rowWriter || !fromKey || rowWriter !== fromKey) continue
        if (val.key !== 'deviceGroupWriter:' + val.value.groupId + ':' + rowWriter) continue
        const prevDb = (await db.get(val.key).catch(() => null))?.value
        if ((val.value.updatedAt ?? 0) < (prevDb?.updatedAt ?? 0)) continue
        await db.put(val.key, val.value).catch(() => {})
        // A sibling advertised its group writer key — grant it now if we're a
        // writer on that group. Fire-and-forget; the periodic sweep also covers
        // the case where this device isn't a writer yet but becomes one later.
        maybeCrossGrantGroupWriter(val.value.groupId, val.value.groupWriterKey, rowWriter)
          .catch(e => console.warn('[xgrant] apply-trigger error:', e?.message))
        continue
      }
      if (val.op === 'del' && val.type === 'deviceGroupWriter' && val.key) {
        await db.del(val.key).catch(() => {})
        continue
      }

      // Group membership records for multi-device discovery (Phase 5). Records
      // which groups this identity is in so a paired secondary can iterate
      // them on boot. Stored under `personalGroups:{groupId}` in local DB.
      if (val.op === 'put' && val.type === 'groupMembership' && val.key && val.value) {
        await view.put(val.key, val.value)
        await db.put(val.key, val.value).catch(() => {})
        // Auto-open the group's Autobase on this device if we don't already
        // have it, so the sibling join propagates as a real "this device is
        // now in that group" — not just a local DB pointer. Idempotent:
        // joinGroup short-circuits when the base is already open, and the
        // local seed is skipped if a group record already exists.
        const groupId  = val.value.groupId
        const groupKey = val.value.groupKey
        // Skip if this device was previously kicked from this group — a stale
        // sibling pointer should not resurrect a ghost group locally.
        const blocked = groupId ? await db.get('blockedFromGroup:' + groupId).catch(() => null) : null
        if (blocked?.value) continue
        if (groupId && groupKey && !bases.has(groupId)) {
          const existingGroup = await db.get(NS.groups + groupId).catch(() => null)
          if (!existingGroup?.value) {
            const profile = await getProfile().catch(() => null)
            const selfMember = profile ? {
              id: profile.id,
              name: profile.name,
              avatar: profile.avatar ?? '?',
              publicKey: profile.publicKey,
              ...(profile.identityPublicKey ? { identityPublicKey: profile.identityPublicKey } : {}),
            } : null
            const seed = {
              id:       groupId,
              name:     val.value.name,
              color:    val.value.color,
              emoji:    val.value.emoji,
              icon:     val.value.icon,
              ownerId:  val.value.ownerId,
              groupKey,
              members:  selfMember ? [selfMember] : [],
              joinedAt: val.value.joinedAt ?? Date.now(),
            }
            await db.put(NS.groups + groupId, seed).catch(() => {})
            await db.put('joinedAt:' + groupId, { ts: seed.joinedAt }).catch(() => {})
          }
          // Stamp "ever-seen" marker AFTER ensuring local group is seeded.
          // cleanupStalePersonalGroups gates on this marker so a freshly-paired
          // secondary mid-replication doesn't sweep personalGroups entries
          // before the group autobases have arrived. Marker present ⇒ this
          // device has had the group locally at least once; safe to delete the
          // personalGroups entry on a future cleanup if the local group later
          // disappears (user-initiated leave, kick).
          await db.put('personalSeenGroup:' + groupId, { ts: Date.now() }).catch(() => {})
          const localGroup = (await db.get(NS.groups + groupId).catch(() => null))?.value
          if (localGroup) {
            joinGroup(localGroup).catch(e =>
              console.warn('[personal] auto-joinGroup error for', groupId, e.message))
          }
        }
        // Full reload — a sibling joined a new group; UI's group list should refresh.
        emitSync(null, { fullReload: true })
        continue
      }
      if (val.op === 'del' && val.type === 'groupMembership' && val.key) {
        await view.del(val.key)
        await db.del(val.key).catch(() => {})
        // If this device locally has the group AND its identity is in the
        // removedMembers list, the sibling that authored this del was telling
        // us the group is no longer ours. Leave + delete locally so ghost
        // groups don't keep showing in the UI. We only act on kicked-state —
        // a sibling who voluntarily left a group they joined separately
        // shouldn't force us to leave a group we joined independently.
        const groupId = val.key.slice('personalGroups:'.length)
        if (groupId) {
          const localGroup = (await db.get(NS.groups + groupId).catch(() => null))?.value
          const profile = await getProfile().catch(() => null)
          const selfId = profile?.id
          const inRemoved = selfId && (localGroup?.removedMembers ?? []).some(m => (m.id ?? m) === selfId)
          if (localGroup && inRemoved) {
            await db.put('blockedFromGroup:' + groupId, { ts: Date.now() }).catch(() => {})
            await deleteGroup(groupId).catch(() => {})
            await leaveGroup(groupId).catch(() => {})
            send({ type: 'event', event: 'groupDeleted', data: groupId })
          }
        }
        // Full reload — a sibling left a group; UI's group list should refresh.
        emitSync(null, { fullReload: true })
        continue
      }
    }
  }
}

async function ensurePersonalBase () {
  if (personalBase) return personalBase
  if (!store || !db) return null
  const meta = await db.get('personalMeta:bootstrap').catch(() => null)
  if (!meta?.value?.key) return null
  const bootstrapHex = meta.value.key
  try {
    const personalStore = store.namespace('personal')
    const base = new Autobase(personalStore, b4a.from(bootstrapHex, 'hex'), {
      valueEncoding: 'json',
      open: (s) => new Hyperbee(s.get('view'), { keyEncoding: 'utf-8', valueEncoding: 'json' }),
      apply: makePersonalApply(),
      ackInterval: 1000,
    })
    // Without an 'error' listener Autobase calls crashSoon() on internal
    // failures (e.g., Hypercore "Truncation breaks prologue" during drain),
    // killing the bare runtime. The listener turns those into recoverable
    // events: the base closes itself, the runtime stays alive, the user
    // keeps their app session.
    base.on('error', e => console.error('[personal] base error:', e?.message))
    await base.ready()
    attachConflictListeners(base)
    personalBase = base
    await joinPersonalSwarm()
    console.log('[personal] opened base', bootstrapHex.slice(0, 16) + '…', 'writable=' + base.writable)
    // Backfill identity-scoped profile record for installs that enabled
    // personal sync before the identityProfile keyspace existed. Idempotent.
    seedIdentityProfileIfNeeded().catch(e => console.warn('[personal] identityProfile seed:', e.message))
    // deviceMeta seed (TODO #95) — deferred ~2.5s past open to dodge the
    // truncate-vs-prologue window noted in DECISIONS 2026-04-26 (the crash
    // only triggered on appends *immediately* after open, on already-paired
    // secondaries with un-indexed chain state). Idempotent + flag-guarded,
    // so a missed seed (timer never fired before runtime exit) just retries
    // on next boot. Pair-completion paths also call this directly as
    // belt-and-suspenders for fresh secondaries.
    setTimeout(() => {
      seedDeviceMetaIfNeeded().catch(e => console.warn('[personal] deviceMeta seed:', e.message))
    }, 2500)
    // Phase A: converge group-writer redundancy soon after the base opens so a
    // primary (already writable) publishes + cross-grants without waiting a full
    // realtime-tick interval. Deferred past the deviceMeta seed to stay clear of
    // the same post-open append race. No-op while still read-only (secondary).
    setTimeout(() => {
      runGroupWriterRedundancyTick().catch(e => console.warn('[xgrant] open sweep:', e.message))
    }, 3500)
    // Backup-integrity (TODO #11): consolidate sibling-authored events into the
    // primary's core shortly after open, so a re-paired device gets them without
    // waiting a full realtime-tick interval. No-op on non-primary / read-only.
    setTimeout(() => {
      runPersonalConsolidation(true).catch(e => console.warn('[consolidate] open sweep:', e.message))
    }, 4500)
    // Drop personal-base groupMembership entries pointing at groups this device
    // was kicked from or has locally deleted. Without this sweep, kicks that
    // landed before the live self-kick path existed (or during sync replay)
    // leave stale pointers that paired siblings auto-join into ghost groups.
    cleanupStalePersonalGroups().catch(e => console.warn('[personal] cleanup sweep:', e.message))
    // Self-heal any stale `deviceMetaHidden:{localKey}` marker — local writer
    // is never hidden in our model. Could exist on installs where a sibling's
    // remove was applied before the apply-skip-self fix landed.
    try {
      const localKey = base?.local?.key ? b4a.toString(base.local.key, 'hex') : null
      if (localKey) await db.del('deviceMetaHidden:' + localKey).catch(() => {})
    } catch (e) { console.warn('[personal] self-heal hidden marker:', e.message) }
    return base
  } catch (e) {
    console.error('[personal] open failed:', e.message)
    return null
  }
}

// IPC: user-initiated. Creates the personal base on first enable, runs the
// one-time migration of existing personal-scope data, and joins the swarm.
// Idempotent — second call is a no-op.
async function enablePersonalSync () {
  if (personalBase) return { enabled: true, writable: personalBase.writable, bootstrap: b4a.toString(personalBase.key, 'hex') }
  const existing = await db.get('personalMeta:bootstrap').catch(() => null)
  if (existing?.value?.key) {
    await ensurePersonalBase()
    return { enabled: true, writable: !!personalBase?.writable, bootstrap: existing.value.key }
  }
  // First-time enable on this install: mint a fresh Autobase.
  const personalStore = store.namespace('personal')
  const base = new Autobase(personalStore, null, {
    valueEncoding: 'json',
    open: (s) => new Hyperbee(s.get('view'), { keyEncoding: 'utf-8', valueEncoding: 'json' }),
    apply: makePersonalApply(),
    ackInterval: 1000,
  })
  base.on('error', e => console.error('[personal] base error:', e?.message))
  await base.ready()
  attachConflictListeners(base)
  const bootstrapHex = b4a.toString(base.key, 'hex')
  await db.put('personalMeta:bootstrap', { key: bootstrapHex, createdAt: Date.now() })
  personalBase = base
  await joinPersonalSwarm()
  await migratePersonalData().catch(e => console.warn('[personal] migration error:', e.message))
  console.log('[personal] created base', bootstrapHex.slice(0, 16) + '…')
  return { enabled: true, writable: base.writable, bootstrap: bootstrapHex }
}

async function getPersonalSyncStatus () {
  const meta = await db.get('personalMeta:bootstrap').catch(() => null)
  if (!meta?.value?.key) return { enabled: false }
  return {
    enabled: true,
    writable: !!personalBase?.writable,
    bootstrap: meta.value.key,
    migrated: !!(await db.get('personalMeta:migrated').catch(() => null))?.value,
  }
}

async function joinPersonalSwarm () {
  if (!personalBase || !swarm) return
  const keyHex = b4a.toString(personalBase.key, 'hex')
  const topic = b4a.from(keyHex.slice(0, 64).padEnd(64, '0'), 'hex')
  swarm.join(topic, { server: true, client: true })
  console.log('[personal] joined swarm topic', keyHex.slice(0, 16) + '…')
}

// Stream existing personal-scope records into the newly-created Autobase so
// siblings paired later see everything the user had before going multi-device.
// Idempotent — guarded by personalMeta:migrated. Skips events that live in any
// group (those are already in a group Autobase, not the personal base's scope).
async function migratePersonalData () {
  if (!personalBase || !personalBase.writable) return
  const already = await db.get('personalMeta:migrated').catch(() => null)
  if (already?.value) return
  let eventCount = 0, reminderCount = 0, noteCount = 0, groupCount = 0
  // Events
  for await (const { key, value } of db.createReadStream({ gt: NS.events, lt: NS.events + '\xff' })) {
    if (value?.groups && value.groups.length > 0) continue
    if (value?.isShadow) continue
    await safeAppend(personalBase, { op: 'put', type: 'event', key, value })
    eventCount++
  }
  // Deleted tombstones — each becomes a 'del event' op keyed by the tombstoned id
  for await (const { key, value } of db.createReadStream({ gt: NS.deleted, lt: NS.deleted + '\xff' })) {
    const eid = key.slice(NS.deleted.length)
    const date = value?.date
    if (!eid || !date) continue
    await safeAppend(personalBase, { op: 'del', type: 'event', key: NS.events + date + ':' + eid })
  }
  // Reminders
  for await (const { key, value } of db.createReadStream({ gt: 'reminders:', lt: 'reminders:\xff' })) {
    await safeAppend(personalBase, { op: 'put', type: 'reminders', key, value })
    reminderCount++
  }
  // Private notes
  for await (const { key, value } of db.createReadStream({ gt: NS.privateNotes, lt: NS.privateNotes + '\xff' })) {
    await safeAppend(personalBase, { op: 'put', type: 'note', key, value })
    noteCount++
  }
  // Group membership (one entry per group the user is currently in)
  for await (const { value } of db.createReadStream({ gt: NS.groups, lt: NS.groups + '\xff' })) {
    if (!value?.id || !value?.groupKey) continue
    await safeAppend(personalBase, { op: 'put', type: 'groupMembership', key: 'personalGroups:' + value.id, value: { groupId: value.id, groupKey: value.groupKey, joinedAt: value.joinedAt ?? Date.now() } })
    groupCount++
  }
  // Identity-scoped profile fields (name, avatar). Seed once so a sibling
  // paired later sees the current identity display even before the user edits.
  await seedIdentityProfileIfNeeded()
  await db.put('personalMeta:migrated', { ts: Date.now(), counts: { events: eventCount, reminders: reminderCount, notes: noteCount, groups: groupCount } })
  console.log('[personal] migration complete:', { eventCount, reminderCount, noteCount, groupCount })
}

// Additive, idempotent seed of the identity-scoped profile record. Runs every
// boot once personalBase is open. Guarded by personalMeta:identityProfileSeeded
// so installs that migrated pre-Task-2 still seed once. Skips if a sibling has
// already replicated an identityProfile into the view.
async function seedIdentityProfileIfNeeded () {
  if (!personalBase?.writable) return
  const already = await db.get('personalMeta:identityProfileSeeded').catch(() => null)
  if (already?.value) return
  // If a sibling device already authored an identityProfile, don't overwrite.
  const viewExisting = await personalBase.view.get('identityProfile').catch(() => null)
  if (viewExisting?.value) {
    await db.put('personalMeta:identityProfileSeeded', { ts: Date.now() })
    return
  }
  const prof = (await db.get(NS.profile).catch(() => null))?.value
  const name = prof?.name ?? ''
  const avatar = prof?.avatar ?? ''
  if (!name && !avatar) {
    // Nothing meaningful to seed yet — leave the flag unset so the next
    // updateProfile pass can be the first write (marks seeded implicitly).
    return
  }
  await personalBaseAppendIdentityProfile({
    name, avatar,
    updatedAt: prof?.updatedAt ?? prof?.createdAt ?? Date.now(),
  })
  await db.put('personalMeta:identityProfileSeeded', { ts: Date.now() })
}

// Append helpers — each no-ops if personal base isn't open or isn't writable.
// Callers (putEvent, putReminders, etc.) invoke these alongside their local DB
// write; the apply function mirrors back to local DB on other devices.

async function personalBaseAppendEvent (event) {
  if (!personalBase?.writable) return
  if (event.groups && event.groups.length > 0) return // group-scope, not personal
  const key = NS.events + event.date + ':' + event.id
  try { await safeAppend(personalBase, { op: 'put', type: 'event', key, value: event }) }
  catch (e) { console.warn('[personal] append event failed:', e.message) }
}

// Consolidation sweep (TODO #11 backup-integrity). Re-publishes personal-scope
// records that arrived from OTHER devices into THIS device's own writer core.
// Why: when a sibling device is wiped, its writer core is no longer fully
// re-served over the swarm, so a freshly-paired device can't reconstruct it and
// never sees that sibling's data — even though a surviving device still has it
// in its local mirror (verified 2026-06-03: a manual event re-save fixed it; an
// in-process Autobase harness could NOT reproduce it, confirming it's a
// real-swarm gone-writer-core delivery gap, not an Autobase-logic bug).
// Re-authoring from the local mirror into a live, reliably-replicated core
// sidesteps that.
//
// Covers events, reminders, private notes, AND deletions (event tombstones +
// note removals) — deletions must be re-published too, or a delete authored by
// a since-wiped device would let a previously-consolidated put resurrect on a
// freshly-paired device. Gated to the personal-base creator/primary
// (local.key === base.key) so the consolidated copy lives on the natural
// durable hub and storage stays bounded (one extra copy on the primary, not N
// across every device). Idempotent via cons:* markers; own-authored records are
// pre-marked in putEvent/putReminders/putPrivateNote so only sibling-originated
// versions get re-published.
let _lastConsolidationTs = 0
async function runPersonalConsolidation (force = false) {
  if (!personalBase?.writable) return
  if (!b4a.equals(personalBase.local.key, personalBase.key)) return // primary only
  // Throttle the full local-DB scan: the realtime tick fires every 15s but
  // consolidation only needs to chase newly-arrived sibling data, so cap it.
  const now = Date.now()
  if (!force && now - _lastConsolidationTs < 60000) return
  _lastConsolidationTs = now
  let n = 0
  const c = { ev: 0, del: 0, rem: 0, note: 0, noteDel: 0, notesSeen: 0 }

  // (1) Events — re-publish personal-scope event puts (LWW by updatedAt).
  for await (const { value: ev } of db.createReadStream({ gt: NS.events, lt: NS.events + '\xff' })) {
    if (!ev?.id || !ev?.date) continue
    if (ev.groups && ev.groups.length) continue // group-scope lives in group bases
    const marker = (await db.get('consolidated:' + ev.id).catch(() => null))?.value
    if ((marker?.updatedAt ?? -1) >= (ev.updatedAt ?? 0)) continue
    await personalBaseAppendEvent(ev).catch(() => {})
    await db.put('consolidated:' + ev.id, { updatedAt: ev.updatedAt ?? 0 }).catch(() => {})
    n++; c.ev++
  }

  // (2) Event tombstones — re-publish deletions so a deleted event can't
  // resurrect from a previously-consolidated put. Needs the date stored on the
  // tombstone (see the apply del branch); legacy date-less tombstones are skipped.
  for await (const { key, value: tomb } of db.createReadStream({ gt: NS.deleted, lt: NS.deleted + '\xff' })) {
    const id = key.slice(NS.deleted.length)
    if (!id || !tomb?.date) continue
    const mk = 'cons:del:' + id
    if ((await db.get(mk).catch(() => null))?.value) continue
    await personalBaseDeleteEvent(tomb.date, id).catch(() => {})
    await db.put(mk, { ts: tomb.ts ?? now }).catch(() => {})
    n++; c.del++
  }

  // (3) Reminders — no updatedAt on the value, so compare a serialized token.
  for await (const { key, value } of db.createReadStream({ gt: 'reminders:', lt: 'reminders:\xff' })) {
    const id = key.slice('reminders:'.length)
    if (!id) continue
    const token = JSON.stringify(value)
    const marker = (await db.get('cons:rem:' + id).catch(() => null))?.value
    if (marker?.token === token) continue
    await personalBaseAppendReminders(id, value).catch(() => {})
    await db.put('cons:rem:' + id, { token }).catch(() => {})
    n++; c.rem++
  }

  // (4) Private notes — re-publish puts (LWW by updatedAt) ...
  const liveNotes = new Set()
  for await (const { key, value } of db.createReadStream({ gt: NS.privateNotes, lt: NS.privateNotes + '\xff' })) {
    const id = key.slice(NS.privateNotes.length)
    if (!id) continue
    liveNotes.add(id); c.notesSeen++
    const marker = (await db.get('cons:note:' + id).catch(() => null))?.value
    if ((marker?.updatedAt ?? -1) >= (value?.updatedAt ?? 0)) continue
    await personalBaseAppendNote(id, value).catch(() => {})
    await db.put('cons:note:' + id, { updatedAt: value?.updatedAt ?? 0 }).catch(() => {})
    n++; c.note++
  }
  // ... and re-publish note removals: a cons:note marker with no live note means
  // a sibling deleted it; push the del so it doesn't resurrect, then drop marker.
  for await (const { key } of db.createReadStream({ gt: 'cons:note:', lt: 'cons:note:\xff' })) {
    const id = key.slice('cons:note:'.length)
    if (!id || liveNotes.has(id)) continue
    await personalBaseAppendNote(id, null).catch(() => {})
    await db.del('cons:note:' + id).catch(() => {})
    n++; c.noteDel++
  }

  if (n) console.log('[consolidate] re-published', n, 'record(s) ev=' + c.ev + ' del=' + c.del + ' rem=' + c.rem + ' note=' + c.note + ' noteDel=' + c.noteDel)
}

async function personalBaseDeleteEvent (date, eventId) {
  if (!personalBase?.writable) return
  const key = NS.events + date + ':' + eventId
  try { await safeAppend(personalBase, { op: 'del', type: 'event', key }) }
  catch (e) { console.warn('[personal] del event failed:', e.message) }
}

async function personalBaseAppendReminders (eventId, value) {
  if (!personalBase?.writable) return
  try { await safeAppend(personalBase, { op: 'put', type: 'reminders', key: 'reminders:' + eventId, value }) }
  catch (e) { console.warn('[personal] append reminders failed:', e.message) }
}

async function personalBaseAppendNote (eventId, value) {
  if (!personalBase?.writable) return
  const key = NS.privateNotes + eventId
  const op = value == null
    ? { op: 'del', type: 'note', key }
    : { op: 'put', type: 'note', key, value }
  try { await safeAppend(personalBase, op) }
  catch (e) { console.warn('[personal] append/del note failed:', e.message) }
}

async function personalBaseAddGroup (group) {
  if (!personalBase?.writable) return
  if (!group?.id || !group?.groupKey) return
  const key = 'personalGroups:' + group.id
  // Carry enough metadata for sibling devices to seed a placeholder group
  // record + auto-open the Autobase. Once the group's view replicates,
  // mirrorToLocal overwrites these placeholder fields with canonical values.
  const value = {
    groupId:  group.id,
    groupKey: group.groupKey,
    name:     group.name,
    color:    group.color,
    emoji:    group.emoji,
    icon:     group.icon,
    ownerId:  group.ownerId,
    joinedAt: group.joinedAt ?? Date.now(),
  }
  try { await safeAppend(personalBase, { op: 'put', type: 'groupMembership', key, value }) }
  catch (e) { console.warn('[personal] append group failed:', e.message) }
}

async function personalBaseRemoveGroup (groupId) {
  if (!personalBase?.writable) return
  try { await safeAppend(personalBase, { op: 'del', type: 'groupMembership', key: 'personalGroups:' + groupId }) }
  catch (e) { console.warn('[personal] del group failed:', e.message) }
}

// ── Multi-device group-writer redundancy (Phase A) ───────────────────────────
// Publishes THIS device's per-group Autobase writer key into the personal base
// so sibling devices (same identity = same mnemonic) that are already writers
// on the group can grant it write access. Makes linked devices functional write
// backups and lets one of the user's own devices re-authorize a wiped sibling
// without an external group member coming online. Keyed by the device's
// personal writer key so siblings never overwrite each other's rows. No-op
// until the personal base is writable; re-published by the periodic sweep once
// it is. Idempotent — skips when the published key is already current.
async function personalBaseAddGroupWriter (groupId, groupWriterKey) {
  if (!personalBase?.writable) return
  if (!groupId || !groupWriterKey) return
  const personalWriterKey = b4a.toString(personalBase.local.key, 'hex')
  const key = 'deviceGroupWriter:' + groupId + ':' + personalWriterKey
  const prev = (await db.get(key).catch(() => null))?.value
  if (prev && prev.groupWriterKey === groupWriterKey) return
  const value = { groupId, groupWriterKey, personalWriterKey, updatedAt: Date.now() }
  try { await safeAppend(personalBase, { op: 'put', type: 'deviceGroupWriter', key, value }) }
  catch (e) { console.warn('[personal] append deviceGroupWriter failed:', e.message) }
}

// Drop this device's group-writer advertisement when it leaves/loses a group.
async function personalBaseRemoveGroupWriter (groupId) {
  if (!personalBase?.writable) return
  const personalWriterKey = b4a.toString(personalBase.local.key, 'hex')
  const key = 'deviceGroupWriter:' + groupId + ':' + personalWriterKey
  try { await safeAppend(personalBase, { op: 'del', type: 'deviceGroupWriter', key }) }
  catch (e) { console.warn('[personal] del deviceGroupWriter failed:', e.message) }
}

// Grant a sibling device's per-group writer key write access on the group's
// Autobase. Safe without an extra identity proof: the sibling key was read from
// OUR personal base, which only our own devices can write to (apply gate). Still
// honors kick state — never re-grants a blocked writer or a group we were
// kicked from — and is idempotent via the durable knownWriter index.
async function maybeCrossGrantGroupWriter (groupId, groupWriterKey, siblingPersonalKey) {
  if (!groupId || !groupWriterKey) return
  const myPersonalKey = personalBase?.local?.key
    ? b4a.toString(personalBase.local.key, 'hex') : null
  // Our own row is granted via the normal owner / writer-announce path.
  if (siblingPersonalKey && myPersonalKey && siblingPersonalKey === myPersonalKey) return
  const base = bases.get(groupId)
  if (!base) return            // group not open on this device
  if (!base.writable) return   // we're not a writer here — can't grant anyone
  const blockedFromGroup = await db.get('blockedFromGroup:' + groupId).catch(() => null)
  if (blockedFromGroup?.value) return
  const blockedWriter = await db.get('blockedWriter:' + groupId + ':' + groupWriterKey).catch(() => null)
  if (blockedWriter?.value) return
  const knownKey = 'knownWriter:' + groupId + ':' + groupWriterKey
  const already = await db.get(knownKey).catch(() => null)
  if (already?.value) return
  try {
    if (!(await safeAppend(base, { addWriter: groupWriterKey }))) return
    await db.put(knownKey, { ts: Date.now() }).catch(() => {})
    console.log('[xgrant] granted sibling writer', groupWriterKey.slice(0, 16) + '…', 'on group', groupId)
  } catch (e) {
    console.warn('[xgrant] addWriter failed for', groupId, e?.message)
  }
}

// Periodic convergence sweep. (1) Re-publishes this device's open group writer
// keys — covers a freshly-paired secondary whose personal base wasn't writable
// when joinGroup ran and became writable later. (2) Cross-grants every sibling's
// advertised writer key on the groups we're a writer of. Piggybacks the existing
// realtime sync tick so there's no extra timer.
async function runGroupWriterRedundancyTick () {
  if (!personalBase?.writable) return
  for (const [groupId, base] of bases) {
    const gw = base?.local?.key ? b4a.toString(base.local.key, 'hex') : null
    if (gw) await personalBaseAddGroupWriter(groupId, gw).catch(() => {})
  }
  for await (const { value } of db.createReadStream({
    gt: 'deviceGroupWriter:', lt: 'deviceGroupWriter:\xff'
  })) {
    if (!value?.groupId || !value?.groupWriterKey) continue
    await maybeCrossGrantGroupWriter(value.groupId, value.groupWriterKey, value.personalWriterKey)
      .catch(() => {})
  }
}

// Drop stale personalGroups pointers (groups this device was kicked from or
// has locally deleted) so paired siblings don't auto-join into ghost groups.
// Runs on every personal-base open; only acts when this device is writable, so
// the entry is appended via this device's writer key. Idempotent — re-running
// is cheap because the iteration short-circuits when nothing matches.
async function cleanupStalePersonalGroups () {
  if (!personalBase?.writable) return
  let dropped = 0
  for await (const { value } of personalBase.view.createReadStream({
    gt: 'personalGroups:', lt: 'personalGroups:\xff'
  })) {
    const groupId = value?.groupId
    if (!groupId) continue
    const blocked    = await db.get('blockedFromGroup:'  + groupId).catch(() => null)
    const localGroup = await db.get(NS.groups            + groupId).catch(() => null)
    const seen       = await db.get('personalSeenGroup:' + groupId).catch(() => null)

    // Definitely-stale: this device was explicitly kicked from the group.
    // Probably-locally-deleted: we previously had the group locally (marker
    // stamped by personal-base apply) and now don't. Without the marker we
    // MUST NOT delete — a freshly-paired secondary mid-replication would see
    // personalGroups entries arrive ahead of the group autobases, and a naive
    // "no local group" check would sweep every entry, replicating del ops to
    // siblings and orphaning the entire identity from every group.
    const definitelyStale       = !!blocked?.value
    const probablyLocallyDeleted = !!seen?.value && !localGroup?.value
    if (definitelyStale || probablyLocallyDeleted) {
      await personalBaseRemoveGroup(groupId)
      // Phase A: also retract this device's group-writer advertisement so
      // siblings stop trying to cross-grant a group we've left/been kicked from.
      await personalBaseRemoveGroupWriter(groupId).catch(() => {})
      dropped++
    }
  }
  if (dropped) console.log('[personal] cleanup swept', dropped, 'stale personalGroups')
}

// Replicate identity-scoped profile fields (name, avatar) to sibling devices.
// Writer keypair stays per-device; only display fields sync.
async function personalBaseAppendIdentityProfile ({ name, avatar, updatedAt }) {
  if (!personalBase?.writable) return
  try {
    await safeAppend(personalBase, {
      op: 'put', type: 'identityProfile', key: 'identityProfile',
      value: { name: name ?? '', avatar: avatar ?? '', updatedAt: updatedAt ?? Date.now() }
    })
  } catch (e) { console.warn('[personal] append identityProfile failed:', e.message) }
}

// Idempotent one-shot seed of the local device's deviceMeta row. The
// 2026-04-26 decision dropped the original boot-seed because appending
// immediately after personalBase open could race the truncate-vs-prologue
// window on already-paired secondaries with un-indexed chain state. We
// reintroduce the seed on a deferred timer + at pair-completion (well past
// that race window) so peers see the new device's platform label without
// waiting for the user to manually rename it. Mirrors
// seedIdentityProfileIfNeeded — guarded by a local-only flag, skips if a
// deviceMeta row already exists for this writer (idempotent across reboots).
async function seedDeviceMetaIfNeeded () {
  if (!personalBase?.writable) return
  const localKey = b4a.toString(personalBase.local.key, 'hex')
  const flagKey = 'personalMeta:deviceMetaSeeded:' + localKey
  const flag = await db.get(flagKey).catch(() => null)
  if (flag?.value) return
  const existing = await db.get('deviceMeta:' + localKey).catch(() => null)
  if (existing?.value) {
    // Row already populated (prior install seeded, or a sibling's apply branch
    // mirrored back). Stamp the flag so we don't re-check on every boot.
    await db.put(flagKey, { ts: Date.now() }).catch(() => {})
    return
  }
  // personalBaseAppendDeviceMeta with empty patch creates a fresh row using
  // the current `_platform` (set at init) and an empty nickname — the
  // user-rename path overwrites those later via setDeviceNickname.
  await personalBaseAppendDeviceMeta({})
  await db.put(flagKey, { ts: Date.now() }).catch(() => {})
}

// Per-device row in the linked-devices list (TODO #95). Self-write only:
// caller is always writing for the local writer key. Apply gate enforces this
// even if a misbehaving peer tries to write someone else's row.
async function personalBaseAppendDeviceMeta (patch) {
  if (!personalBase?.writable) return
  const writerKey = b4a.toString(personalBase.local.key, 'hex')
  const key = 'deviceMeta:' + writerKey
  const prev = (await db.get(key).catch(() => null))?.value ?? null
  const value = {
    writerKey,
    nickname: typeof patch?.nickname === 'string' ? patch.nickname : (prev?.nickname ?? ''),
    platform: patch?.platform ?? prev?.platform ?? _platform ?? '',
    pairedAt: prev?.pairedAt ?? patch?.pairedAt ?? Date.now(),
    updatedAt: Date.now(),
  }
  try {
    await safeAppend(personalBase, { op: 'put', type: 'deviceMeta', key, value })
  } catch (e) { console.warn('[personal] append deviceMeta failed:', e.message) }
}

// IPC: list every paired device known on this install. Reads the local-DB
// mirror (populated by the apply branch), then synthesises placeholder rows
// for any personal-base writer without a deviceMeta entry yet — covers the
// just-paired secondary that hasn't called setDeviceNickname (per DECISIONS
// 2026-04-26 the boot-seed was dropped to dodge an Autobase truncate bug).
// Skips writers whose deviceMetaHidden:{key} marker is set (cosmetic remove
// via removeDeviceFromList — see proposal 2026-04-27-devices-list-ux.md).
async function listLinkedDevices () {
  if (!db) return []
  const localKey = personalBase?.local?.key ? b4a.toString(personalBase.local.key, 'hex') : null
  const seen = new Set()
  const out = []

  async function isHidden (writerKey) {
    // Local writer is never hidden — defensive guard against a stale marker
    // landing on this device (e.g., from a sibling's remove that this device
    // applied before the apply-skip-self fix). Also the apply branch refuses
    // to write a hidden marker for the local writer, so this is belt-and-
    // suspenders.
    if (localKey && writerKey === localKey) return false
    const m = await db.get('deviceMetaHidden:' + writerKey).catch(() => null)
    return !!m?.value
  }

  for await (const { value } of db.createReadStream({ gt: 'deviceMeta:', lt: 'deviceMeta:ÿ' })) {
    if (!value || !value.writerKey) continue
    if (await isHidden(value.writerKey)) continue
    seen.add(value.writerKey)
    out.push({
      writerKey: value.writerKey,
      nickname: value.nickname ?? '',
      platform: value.platform ?? '',
      pairedAt: value.pairedAt ?? null,
      updatedAt: value.updatedAt ?? null,
      isThisDevice: !!localKey && value.writerKey === localKey,
    })
  }

  // Synthesise rows from pairedWriter:{key} markers — written by the primary
  // when it grants addWriter during pairing. Authoritative on the primary
  // immediately at handshake time, regardless of whether the secondary's
  // hypercore has connected yet. Other devices receive the new writer via
  // the activeWriters fallback below as Autobase replicates the addWriter op.
  for await (const { key, value } of db.createReadStream({ gt: 'pairedWriter:', lt: 'pairedWriter:ÿ' })) {
    const keyHex = key.slice('pairedWriter:'.length)
    if (!keyHex || seen.has(keyHex)) continue
    if (await isHidden(keyHex)) continue
    seen.add(keyHex)
    out.push({
      writerKey: keyHex,
      nickname: '',
      platform: '',
      pairedAt: value?.addedAt ?? null,
      updatedAt: null,
      isThisDevice: !!localKey && keyHex === localKey,
      synthetic: true,
    })
  }

  // Synthesise rows for active writers that haven't authored a deviceMeta yet
  // (and weren't covered by the pairedWriter loop above). Catches sibling
  // devices on installs that paired before the pairedWriter marker existed,
  // and on already-paired siblings where the new writer arrives via the
  // addWriter op replication rather than a local pair handshake.
  const writers = personalBase?.activeWriters || personalBase?.writers || []
  for (const w of writers) {
    const k = w?.core?.key
    if (!k) continue
    const keyHex = b4a.toString(k, 'hex')
    if (seen.has(keyHex)) continue
    if (await isHidden(keyHex)) continue
    seen.add(keyHex)
    out.push({
      writerKey: keyHex,
      nickname: '',
      platform: '',
      pairedAt: null,
      updatedAt: null,
      isThisDevice: !!localKey && keyHex === localKey,
      synthetic: true,
    })
  }

  // Belt-and-suspenders: if personalBase isn't open yet (rare boot race) but
  // we have a local writer key, ensure the UI still shows "This device".
  if (localKey && !seen.has(localKey) && !(await isHidden(localKey))) {
    out.push({
      writerKey: localKey,
      nickname: '',
      platform: _platform ?? '',
      pairedAt: null,
      updatedAt: null,
      isThisDevice: true,
      synthetic: true,
    })
  }

  // This device first; remaining devices oldest-paired first (synthetics with
  // null pairedAt sort to the start of the remaining list, then real rows).
  out.sort((a, b) => {
    if (a.isThisDevice && !b.isThisDevice) return -1
    if (!a.isThisDevice && b.isThisDevice) return 1
    return (a.pairedAt ?? 0) - (b.pairedAt ?? 0)
  })
  return out
}

// IPC: cosmetic removal of a paired device's row from every device's list.
// Appends `{ op: 'del', type: 'deviceMeta' }` to the personal Autobase. Apply
// removes the local row AND stamps `deviceMetaHidden:{key}` so the synthesise-
// from-activeWriters path doesn't resurrect it. Self-remove blocked. Does NOT
// revoke writer access — TODO #95 v2 covers true revocation.
async function removeDeviceFromList (writerKey) {
  if (!personalBase?.writable) return { ok: false, reason: 'not_writable' }
  if (typeof writerKey !== 'string' || !/^[0-9a-f]{64}$/i.test(writerKey)) {
    return { ok: false, reason: 'bad_writer_key' }
  }
  const localKey = personalBase?.local?.key ? b4a.toString(personalBase.local.key, 'hex') : null
  if (writerKey === localKey) return { ok: false, reason: 'cannot_remove_self' }
  try {
    await safeAppend(personalBase, { op: 'del', type: 'deviceMeta', key: 'deviceMeta:' + writerKey })
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: e.message }
  }
}

// IPC: rename the local device. Trims whitespace, caps at 32 chars, allows
// empty (revert to platform-default label in the UI). Only ever writes the
// local writer's row — a benign shim against UI bugs; the apply gate is the
// real authority.
async function setDeviceNickname (nickname) {
  if (!personalBase?.writable) throw new Error('personal base not writable')
  const trimmed = typeof nickname === 'string' ? nickname.trim().slice(0, 32) : ''
  await personalBaseAppendDeviceMeta({ nickname: trimmed })
  return { nickname: trimmed }
}

async function closePersonalBase () {
  if (personalBase) {
    try { await personalBase.close() } catch (e) { console.warn('[personal] close error:', e.message) }
    personalBase = null
  }
}

// ── Device-pair protocol (TODO #11 Phase 4, PR #B) ───────────────────────────
// Two-device onboarding under a single identity. Primary device generates a
// transient Hyperswarm topic + one-shot handshake token, displays the URL as a
// QR / shareable text (UI in PR #C). Secondary device redeems the URL via
// consumePairLink, handshakes over the `pearcal/device-pair` Protomux channel,
// receives the mnemonic + personalBaseKey + group list in one round-trip, then
// sends its personal-base writerKey back so the primary can addWriter it.
//
// Per-group writerKeys stay on the writer-announce path (bare.js:~4243) — the
// primary can't pre-grant them from the pair handshake because corestore
// namespaces mint a distinct local writer key per group / per device.
//
// Single-use: handshake is consumed on first valid hello. 15-min expiry.
const PAIR_EXPIRY_MS    = 15 * 60 * 1000
// Phase B: how long the primary keeps the pair session alive after `complete`
// to receive + grant the secondary's per-group writer keys, and how long the
// secondary waits for the ack before giving up (falls back to Phase A / C).
const GROUP_WRITERS_WAIT_MS = 15 * 1000
const PAIR_CHANNEL_PROTO = 'pearcal/device-pair'
const PAIR_CHANNEL_ID    = Buffer.from('pearcal-device-pair-v1')
let _pairSession = null
// Live device-pair message channels (pairMsg), one per open connection, for
// nudging the pairing `hello` over a REUSED connection (TODO #113).
const _pairChannels = new Set()

// Send the pairing `hello` over every currently-open device-pair channel. The
// per-connection channel's onopen fires once, at connection-establishment time,
// so a secondary whose connection to the primary already existed (e.g. a shared
// group) had no _pairSession when its channel opened and so never sent hello -
// the pair then stalled until an unrelated reconnect. consumePairLink calls
// this right after arming the session so the hello still goes out over the
// reused connection. Idempotent (the primary handshake-gates a duplicate hello);
// no-op unless we are a secondary mid-pair.
function broadcastPairHello () {
  if (!(_pairSession && _pairSession.role === 'secondary' && !_pairSession.granted)) return
  const hello = Buffer.from(JSON.stringify({
    type: 'hello',
    handshake: _pairSession.handshakeHex,
    challenge: _pairSession.challengeHex,
  }))
  for (const pm of _pairChannels) { try { pm.send(hello) } catch (e) { /* channel closing */ } }
}

// Pair URL helpers inlined here so bare.js can build/parse without requiring
// src/invite.js — that file uses ES `export` syntax for the UI side and can't
// be loaded via CommonJS `require()` from the bare runtime.
function _buildPairLink ({ topic, handshake, identity, expiresMs }) {
  return 'pearcal://pair?topic=' + topic
    + '&handshake=' + handshake
    + '&identity=' + identity
    + '&expires=' + expiresMs
}
function _parsePairLink (url) {
  if (typeof url !== 'string') return { ok: false, error: 'invalid_url' }
  const normalised = url.replace(/^pear:\/\/pearcal\/pair/, 'pearcal://pair')
  const m = normalised.match(/^pearcal:\/\/pair\?(.*)$/)
  if (!m) return { ok: false, error: 'wrong_scheme' }
  const params = {}
  for (const pair of m[1].split('&')) {
    const eq = pair.indexOf('=')
    if (eq < 0) continue
    params[decodeURIComponent(pair.slice(0, eq))] = decodeURIComponent(pair.slice(eq + 1))
  }
  const { topic, handshake, identity, expires } = params
  if (!topic || !handshake || !identity || !expires) return { ok: false, error: 'missing_params' }
  const hex64 = /^[0-9a-f]{64}$/i
  if (!hex64.test(topic))     return { ok: false, error: 'invalid_topic' }
  if (!hex64.test(handshake)) return { ok: false, error: 'invalid_handshake' }
  if (!hex64.test(identity))  return { ok: false, error: 'invalid_identity' }
  const expiresMs = Number(expires)
  if (!Number.isFinite(expiresMs) || expiresMs <= 0) return { ok: false, error: 'invalid_expires' }
  return { ok: true, topic, handshake, identity, expiresMs }
}

function _hex32 () {
  const b = b4a.alloc(32); sodium.randombytes_buf(b); return b4a.toString(b, 'hex')
}

function _clearPairSession () {
  if (!_pairSession) return
  if (_pairSession.expiryTimer) clearTimeout(_pairSession.expiryTimer)
  if (_pairSession.groupWritersTimer) clearTimeout(_pairSession.groupWritersTimer)
  const topic = _pairSession.topicBuf
  _pairSession = null
  if (topic && swarm) swarm.leave(topic).catch(() => {})
}

function _emitPair (event, data) {
  send({ type: 'event', event, data })
}

// Primary: mint topic+handshake, join the transient swarm, return the URL for
// the UI to encode as QR / share sheet (UI layer not in PR #B). Must be called
// after enablePersonalSync — the secondary needs a personalBaseKey to receive.
async function startPairing () {
  if (_pairSession) {
    if (_pairSession.role === 'primary') return _pairSessionSnapshot()
    throw new Error('startPairing: another pair session in progress (role=' + _pairSession.role + ')')
  }
  if (!swarm) throw new Error('startPairing: swarm not ready')
  await ensureIdentity()
  const personalMeta = await db.get('personalMeta:bootstrap').catch(() => null)
  if (!personalMeta?.value?.key) {
    throw new Error('startPairing: personal sync not enabled (call enablePersonalSync first)')
  }
  const topicHex     = _hex32()
  const handshakeHex = _hex32()
  const identityHex  = b4a.toString(_identity.identityPublicKey, 'hex')
  const expiresAt    = Date.now() + PAIR_EXPIRY_MS
  const topicBuf     = b4a.from(topicHex, 'hex')

  _pairSession = {
    role: 'primary',
    topicHex, handshakeHex, identityHex, expiresAt, topicBuf,
    personalBaseKey: personalMeta.value.key,
    expiryTimer: setTimeout(() => {
      if (_pairSession?.handshakeHex === handshakeHex) {
        console.log('[pair] session expired')
        _emitPair('pairingExpired', { handshake: handshakeHex })
        _clearPairSession()
      }
    }, PAIR_EXPIRY_MS),
  }

  try { swarm.join(topicBuf, { server: true, client: true }) }
  catch (e) {
    _clearPairSession()
    throw e
  }
  _emitPair('pairingStarted', _pairSessionSnapshot())
  return _pairSessionSnapshot()
}

function _pairSessionSnapshot () {
  if (!_pairSession) return { active: false }
  const { role, topicHex, handshakeHex, identityHex, expiresAt } = _pairSession
  const url = role === 'primary'
    ? _buildPairLink({ topic: topicHex, handshake: handshakeHex, identity: identityHex, expiresMs: expiresAt })
    : null
  return { active: true, role, url, expiresAt }
}

async function cancelPairing () {
  if (!_pairSession) return { active: false }
  const snap = { active: false, role: _pairSession.role }
  _clearPairSession()
  return snap
}

function getPairingStatus () { return _pairSessionSnapshot() }

// Secondary: called with the raw `pearcal://pair` URL. Validates, joins the
// pair swarm topic, and waits for the primary's `granted` reply to install the
// mnemonic + open the personal base. Returns when `complete` arrives from the
// primary (pair fully done) or rejects on expiry / mismatch / verify failure.
async function consumePairLink (url) {
  if (_pairSession) throw new Error('consumePairLink: another pair session in progress')
  if (!swarm) throw new Error('consumePairLink: swarm not ready')
  const parsed = _parsePairLink(url)
  if (!parsed.ok) throw new Error('consumePairLink: ' + parsed.error)
  const { topic, handshake, identity, expiresMs } = parsed
  if (Date.now() >= expiresMs) throw new Error('consumePairLink: link expired')

  const topicBuf = b4a.from(topic, 'hex')
  const challengeHex = _hex32()
  const completionPromise = new Promise((resolve, reject) => {
    _pairSession = {
      role: 'secondary',
      topicHex: topic, handshakeHex: handshake, identityHex: identity,
      expiresAt: expiresMs, topicBuf, challengeHex,
      groupsReceived: null,
      resolve, reject,
      expiryTimer: setTimeout(() => {
        if (_pairSession?.handshakeHex === handshake) {
          const err = new Error('pair_expired')
          _emitPair('pairingFailed', { reason: 'expired', handshake })
          reject(err)
          _clearPairSession()
        }
      }, Math.max(0, expiresMs - Date.now())),
    }
  })

  try { swarm.join(topicBuf, { server: true, client: true }) }
  catch (e) {
    _clearPairSession()
    throw e
  }
  _emitPair('pairingStarted', _pairSessionSnapshot())
  // Nudge the hello over any connection to the primary we ALREADY had open
  // (reused connection); the fresh-connection path is covered by onopen (#113).
  broadcastPairHello()
  return completionPromise
}

// Primary: handle hello from secondary. Verifies handshake, signs the
// secondary's challenge with our identityKeyPair so the secondary can verify
// we're the expected identity, and replies with the mnemonic + personal base
// key + group list in one message.
async function _handlePairHello (parsed, replySend) {
  if (_pairSession?.role !== 'primary') return
  if (parsed.handshake !== _pairSession.handshakeHex) {
    console.warn('[pair] hello with wrong handshake, dropping')
    return
  }
  if (Date.now() >= _pairSession.expiresAt) {
    _emitPair('pairingExpired', { handshake: _pairSession.handshakeHex })
    _clearPairSession()
    return
  }
  if (_pairSession.handshakeConsumed) {
    console.warn('[pair] handshake already consumed, dropping duplicate hello')
    return
  }
  _pairSession.handshakeConsumed = true

  try {
    const mnemonic = await nativeRequest('getMnemonic')
    if (!mnemonic) throw new Error('no mnemonic on primary')

    await ensureIdentity()
    const challengeBuf = b4a.from(parsed.challenge, 'hex')
    const sig = b4a.alloc(sodium.crypto_sign_BYTES)
    sodium.crypto_sign_detached(sig, challengeBuf, _identity.identityKeyPair.secretKey)

    const myProfile = await getProfile().catch(() => null)
    const myIdentityHex = b4a.toString(_identity.identityPublicKey, 'hex')
    const groups = []
    for await (const { value } of db.createReadStream({ gt: NS.groups, lt: NS.groups + 'ÿ' })) {
      if (!value?.id || !value?.groupKey) continue
      // Only share groups the primary actually belongs to (skip migrated or
      // forgotten groups). Conservative: require the primary's identity or
      // profile.id to appear in members[].
      const members = value.members ?? []
      const mine = members.some(m =>
        (m.identityPublicKey && m.identityPublicKey === myIdentityHex)
        || (myProfile?.id && m.id === myProfile.id)
      )
      if (!mine) continue
      groups.push({
        id:        value.id,
        name:      value.name,
        groupKey:  value.groupKey,
        ownerId:   value.ownerId,
        color:     value.color,
        emoji:     value.emoji,
        icon:      value.icon,
        joinedAt:  value.joinedAt ?? Date.now(),
      })
    }

    // Snapshot of every sibling's deviceMeta — written straight to the
    // secondary's local DB on receipt so the linked-devices list shows
    // platform labels immediately, without waiting for hypercore replication
    // of each writer's chain to dial through Hyperswarm. Without this, late-
    // paired secondaries see "Unnamed device" for every sibling that hasn't
    // recently appended a block (each device's hypercore is fetched lazily
    // when its peer connects, which can take indefinitely on partial swarm
    // topologies).
    const siblings = []
    for await (const { value } of db.createReadStream({ gt: 'deviceMeta:', lt: 'deviceMeta:ÿ' })) {
      if (!value?.writerKey) continue
      siblings.push({
        writerKey: value.writerKey,
        nickname:  value.nickname  ?? '',
        platform:  value.platform  ?? '',
        pairedAt:  value.pairedAt  ?? null,
        updatedAt: value.updatedAt ?? null,
      })
    }

    const granted = {
      type: 'granted',
      mnemonic,
      personalBaseKey: _pairSession.personalBaseKey,
      identitySignature: b4a.toString(sig, 'hex'),
      identityPublicKey: myIdentityHex,
      groups,
      siblings,
    }
    replySend(granted)
    console.log('[pair] granted sent: groups=' + groups.length + ' siblings=' + siblings.length)
  } catch (e) {
    console.error('[pair] hello handler error:', e.message)
    _emitPair('pairingFailed', { reason: 'primary_grant_error', message: e.message })
    _clearPairSession()
  }
}

// Secondary: handle granted from primary. Verifies the identity signature,
// persists the mnemonic, re-derives identity, seeds personalMeta:bootstrap,
// opens the personal base, and replies with this device's personal writer key.
async function _handlePairGranted (parsed, replySend) {
  if (_pairSession?.role !== 'secondary') return
  if (_pairSession.granted) return
  if (Date.now() >= _pairSession.expiresAt) {
    const err = new Error('pair_expired')
    _pairSession.reject?.(err)
    _emitPair('pairingFailed', { reason: 'expired' })
    _clearPairSession()
    return
  }
  try {
    if (parsed.identityPublicKey !== _pairSession.identityHex) {
      throw new Error('identity mismatch vs URL')
    }
    const sig = b4a.from(parsed.identitySignature, 'hex')
    const challenge = b4a.from(_pairSession.challengeHex, 'hex')
    const pk = b4a.from(_pairSession.identityHex, 'hex')
    if (sig.length !== sodium.crypto_sign_BYTES || pk.length !== sodium.crypto_sign_PUBLICKEYBYTES) {
      throw new Error('signature shape')
    }
    if (!sodium.crypto_sign_verify_detached(sig, challenge, pk)) {
      throw new Error('signature verify failed')
    }

    // Persist mnemonic + re-derive identity so profile.id matches across devices.
    await nativeRequest('setMnemonic', [parsed.mnemonic])
    _identity = null
    _writerProofs.clear()
    await ensureIdentity()
    const idHex  = b4a.toString(_identity.identityPublicKey, 'hex')
    const newId  = deriveProfileIdFromIdentity(_identity.identityPublicKey)
    const existing = await db.get(NS.profile).catch(() => null)
    if (existing?.value) {
      // Mirror the restoreMnemonic guard: refuse if local groups exist under
      // a different id — would orphan invitee/RSVP references. Fresh pair
      // (canonical flow) has no groups so this passes.
      let hasGroups = false
      for await (const _ of db.createReadStream({ gt: NS.groups, lt: NS.groups + 'ÿ', limit: 1 })) {
        hasGroups = true; break
      }
      if (hasGroups && existing.value.id !== newId) {
        throw new Error('local groups exist under a different id; wipe before pairing')
      }
      await db.put(NS.profile, {
        ...existing.value,
        id: newId,
        identityPublicKey: idHex,
        updatedAt: Date.now(),
      })
    }

    // Seed personal-base bootstrap to the primary's key, mark migration done
    // (no data to migrate — secondary is fresh), open the base, join the swarm.
    await db.put('personalMeta:bootstrap', {
      key: parsed.personalBaseKey,
      createdAt: Date.now(),
      adoptedFromPair: true,
    })
    await db.put('personalMeta:migrated', { ts: Date.now(), counts: { events: 0, reminders: 0, notes: 0, groups: 0 }, skipped: 'secondary_pair' })
    await ensurePersonalBase()
    if (!personalBase) {
      // Roll back persisted bootstrap so the secondary doesn't boot into a
      // half-paired state on next launch (bootstrap set, base read-only because
      // primary never granted addWriter — every user write would silently
      // no-op via the personalBase*Append* writable guards). User can cleanly
      // retry pair after the rollback.
      await db.del('personalMeta:bootstrap').catch(() => {})
      await db.del('personalMeta:migrated').catch(() => {})
      throw new Error('personal base did not open')
    }

    const newDeviceKey = b4a.toString(personalBase.local.key, 'hex')
    _pairSession.granted = true
    _pairSession.groupsReceived = parsed.groups ?? []
    // Eager-write the siblings snapshot to local DB so the linked-devices
    // list shows the cohort immediately, without waiting for each writer's
    // hypercore to finish replicating. Apply branch's last-writer-wins guard
    // (incomingTs >= prevTs) keeps these in sync if a real apply lands later.
    const incomingSiblings = Array.isArray(parsed.siblings) ? parsed.siblings : []
    let siblingsWritten = 0
    for (const s of incomingSiblings) {
      if (!s?.writerKey || s.writerKey === newDeviceKey) continue
      const key = 'deviceMeta:' + s.writerKey
      const prev = (await db.get(key).catch(() => null))?.value
      if (prev && (prev.updatedAt ?? 0) >= (s.updatedAt ?? 0)) continue
      await db.put(key, s).catch(() => {})
      await db.del('deviceMetaHidden:' + s.writerKey).catch(() => {})
      siblingsWritten++
    }
    console.log('[pair] siblings received=' + incomingSiblings.length + ' written=' + siblingsWritten)
    if (siblingsWritten > 0) {
      send({ type: 'event', event: 'linkedDevicesChanged', data: null })
    }
    // Persist the group list so a crash between `granted` and `complete` leaves
    // the secondary with enough data to recover on next boot via
    // resumePendingPair(). Cleared in _handlePairComplete.
    await db.put('personalMeta:pendingGroups', {
      groups: _pairSession.groupsReceived,
      ts: Date.now(),
    }).catch(() => {})
    replySend({ type: 'personalWriter', newDeviceKey })
    console.log('[pair] granted processed; personalWriter sent')
  } catch (e) {
    console.error('[pair] granted handler error:', e.message)
    _pairSession?.reject?.(e)
    _emitPair('pairingFailed', { reason: 'secondary_grant_error', message: e.message })
    _clearPairSession()
  }
}

// Primary: handle secondary's personalWriter. Grants addWriter on the personal
// base and sends complete. Group addWriters flow via the existing
// writer-announce admission path once the secondary joins each group's swarm.
async function _handlePairPersonalWriter (parsed, replySend) {
  if (_pairSession?.role !== 'primary') return
  if (!_pairSession.handshakeConsumed) return
  const newDeviceKey = parsed.newDeviceKey
  if (!/^[0-9a-f]{64}$/i.test(newDeviceKey ?? '')) {
    console.warn('[pair] personalWriter: invalid newDeviceKey')
    return
  }
  try {
    if (!personalBase) {
      const opened = await ensurePersonalBase()
      if (!opened) throw new Error('personal base not open on primary')
    }
    if (!personalBase.writable) throw new Error('personal base not writable on primary')
    await safeAppend(personalBase, { addWriter: newDeviceKey })
    console.log('[pair] addWriter on personal base:', newDeviceKey.slice(0, 16) + '…')
    // Local marker so listLinkedDevices can synthesise the new device's row
    // immediately, without waiting for the secondary's hypercore to open
    // (personalBase.activeWriters only populates `w.core` once a peer with
    // that writerKey actually connects — which can lag the addWriter append
    // by an arbitrary amount on the primary side).
    await db.put('pairedWriter:' + newDeviceKey, { addedAt: Date.now() }).catch(() => {})
    // Belt-and-suspenders: ensure the primary's own deviceMeta row exists so
    // the freshly-paired secondary sees this device by its platform label
    // (e.g. "Linux") rather than "Unnamed device" while the user hasn't
    // explicitly named it yet. No-op if already seeded.
    seedDeviceMetaIfNeeded().catch(e => console.warn('[pair] primary deviceMeta seed:', e.message))
    replySend({ type: 'complete' })
    _emitPair('pairingCompleted', { role: 'primary' })
    send({ type: 'event', event: 'linkedDevicesChanged', data: null })
    // Phase B: pairing is functionally done, but keep the session briefly to
    // receive the secondary's per-group writer keys and grant them immediately
    // (deterministic fan-out). If the message never arrives — secondary on an
    // older build, dropped connection, crash — Phase A cross-grant and the
    // writer-announce path still authorize the device, so this is best-effort.
    if (_pairSession) {
      const sess = _pairSession
      sess.phase = 'awaitingGroupWriters'
      sess.groupWritersTimer = setTimeout(() => {
        if (_pairSession === sess) {
          console.log('[pair] groupWriters wait timed out; clearing session')
          _clearPairSession()
        }
      }, GROUP_WRITERS_WAIT_MS)
    }
  } catch (e) {
    console.error('[pair] personalWriter handler error:', e.message)
    replySend({ type: 'error', reason: 'primary_addwriter_error', message: e.message })
    _emitPair('pairingFailed', { reason: 'primary_addwriter_error', message: e.message })
    _clearPairSession()
  }
}

// Phase B: primary grants the secondary's per-group writer keys the moment they
// arrive, so a freshly-paired device is a writer on every group the primary
// belongs to without waiting for cross-grant convergence or a writer-announce
// round-trip. Only grants on groups the primary is itself a writer of; honors
// kick blocks; idempotent via knownWriter. Acks so the secondary can stop.
async function _handlePairGroupWriters (parsed, replySend) {
  if (_pairSession?.role !== 'primary') return
  const writers = Array.isArray(parsed.writers) ? parsed.writers : []
  console.log('[pair] received groupWriters for', writers.length, 'groups')
  const granted = []
  for (const w of writers) {
    const groupId = w?.groupId
    const writerKey = w?.writerKey
    if (!groupId || !/^[0-9a-f]{64}$/i.test(writerKey ?? '')) continue
    const base = bases.get(groupId)
    if (!base?.writable) continue   // can't grant on a group we're not a writer of
    const blocked = await db.get('blockedWriter:' + groupId + ':' + writerKey).catch(() => null)
    if (blocked?.value) continue
    const knownKey = 'knownWriter:' + groupId + ':' + writerKey
    if ((await db.get(knownKey).catch(() => null))?.value) { granted.push(groupId); continue }
    try {
      if (!(await safeAppend(base, { addWriter: writerKey }))) continue
      await db.put(knownKey, { ts: Date.now() }).catch(() => {})
      granted.push(groupId)
      console.log('[pair] fan-out addWriter on group', groupId, 'for', writerKey.slice(0, 16) + '…')
    } catch (e) { console.warn('[pair] fan-out addWriter error for', groupId, e.message) }
  }
  try { replySend({ type: 'groupWritersAck', granted }) } catch (e) {}
  _clearPairSession()
}

// Secondary: primary acked the group-writer fan-out. Nothing to apply locally
// (the grants ride each group's Autobase); just close out the session.
function _handlePairGroupWritersAck (parsed) {
  if (_pairSession?.role !== 'secondary') return
  console.log('[pair] groupWriters granted on', (parsed?.granted ?? []).length, 'groups')
  _clearPairSession()
}

// Shared: seed local group records + start joinGroup for each entry in a
// pair `granted` payload's groups[]. Used by both _handlePairComplete (normal
// path) and resumePendingPair (post-crash boot). Idempotent — skips groups
// already present in local DB.
async function _seedGroupsFromPair (groups) {
  if (!Array.isArray(groups) || groups.length === 0) return 0
  let newCount = 0
  const profile = await getProfile().catch(() => null)
  const selfMember = profile ? {
    id: profile.id,
    name: profile.name,
    avatar: profile.avatar ?? '?',
    publicKey: profile.publicKey,
    ...(profile.identityPublicKey ? { identityPublicKey: profile.identityPublicKey } : {}),
  } : null
  for (const g of groups) {
    const existing = await getGroup(g.id).catch(() => null)
    if (existing) continue
    const seed = {
      id:       g.id,
      name:     g.name,
      color:    g.color,
      emoji:    g.emoji,
      icon:     g.icon,
      ownerId:  g.ownerId,
      groupKey: g.groupKey,
      members:  selfMember ? [selfMember] : [],
      joinedAt: g.joinedAt ?? Date.now(),
    }
    await db.put(NS.groups + g.id, seed).catch(() => {})
    await db.put('joinedAt:' + g.id, { ts: seed.joinedAt }).catch(() => {})
    joinGroup(seed).catch(e => console.warn('[pair] seedGroups joinGroup error for', g.id, e.message))
    newCount++
  }
  return newCount
}

// Secondary: handle complete from primary. Persist group records + kick off
// joinGroup for each so Hyperswarm topics come online and writer-announce
// admission grants addWriter per group.
async function _handlePairComplete (replySend) {
  if (_pairSession?.role !== 'secondary') return
  const groups = _pairSession.groupsReceived ?? []
  const resolve = _pairSession.resolve
  try {
    const newCount = await _seedGroupsFromPair(groups)
    await db.del('personalMeta:pendingGroups').catch(() => {})
    // Belt-and-suspenders: seed the secondary's deviceMeta row now (well past
    // the post-open truncate-vs-prologue race window) so siblings see this
    // device by its platform label without waiting for the deferred boot
    // timer or a manual rename. No-op if already seeded.
    seedDeviceMetaIfNeeded().catch(e => console.warn('[pair] secondary deviceMeta seed:', e.message))
    _emitPair('pairingCompleted', { role: 'secondary', groups: newCount })
    // Resolve the consumePairLink promise now — pairing is done from the user's
    // perspective regardless of the Phase B fan-out below.
    resolve?.({ ok: true, groups: newCount })
    // Phase B (best-effort): once our group bases open, send their writer keys
    // so the primary grants us write access immediately. The session is cleared
    // by the ack handler or the fallback timer inside _sendGroupWritersToPrimary
    // — NOT here, so the round-trip can complete.
    if (typeof replySend === 'function') {
      _sendGroupWritersToPrimary(groups, replySend)
        .catch(e => console.warn('[pair] groupWriters send error:', e.message))
    } else {
      _clearPairSession()
    }
    return
  } catch (e) {
    console.error('[pair] complete handler error:', e.message)
    _emitPair('pairingFailed', { reason: 'secondary_complete_error', message: e.message })
    _pairSession?.reject?.(e)
    _clearPairSession()
  }
}

// Phase B (secondary): wait for each group's Autobase to open (joinGroup runs
// async from _seedGroupsFromPair), then send our per-group writer keys to the
// primary so it can grant them immediately. Best-effort: a fallback timer
// clears the session if the ack never comes, so a lost message can't leave the
// session dangling. Pairing success does not depend on this completing.
async function _sendGroupWritersToPrimary (groups, replySend) {
  const sess = _pairSession
  if (sess) {
    sess.groupWritersTimer = setTimeout(() => {
      if (_pairSession === sess) {
        console.log('[pair] groupWriters ack timed out; clearing session')
        _clearPairSession()
      }
    }, GROUP_WRITERS_WAIT_MS)
  }
  try {
    const writers = []
    for (const g of (groups ?? [])) {
      if (!g?.id) continue
      // joinGroup opens the base asynchronously; poll briefly for it.
      let base = bases.get(g.id)
      for (let i = 0; i < 30 && !base; i++) {
        await new Promise(r => setTimeout(r, 150))
        base = bases.get(g.id)
      }
      const key = base?.local?.key ? b4a.toString(base.local.key, 'hex') : null
      if (key) writers.push({ groupId: g.id, writerKey: key })
    }
    if (writers.length && _pairSession === sess) {
      replySend({ type: 'groupWriters', writers })
      console.log('[pair] sent groupWriters for', writers.length, 'groups')
    } else if (_pairSession === sess) {
      _clearPairSession()  // nothing to send
    }
  } catch (e) {
    console.warn('[pair] groupWriters build error:', e.message)
    if (_pairSession === sess) _clearPairSession()
  }
}

// Boot-time recovery: if a pair handshake persisted pendingGroups but never
// received `complete` (crash, force-kill, network blip between steps 3 and 4),
// replay the group seeding + joinGroup fan-out now. Safe on every boot — the
// key is cleared on success, and _seedGroupsFromPair is idempotent so even a
// partially-processed pendingGroups list converges.
async function resumePendingPair () {
  const pending = await db.get('personalMeta:pendingGroups').catch(() => null)
  if (!pending?.value?.groups) return
  const groups = pending.value.groups
  console.log('[pair] resuming pending pair — groups=' + groups.length)
  try {
    const newCount = await _seedGroupsFromPair(groups)
    await db.del('personalMeta:pendingGroups').catch(() => {})
    _emitPair('pairingCompleted', { role: 'secondary', resumed: true, groups: newCount })
  } catch (e) {
    console.error('[pair] resume error:', e.message)
    // Leave pendingGroups in place so the next boot tries again.
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
    if (await safeAppend(oldBase, { op: 'put', type: 'migration', key: mKey, value: marker })) {
      await oldBase.update()
      markerWritten = true
    }
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

  emitSync(oldGroupId)
  emitSync(descriptor.newGroupId)
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

  emitSync(oldGroupId)
  emitSync(newGroupId)
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
    'blockedIdentity:' + oldGroupId + ':',
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

  // Personal Autobase reachability — multi-device installs (TODO #11). Without
  // this loop the personal base's cores (bootstrap, this device's writer,
  // every paired sibling's writer, view) appear as orphans and a confirmed
  // sweep would destroy personal events, identityProfile, and groupMembership
  // pointers — plus break the multi-device link by deleting the local writer.
  if (personalBase) {
    const tag = 'personal'
    try {
      addDk(personalBase.local?.discoveryKey, tag)
      if (personalBase.key) addDk(hpc.discoveryKey(personalBase.key), tag)
      if (personalBase.bootstrap) addDk(hpc.discoveryKey(personalBase.bootstrap), tag)
      for (const w of (personalBase.activeWriters || personalBase.writers || [])) addDk(w?.core?.discoveryKey, tag)
      addDk(personalBase.system?.core?.discoveryKey, tag)
      addDk(personalBase.core?.discoveryKey, tag)
      addDk(personalBase.view?.feed?.discoveryKey, tag)
      addDk(personalBase.view?.core?.discoveryKey, tag)
    } catch (e) { console.warn('[AUDIT] personal base dks:', e.message) }
    try {
      const nsBuf = store.namespace('personal').ns
      for await (const dk of store.list(nsBuf)) addDk(dk, tag)
    } catch (e) { console.warn('[AUDIT] personal namespace list:', e.message) }
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

  // Same shape, for the personal Autobase: if multi-device sync is enabled
  // (`personalMeta:bootstrap` set) but the personal base isn't open, refuse
  // to purge — its cores would otherwise be misclassified as orphans.
  const personalMeta = await db.get('personalMeta:bootstrap').catch(() => null)
  const personalConfigured = !!personalMeta?.value?.key
  const personalWithoutBase = personalConfigured && !personalBase

  let purged = 0
  let dataRangesCleared = 0
  const purgeErrors = []
  if (purge && (liveWithoutBase.length || personalWithoutBase)) {
    return {
      totalCores: allCores.length,
      reachableCount: reachable.size,
      groupCount: groups.length,
      orphans: orphans.length,
      orphanBytes,
      orphanList: orphans.slice(0, 50),
      liveWithoutBase,
      personalWithoutBase,
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
    personalWithoutBase,
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
  await safeAppend(base, { op: 'put', type: 'event', key: 'events:' + event.date + ':' + event.id, value })
}

async function syncDeleteEvent (groupId, eventId, date, updatedByName, updatedById, recurrenceId, eventTitle) {
  const base = bases.get(groupId)
  if (!base) throw new Error('Not in group: ' + groupId)
  const payload = { op: 'del', type: 'event', key: 'events:' + date + ':' + eventId, updatedByName: updatedByName || 'Someone', updatedById: updatedById || '' }
  if (recurrenceId) payload.recurrenceId = recurrenceId
  if (eventTitle) payload.eventTitle = eventTitle
  await safeAppend(base, payload)
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
  await safeAppend(base, { op: 'purgeMember', groupId, memberId, purgedAt: Date.now() })
}

async function syncReinviteMember (groupId, memberId) {
  const base = bases.get(groupId)
  if (!base) return
  await safeAppend(base, { op: 'reinviteMember', groupId, memberId, ts: Date.now() })
}

// Phase 2 pending-rejoin queue. The writer-announce handler stores
// `pendingRejoin:{groupId}:{identityPublicKey}` whenever a kicked member
// returns with a valid identity proof. The owner UI approves or denies each
// request.
async function listPendingRejoins () {
  const out = []
  for await (const { value } of db.createReadStream({ gt: 'pendingRejoin:', lt: 'pendingRejoin:\xff' })) {
    if (value) out.push(value)
  }
  return out
}

// Approve a pending rejoin: move the member back into members[], clear the
// block + pending keys, and grant write access to the stored writerKey. The
// peer's next writer-announce retry (or a stored writerKey addWriter here)
// takes effect. Runs the same LWW group append so peers converge.
async function approveRejoin (groupId, identityPublicKey) {
  const node = await db.get('pendingRejoin:' + groupId + ':' + identityPublicKey).catch(() => null)
  if (!node?.value) return { ok: false, error: 'not_found' }
  const pending = node.value
  const group = await getGroup(groupId)
  if (!group) return { ok: false, error: 'group_gone' }
  const removed = group.removedMembers ?? []
  const match = removed.find(m => m.identityPublicKey === identityPublicKey)
    || removed.find(m => (m.id ?? m) === pending.memberId)
  // If the joiner's handleInviteLink broadcastSelf has already landed, prefer
  // its fresh name/avatar/avatarHash over the stale tombstone snapshot —
  // pre-wipe the user may have had different name or avatar fields.
  const existingMember = (group.members ?? []).find(m => m.id === pending.memberId)
  const baseRestored = match
    ? { ...match, id: pending.memberId, identityPublicKey, updatedAt: Date.now() }
    : { id: pending.memberId, identityPublicKey, name: pending.name || '', avatarHash: pending.avatarHash || null, updatedAt: Date.now() }
  // Merge order: tombstone restore first, then existingMember overrides fresh
  // profile fields (name/avatar/avatarHash), then bookkeeping fields get the
  // authoritative values.
  const restored = existingMember
    ? {
        ...baseRestored,
        ...existingMember,
        id: pending.memberId,
        identityPublicKey,
        updatedAt: Date.now(),
      }
    : baseRestored
  const members = existingMember
    ? (group.members ?? []).map(m => m.id === pending.memberId ? restored : m)
    : [...(group.members ?? []), restored]
  // Drop the matching identity entry + legacy tombstones: pre-Phase 2 kicks
  // carry no identityPublicKey and a different UUID, so they'd survive an
  // identity-based filter. Strip any removed row with matching name that
  // lacks identityPublicKey — it represents the same user under an older id.
  const pendName = (pending.name || '').trim().toLowerCase()
  const removedMembers = removed.filter(m => {
    if (m.identityPublicKey === identityPublicKey) return false
    if ((m.id ?? m) === pending.memberId) return false
    if (!m.identityPublicKey && pendName && (m.name || '').trim().toLowerCase() === pendName) return false
    return true
  })
  const updated = { ...group, members, removedMembers, updatedAt: Date.now() }
  await putGroup(updated).catch(() => {})
  const base = bases.get(groupId)
  if (base) await appendGroupWithAvatarSplit(base, updated).catch(() => {})
  await db.del('pendingRejoin:' + groupId + ':' + identityPublicKey).catch(() => {})
  await db.del('deniedRejoin:' + groupId + ':' + identityPublicKey).catch(() => {})
  // Phase 5: clear the identity-level block AND every per-writer block bound
  // to this identity, so all of the rejoiner's devices regain admission.
  await db.del('blockedIdentity:' + groupId + ':' + identityPublicKey).catch(() => {})
  for await (const { value: wiVal, key: wiKey } of db.createReadStream({
    gt: 'writerIdentity:' + groupId + ':',
    lt: 'writerIdentity:' + groupId + ':\xff',
  })) {
    if (wiVal?.identityPublicKey !== identityPublicKey) continue
    const wk = wiKey.slice(('writerIdentity:' + groupId + ':').length)
    await db.del('blockedWriter:' + groupId + ':' + wk).catch(() => {})
  }
  if (pending.writerKey) {
    await db.del('blockedWriter:' + groupId + ':' + pending.writerKey).catch(() => {})
    const alreadyGranted = await db.get('knownWriter:' + groupId + ':' + pending.writerKey).catch(() => null)
    if (!alreadyGranted && base) {
      safeAppend(base, { addWriter: pending.writerKey })
        .then((ok) => { if (ok) db.put('knownWriter:' + groupId + ':' + pending.writerKey, { ts: Date.now() }).catch(() => {}) })
        .catch(e => console.error('[APPROVE_REJOIN] addWriter error:', e.message))
    }
  }
  return { ok: true }
}

// Deny a pending rejoin: persist the decision so the next retry short-circuits
// straight to the blocked path, and surface a blocked message now if the peer
// is still reachable via a stored writerKey.
async function denyRejoin (groupId, identityPublicKey) {
  const node = await db.get('pendingRejoin:' + groupId + ':' + identityPublicKey).catch(() => null)
  await db.put('deniedRejoin:' + groupId + ':' + identityPublicKey, { ts: Date.now() }).catch(() => {})
  if (node?.value?.writerKey) {
    await db.put('blockedWriter:' + groupId + ':' + node.value.writerKey, { memberId: node.value.memberId, ts: Date.now() }).catch(() => {})
  }
  await db.del('pendingRejoin:' + groupId + ':' + identityPublicKey).catch(() => {})
  return { ok: true }
}

// Ownership transfer — append a promoteOwner op. Both entry points (owner
// hand-off and non-owner inactivity claim) share the same op shape; the real
// security boundary lives in apply() so a tampered client can't bypass it.
async function transferOwnership (groupId, targetProfileId) {
  const profile = await getProfile()
  if (!profile?.id) throw new Error('transferOwnership: no profile')
  const group = await getGroup(groupId)
  if (!group) throw new Error('transferOwnership: group not found')
  if (group.ownerId !== profile.id) throw new Error('transferOwnership: not the owner')
  if (!targetProfileId) throw new Error('transferOwnership: missing target')
  if (!(group.members ?? []).some(m => m.id === targetProfileId)) {
    throw new Error('transferOwnership: target is not a member')
  }
  const base = bases.get(groupId)
  if (!base) throw new Error('transferOwnership: group base not open')
  if (!(await safeAppend(base, {
    promoteOwner: targetProfileId,
    promotedBy: profile.id,
    ts: Date.now(),
  }))) throw new Error('transferOwnership: append failed')
  return { ok: true }
}

async function claimOwnership (groupId) {
  const profile = await getProfile()
  if (!profile?.id) throw new Error('claimOwnership: no profile')
  const group = await getGroup(groupId)
  if (!group) throw new Error('claimOwnership: group not found')
  if (group.ownerId === profile.id) throw new Error('claimOwnership: already owner')
  if (!(group.members ?? []).some(m => m.id === profile.id)) {
    throw new Error('claimOwnership: not a member')
  }
  const lastActivity = group.lastOwnerActivityTs ?? group.updatedAt ?? 0
  const elapsed = Date.now() - lastActivity
  if (elapsed <= CLAIM_OWNERSHIP_INACTIVITY_MS) {
    throw new Error('claimOwnership: owner still active (elapsed=' + elapsed + 'ms)')
  }
  const base = bases.get(groupId)
  if (!base) throw new Error('claimOwnership: group base not open')
  if (!(await safeAppend(base, {
    promoteOwner: profile.id,
    promotedBy: profile.id,
    ts: Date.now(),
  }))) throw new Error('claimOwnership: append failed')
  return { ok: true }
}

// Joiner-side: list groupIds for which the owner has queued our rejoin. Used
// by the UI to show a "waiting for approval" banner on the affected group.
async function listPendingApprovals () {
  const out = []
  for await (const { key } of db.createReadStream({ gt: 'pendingApproval:', lt: 'pendingApproval:\xff' })) {
    out.push(key.slice('pendingApproval:'.length))
  }
  return out
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
  emitSync(null)
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
          emitSync(groupId, { groupChanged: true })
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
      const announce = await buildWriterAnnounce(groupId, writerKey, profile?.id)
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
    const changedEvents = []
    let groupChanged = false
    for await (const { key, value } of view.createReadStream()) {
      if (!value) continue
      if (key.startsWith('events:')) {
        // Respect local delete tombstone — never resurrect user-deleted events
        const eventId = eventIdFromKey(key)
        const tombstone = await db.get(NS.deleted + eventId).catch(() => null)
        if (tombstone) continue
        const existing = await db.get(key).catch(() => null)
        if (existing?.value && sameExceptUpdatedAt(existing.value, value)) continue
        await db.put(key, value)
        changedEvents.push(value)
      } else if (key.startsWith(NS.avatars)) {
        // Repair missing avatar bytes. apply() mirrors avatars via mirrorToLocal
        // on the first pass, but if the op was already linearised when this peer
        // joined and mirror silently dropped it, the hash is referenced in member
        // records with no local bytes — UI renders "?". Put-if-absent matches
        // mirrorToLocal's avatar branch.
        const existing = await db.get(key).catch(() => null)
        if (!existing) await db.put(key, value)
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
        const mergedGroup = {
          ...value,
          color:   value.color   || ev?.color,
          name:    value.name    || ev?.name,
          emoji:   value.emoji   || ev?.emoji,
          icon:    value.icon    ?? ev?.icon,
          joinedAt: ev?.joinedAt || value.joinedAt,
          removedMembers: [...removedMap.values()],
          members: splitMembers,
        }
        if (ev && sameExceptUpdatedAt(ev, mergedGroup)) continue
        await db.put(key, mergedGroup)
        groupChanged = true
      }
    }
    if (changedEvents.length || groupChanged) {
      emitSync(groupId, { changedEvents, groupChanged })
    }
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

function isInvitedToEvent (event, profileId, ownedGroupIds) {
  if (!event.invitees || event.invitees.length === 0) return true
  if (event.creatorId === profileId) return true
  if (event.invitees.includes(profileId)) return true
  // Owner bypass: a group owner has full visibility into their own group,
  // independent of invitees[]. Without this, a mnemonic-restored owner whose
  // restored profile.id differs from the legacy creatorId/invitees baked into
  // pre-recovery events sees nothing on their own device. See TODO #86.
  if (ownedGroupIds && ownedGroupIds.size && (event.groups ?? []).some(g => ownedGroupIds.has(g))) return true
  return false
}

async function listOwnedGroupIds (profileId) {
  const owned = new Set()
  if (!profileId) return owned
  for await (const { value } of db.createReadStream({ gt: NS.groups, lt: NS.groups + '\xff' })) {
    if (value?.ownerId === profileId) owned.add(value.id)
  }
  return owned
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
        if (writerBlocked) continue
        // Multi-device kick (Phase 5): if we know which identity owns this
        // writerKey via writer-announce, refuse if that identity is blocked.
        // Race window: addWriter may arrive before writer-announce, in which
        // case we admit; the writer-announce branch below back-fills
        // blockedWriter if the identity turns out to be blocked, so future
        // addWriter ops for the same writerKey are denied even though this
        // op slipped through.
        const wi = await db.get('writerIdentity:' + groupId + ':' + val.addWriter).catch(() => null)
        if (wi?.value?.identityPublicKey) {
          const idBlocked = await db.get('blockedIdentity:' + groupId + ':' + wi.value.identityPublicKey).catch(() => null)
          if (idBlocked) continue
        }
        await host.addWriter(b4a.from(val.addWriter, 'hex'), { indexer: true })
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

      // Ownership transfer — update group.ownerId. Two paths converge here:
      //   (a) current owner promotes any member (always accepted),
      //   (b) non-owner claims ownership after 30d+ of owner inactivity.
      // Enforcement lives at apply() so a client that bypasses the UI and
      // appends a premature claim is rejected by every peer, not just the
      // promoter's own device.
      if (val.promoteOwner) {
        try {
          const gKey = NS.groups + groupId
          const gNode = await view.get(gKey).catch(() => null)
          if (!gNode?.value) { console.warn('[PROMOTE] no group record'); continue }
          const g = gNode.value
          const promoter = val.promotedBy
          const target = val.promoteOwner
          const promoterMember = (g.members ?? []).find(m => m.id === promoter)
          const targetMember = (g.members ?? []).find(m => m.id === target)
          if (!promoterMember || !targetMember) {
            console.warn('[PROMOTE] rejected — promoter or target not a member', { promoter, target })
            continue
          }
          const opTs = val.ts || Date.now()
          if (opTs <= (g.lastPromoteTs ?? 0)) {
            console.warn('[PROMOTE] rejected — LWW loses vs lastPromoteTs', opTs, g.lastPromoteTs)
            continue
          }
          const promoterIsOwner = promoter === g.ownerId
          // Fallback to group.updatedAt for legacy groups that predate this field.
          const lastActivity = g.lastOwnerActivityTs ?? g.updatedAt ?? 0
          const inactivityOk = (opTs - lastActivity) > CLAIM_OWNERSHIP_INACTIVITY_MS
          if (!promoterIsOwner && !inactivityOk) {
            console.warn('[PROMOTE] rejected — non-owner claim without sufficient inactivity',
              { elapsedMs: opTs - lastActivity, requiredMs: CLAIM_OWNERSHIP_INACTIVITY_MS })
            continue
          }
          const fromOwnerId = g.ownerId
          const nextLog = [
            ...(g.promotionLog ?? []),
            { from: fromOwnerId, to: target, by: promoter, ts: opTs },
          ].slice(-PROMOTION_LOG_MAX)
          const updated = {
            ...g,
            ownerId: target,
            lastOwnerActivityTs: opTs,
            lastPromoteTs: opTs,
            promotionLog: nextLog,
            updatedAt: opTs,
          }
          await view.put(gKey, updated)
          await mirrorToLocal('group', gKey, updated, groupId)
          // Notify every member about the ownership change (cheap, high-value
          // for transparency — matches the admin-role-change pattern above).
          if (isRemote && fromOwnerId !== target) {
            try {
              const profile = await getProfile().catch(() => null)
              const byName = promoterMember.nickname || promoterMember.name || 'Someone'
              const toName = targetMember.nickname || targetMember.name || 'a member'
              const groupName = updated.name || 'a group'
              let title
              if (profile?.id === target) {
                title = 'You are now the owner of ' + groupName
              } else if (profile?.id === fromOwnerId) {
                title = (promoterIsOwner ? 'Transferred ownership' : (byName + ' claimed ownership'))
                  + ' of ' + groupName
              } else {
                title = toName + ' is now the owner of ' + groupName
              }
              send({ type: 'event', event: 'syncNotify', data: {
                title,
                body: promoterIsOwner
                  ? byName + ' transferred ownership to ' + toName
                  : byName + ' claimed ownership after inactivity',
                tab: 'groups',
              }})
            } catch (e) { console.warn('[PROMOTE] notify error:', e.message) }
          }
          emitSync(groupId, { groupChanged: true })
        } catch (e) {
          console.error('[PROMOTE] apply error:', e.message)
        }
        continue
      }

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
            const existRemoved = existing.value.removedMembers ?? []
            const incRemoved = val.value.removedMembers ?? []
            // Determine if incoming record is authoritative (sent by owner with full member list)
            // vs a broadcastSelf (joiner sending only their own member record).
            // Owner records include the owner in members[]; broadcastSelf does not.
            const ownerId = val.value.ownerId || existing.value.ownerId
            const isAuthoritative = ownerId && incMembers.some(m => m.id === ownerId)
            let merged, mergedRemoved
            if (isAuthoritative) {
              // Owner speaks with full authority: trust incoming members AND
              // removedMembers lists. Approving a rejoin needs the previously-
              // removed entry actually gone, which a union against the old view
              // would silently undo.
              const incRemovedIds = new Set(incRemoved.map(m => m.id ?? m))
              merged = incMembers.filter(m => !incRemovedIds.has(m.id))
              const activeIds = new Set(merged.map(m => m.id))
              mergedRemoved = incRemoved.filter(m => !activeIds.has(m.id ?? m))
            } else {
              // broadcastSelf: union members so partial records don't wipe others,
              // and keep existing removedMembers entries so a stale broadcastSelf
              // from a kicked member can't resurrect themselves.
              const removedMap = new Map()
              for (const m of existRemoved) removedMap.set(m.id ?? m, m)
              for (const m of incRemoved) removedMap.set(m.id ?? m, m)
              const removedIds = new Set(removedMap.keys())
              const incIds = new Set(incMembers.map(m => m.id))
              merged = [...incMembers, ...existMembers.filter(m => !incIds.has(m.id))]
                .filter(m => !removedIds.has(m.id))
              const activeIds = new Set(merged.map(m => m.id))
              mergedRemoved = [...removedMap.values()].filter(m => !activeIds.has(m.id ?? m))
            }
            viewValue = {
              ...val.value,
              // Non-authoritative (broadcastSelf) writes carry the joiner's
              // local-cached ownerId, which may be the invite link's
              // `inviter` field — a publicKey, not a profile id. Preserve
              // the existing ownerId so a joiner's broadcast can't rewrite
              // the group's owner to whatever's in their placeholder record.
              ownerId: isAuthoritative
                ? (val.value.ownerId || existing.value.ownerId)
                : (existing.value.ownerId || val.value.ownerId),
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
          // Phase 5: identity-level kick mirror. For every removed member with
          // a known identity (skip the owner defensively), set a blockedIdentity
          // entry, and backfill blockedWriter for any of their already-known
          // writer keys via the writerIdentity index. Idempotent — safe on every
          // group-put. Approving a rejoin clears these in approveRejoin.
          if (val.type === 'group' && viewValue?.removedMembers?.length) {
            const ownerId = viewValue.ownerId
            for (const rm of viewValue.removedMembers) {
              const idHex = rm?.identityPublicKey
              if (!idHex) continue
              if (rm.id && rm.id === ownerId) continue
              await db.put('blockedIdentity:' + groupId + ':' + idHex, {
                memberId: rm.id ?? null,
                ts: Date.now(),
              }).catch(() => {})
              for await (const { value: wiVal, key: wiKey } of db.createReadStream({
                gt: 'writerIdentity:' + groupId + ':',
                lt: 'writerIdentity:' + groupId + ':\xff',
              })) {
                if (wiVal?.identityPublicKey !== idHex) continue
                const wk = wiKey.slice(('writerIdentity:' + groupId + ':').length)
                await db.put('blockedWriter:' + groupId + ':' + wk, {
                  memberId: rm.id ?? wiVal.memberId ?? null,
                  identityPublicKey: idHex,
                  ts: Date.now(),
                }).catch(() => {})
              }
            }
          }
          // Joiner-side: clear the "waiting for approval" flag if the owner's
          // latest authoritative group record now includes us as an active member.
          if (val.type === 'group' && viewValue.members) {
            const pendingKey = 'pendingApproval:' + groupId
            const pending = await db.get(pendingKey).catch(() => null)
            if (pending?.value) {
              const profile = await getProfile().catch(() => null)
              if (profile?.id && viewValue.members.some(m => m.id === profile.id)) {
                await db.del(pendingKey).catch(() => {})
                send({ type: 'event', event: 'pendingApprovalCleared', data: groupId })
              }
            }
          }
          // Invitee filter: skip notifications for uninvited events (mirrorToLocal already sent sync).
          // Owner of this group bypasses the filter (see TODO #86).
          if (isRemote && val.type === 'event') {
            const profile = await getProfile()
            const localGroup = await db.get(NS.groups + groupId).catch(() => null)
            const ownedSet = (profile?.id && localGroup?.value?.ownerId === profile.id)
              ? new Set([groupId])
              : null
            if (!isInvitedToEvent(val.value, profile?.id, ownedSet)) continue
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
              // so members already known before app restart don't trigger duplicate notifications.
              // Fresh-join case: after wipe+rejoin the local record is just {self, Inviter placeholder}
              // and Autobase catch-up will deliver the full owner roster — seeding from the tiny
              // local list would mark every pre-existing member as "new". Detect fresh-join and
              // seed from the incoming authoritative list so we silently absorb the historical roster.
              if (!notifiedMemberJoins.has(groupId)) {
                const localMembers = localGroupBeforeMirror?.value?.members ?? []
                const hasInviterPlaceholder = localMembers.some(m => m.name === 'Inviter' || m.name === '? Inviter')
                const isFreshJoin = localMembers.length <= 2 && hasInviterPlaceholder
                const seedIds = isFreshJoin
                  ? incomingMembers.map(m => m.id)
                  : localMembers.map(m => m.id)
                notifiedMemberJoins.set(groupId, new Set(seedIds))
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
                  emitSync(groupId, { groupChanged: true })
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
          // Self-removal auto-leave (TODO #74). If the owner kicks me while my app
          // is already connected to the swarm, no fresh writer-announce fires, so the
          // protomux `{ blocked: true }` path (bare.js:3227) never triggers. We'd
          // otherwise linger in the group with ourselves absent from members[] and
          // no notification. Detect that state here in the group-put path.
          if (isRemote && val.type === 'group') {
            try {
              const profile = await getProfile()
              const selfId = profile?.id
              const isOwner = selfId && viewValue.ownerId === selfId
              const inRemoved = selfId && (viewValue.removedMembers ?? []).some(m => (m.id ?? m) === selfId)
              // Skip historical replay during initial Autobase catch-up — we may have
              // been removed AND reinstated before coming online; the final view state
              // (post-replay) is what matters, and a later reinstate op clears us.
              const joinedAtEntry = await db.get('joinedAt:' + groupId).catch(() => null)
              const joinedAt = joinedAtEntry?.value?.ts ?? 0
              const isHistorical = val.value.updatedAt && val.value.updatedAt < joinedAt
              if (inRemoved && !isOwner && !isHistorical) {
                // Defer so any immediately-following reinstate op in the same apply
                // batch can first clear removedMembers. Re-check before acting.
                setTimeout(async () => {
                  const recheck = await db.get(NS.groups + groupId).catch(() => null)
                  if (!recheck?.value) return
                  const stillRemoved = (recheck.value.removedMembers ?? []).some(m => (m.id ?? m) === selfId)
                  if (!stillRemoved) return
                  const allMembers = [...(recheck.value.members ?? []), ...(recheck.value.removedMembers ?? [])]
                  const ownerName = allMembers.find(m => m.id === recheck.value.ownerId)?.name || 'The owner'
                  const kickedGroupName = recheck.value.name || 'a group'
                  send({ type: 'event', event: 'syncNotify', data: {
                    title: ownerName + ' removed you from ' + kickedGroupName,
                    body: 'You no longer have access to this group',
                    tab: 'groups'
                  }})
                  await db.put('blockedFromGroup:' + groupId, { ts: Date.now() }).catch(() => {})
                  await deleteGroup(groupId).catch(() => {})
                  await leaveGroup(groupId).catch(() => {})
                  // `groupDeleted` actually filters the group out of the UI list
                  // via onGroupDeleted in App.jsx. `inviteBlocked` only shows a
                  // toast. Mirror the memberLeft protomux self-kick path
                  // (bare.js:3232) which uses groupDeleted for the same reason.
                  send({ type: 'event', event: 'groupDeleted', data: groupId })
                }, 100)
              }
            } catch(e) { console.error('[SELF_REMOVAL] error:', e.message) }
          }
          if (isRemote && val.type === 'event') {
            // Shadow (busy-time) events carry no invitation/commitment — silent
            if (val.value.isShadow) continue
            // Multi-device: suppress notifications for ops authored by any
            // sibling device of MY identity (TODO #11 Phase 4). Without this,
            // creating an event on one paired device fires a notification on
            // every other paired device.
            if (await isSelfAuthoredOp(groupId, nodeWriterKey)) continue
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
            // Exclude reinstated members (reinvited or purged via Autobase op).
            // Compare timestamps so a later re-kick supersedes the earlier reinstate;
            // otherwise a second kick is silently filtered out (sticky reinstated key).
            const groupUpdatedAt = Math.max(winningValue.updatedAt ?? 0, val.value.updatedAt ?? 0)
            for (const id of [...removedMap.keys()]) {
              const reinstated = await db.get('reinstated:' + groupId + ':' + id).catch(() => null)
              if (reinstated && (reinstated.value?.ts ?? 0) > groupUpdatedAt) {
                removedMap.delete(id)
              }
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
            emitSync(groupId, { groupChanged: true })
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
          const delDelta = val.type === 'event'
            ? { removedIds: [eventIdFromKey(val.key)] }
            : val.type === 'rsvp'
              ? { rsvpsChanged: true }
              : val.type === 'group' || val.type === 'groupMembers'
                ? { groupChanged: true }
                : { fullReload: true }
          emitSync(groupId, delDelta)
          if (isRemote && val.type === 'event') {
            const eventId = eventIdFromKey(val.key)
            // Cancel any scheduled notification for this deleted event
            send({ type: 'event', event: 'cancelNotification', data: eventId })
            // Shadow (busy-time) deletes are silent — mirror the put side
            const isShadowKey = val.key.includes(':shadow:')
            // Multi-device: suppress notifications for ops authored by any
            // sibling device of MY identity (TODO #11 Phase 4).
            const selfAuthoredDel = await isSelfAuthoredOp(groupId, nodeWriterKey)
            const delTombstone = await db.get(NS.deleted + eventId).catch(() => null)
            if (!delTombstone && !isShadowKey && !selfAuthoredDel && !recentDeleteNotifs.has(eventId)) {
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
            // Write tombstone AFTER notification check so re-linearization (foregroundSync, bgSync) won't re-fire.
            // Applies to shadows too — without it, a peer receiving the shadow delete op on initial
            // sync replay has no guard against a later re-put resurrecting the shadow.
            await db.put(NS.deleted + eventId, { ts: Date.now() }).catch(() => {})
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
          // Phase 5: clear the identity-level block so paired siblings of the
          // reinvited member regain admission too.
          const idHex = memberRecord?.identityPublicKey
          if (idHex) {
            await db.del('blockedIdentity:' + val.groupId + ':' + idHex).catch(() => {})
          }
        }
        emitSync(val.groupId, { groupChanged: true })
      } else if (val.op === 'purgeMember') {
        const gKey = NS.groups + val.groupId
        const gNode = await view.get(gKey)
        if (gNode?.value) {
          const purgedRemoved = (gNode.value.removedMembers ?? []).find(m => (m.id ?? m) === val.memberId)
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
          // Phase 5: forget the identity block + per-writer blocks tied to it.
          // Purge means the kick is being undone — let every device of this
          // identity rejoin cleanly via the normal admission path.
          const idHex = purgedRemoved?.identityPublicKey
          if (idHex) {
            await db.del('blockedIdentity:' + val.groupId + ':' + idHex).catch(() => {})
            for await (const { value: wiVal, key: wiKey } of db.createReadStream({
              gt: 'writerIdentity:' + val.groupId + ':',
              lt: 'writerIdentity:' + val.groupId + ':\xff',
            })) {
              if (wiVal?.identityPublicKey !== idHex) continue
              const wk = wiKey.slice(('writerIdentity:' + val.groupId + ':').length)
              await db.del('blockedWriter:' + val.groupId + ':' + wk).catch(() => {})
            }
          }
        }
        emitSync(val.groupId, { groupChanged: true })
      }

      // Owner-activity heartbeat: if this op was authored by any device
      // belonging to the current owner's identity, refresh the group's
      // lastOwnerActivityTs. The value is consulted by the non-owner claim
      // path; "activity" is deliberately Autobase-writes only (no protomux
      // or connection heartbeats), so a truly absent owner's clock decays.
      // Skip for promoteOwner ops (we already set lastOwnerActivityTs above)
      // and for addWriter/migration ops (already continued above before here).
      //
      // Multi-device (TODO #11): an owner may have several writerKeys, one
      // per paired device. Fast path matches ownerMember.writerKey (the first
      // device's key, stamped at createGroup). Identity path resolves the
      // node's writerKey via writerIdentity:{groupId}:{writerKey} — populated
      // by every verified writer-announce (bare.js:~4113) — and matches any
      // writer whose identity equals ownerMember.identityPublicKey.
      try {
        if (nodeWriterKey) {
          const gKey = NS.groups + groupId
          const gNode = await view.get(gKey).catch(() => null)
          const g = gNode?.value
          if (g && g.ownerId) {
            const ownerMember = (g.members ?? []).find(m => m.id === g.ownerId)
            let isOwnerActivity = !!(ownerMember?.writerKey && ownerMember.writerKey === nodeWriterKey)
            if (!isOwnerActivity && ownerMember?.identityPublicKey) {
              const wi = await db.get('writerIdentity:' + groupId + ':' + nodeWriterKey).catch(() => null)
              if (wi?.value?.identityPublicKey === ownerMember.identityPublicKey) {
                isOwnerActivity = true
              }
            }
            if (isOwnerActivity) {
              const now = Date.now()
              // Coarse throttle — no need to re-write on every op in a burst.
              if (now - (g.lastOwnerActivityTs ?? 0) > 60 * 1000) {
                const bumped = { ...g, lastOwnerActivityTs: now }
                await view.put(gKey, bumped)
                // Mirror so non-owner peers see fresh value when computing
                // the claim gate. Doesn't touch updatedAt, so the mirror's
                // sameExceptUpdatedAt check still writes (lastOwnerActivityTs
                // differs) but nothing about the visible group state
                // changed — emitSync below is informational.
                await mirrorToLocal('group', gKey, bumped, groupId)
              }
            }
          }
        }
      } catch (e) { /* best-effort */ }
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

// Two mirrored records are "the same" if they differ only in `updatedAt`.
// Hypercore is append-only, so rewriting an unchanged record wastes a block
// (and the trailing sync emit triggers a pointless UI refetch). JSON compare
// is safe because both sides are built from the same merge code paths — key
// order is stable.
function sameExceptUpdatedAt (a, b) {
  if (a === b) return true
  if (!a || !b) return false
  const { updatedAt: _a, ...ac } = a
  const { updatedAt: _b, ...bc } = b
  return JSON.stringify(ac) === JSON.stringify(bc)
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
        emitSync(groupId, { rsvpsChanged: true })
      }
      return
    }
    if (type === 'groupMembers') {
      // Phase 1 read-both shim for TODO #70. Phase 2+ peers will append split
      // ops alongside `type: 'group'` metadata writes. Plain LWW here —
      // authoritative-vs-union merge lives in Phase 2 when we become a writer
      // of these ops. For now just accept the newer record so rehydrate has it.
      const existing = await db.get(key).catch(() => null)
      if (!existing || !existing.value?.updatedAt || (value.updatedAt ?? 0) >= existing.value.updatedAt) {
        await db.put(key, value)
        emitSync(groupId, { groupChanged: true })
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
      const next = { ...clean, updatedAt: value.updatedAt || Date.now() }
      const existing = await db.get(key).catch(() => null)
      if (existing?.value && sameExceptUpdatedAt(existing.value, next)) return
      await db.put(key, next)
      emitSync(groupId, { changedEvents: [next] })
      scheduleWidgetCacheRefresh()
      return
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
      // key is set by the reinviteMember/purgeMember Autobase ops in apply().
      // Compare timestamps so a later re-kick supersedes the earlier reinstate;
      // otherwise the key stays sticky and a second kick is silently filtered
      // out of local removedMembers, which suppresses #74 auto-leave (its
      // re-read sees stillRemoved=false and bails).
      for (const id of [...removedMap.keys()]) {
        const reinstated = await db.get('reinstated:' + groupId + ':' + id).catch(() => null)
        if (reinstated && (reinstated.value?.ts ?? 0) > (value.updatedAt ?? 0)) {
          removedMap.delete(id)
        }
      }
      // Filter out any member who appears in removedMembers
      for (const id of removedMap.keys()) mergedMap.delete(id)
      // Strip inline avatars into the avatars: keyspace so local DB stays
      // dedup-shaped even when incoming records arrive inline from pre-Phase2
      // peers. Does not rewrite the Autobase view — only the local mirror.
      const { members: splitMembers } = await splitMembersInline([...mergedMap.values()])
      const merged = {
        ...value,
        // Same guard as apply()'s non-authoritative merge: a joiner's
        // broadcastSelf carries the invite-link `inviter` publicKey as ownerId.
        // Don't let it overwrite the authoritative ownerId already in the local
        // record from a prior owner-authored Autobase replay.
        ownerId: isAuthoritative
          ? (value.ownerId || existing?.value?.ownerId)
          : (existing?.value?.ownerId || value.ownerId),
        color:   value.color   || existing?.value?.color,
        name:    value.name    || existing?.value?.name,
        emoji:   value.emoji   || existing?.value?.emoji,
        icon:    value.icon    ?? existing?.value?.icon,
        joinedAt: existing?.value?.joinedAt || value.joinedAt,
        removedMembers: [...removedMap.values()],
        members: splitMembers,
        updatedAt: value.updatedAt || Date.now()
      }
      if (existing?.value && sameExceptUpdatedAt(existing.value, merged)) return
      await db.put(key, merged)
      emitSync(groupId, { groupChanged: true })
      // Owner-bypass in widget filter depends on group.ownerId — when Autobase
      // replay corrects ownerId from the invite-link placeholder to the
      // authoritative mnemonic-derived id, the widget cache must rebuild so
      // the restored owner's events appear.
      if (existing?.value?.ownerId !== merged.ownerId) scheduleWidgetCacheRefresh()
    }
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
  emitSync(groupId, { groupChanged: true })
}

// ── Storage diagnostics ──────────────────────────────────────────────────────

async function storageBreakdown () {
  // bare-fs/bare-path read `Bare.platform` and call `require.addon` at module
  // load — both fail under Node (Electron desktop). Fall back to Node's fs/path
  // when Bare is absent. Both APIs share the readdir/stat/join surface this
  // function uses.
  const fs = typeof Bare !== 'undefined' ? require('bare-fs') : require('fs')
  const path = typeof Bare !== 'undefined' ? require('bare-path') : require('path')

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
  // bare-fs/bare-path read `Bare.platform` and call `require.addon` at module
  // load — both fail under Node (Electron desktop). Fall back to Node's fs/path
  // when Bare is absent. Both APIs share the readdir/stat/join surface this
  // function uses.
  const fs = typeof Bare !== 'undefined' ? require('bare-fs') : require('fs')
  const path = typeof Bare !== 'undefined' ? require('bare-path') : require('path')

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
  // bare-fs/bare-path read `Bare.platform` and call `require.addon` at module
  // load — both fail under Node (Electron desktop). Fall back to Node's fs/path
  // when Bare is absent. Both APIs share the readdir/stat/join surface this
  // function uses.
  const fs = typeof Bare !== 'undefined' ? require('bare-fs') : require('fs')
  const path = typeof Bare !== 'undefined' ? require('bare-path') : require('path')

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

// Periodic safety-net tick to force re-linearisation on every active base.
// Autobase has its own per-writer core.on('append') hook, but we've observed
// member-side apply() lag where delete ops don't propagate until the app is
// force-closed. This tick bounds worst-case lag to ~15s.
//
// Per-tick work:
//   1. core.update() on every active writer core — re-requests tip length
//      from peers so lazy-pull doesn't leave us behind on missed appends.
//   2. base.update() — re-linearises whatever new blocks landed, firing apply().
let _realtimeSyncTimer = null
const REALTIME_SYNC_INTERVAL_MS = 15_000
async function runRealtimeSyncTick () {
  for (const [groupId, base] of bases) {
    try {
      const writers = base.activeWriters || base.writers || []
      for (const w of writers) {
        const core = w?.core
        if (core && typeof core.update === 'function') {
          await core.update().catch(() => {})
        }
      }
      await base.update()
    } catch (e) { console.warn('[RT-TICK] group', groupId, 'error:', e?.message) }
  }
  // Personal base liveness: the tick historically only drove GROUP bases, so
  // the personal base relied solely on Autobase's internal auto-update — which
  // could miss live sibling ops (e.g. a private note appended right after its
  // event), leaving them unapplied until an app restart forced a full replay.
  // Drive it on the same cadence as group bases: re-request each writer core's
  // tip, then re-linearize so incoming ops mirror to local DB promptly.
  if (personalBase) {
    try {
      const writers = personalBase.activeWriters || personalBase.writers || []
      for (const w of writers) {
        const core = w?.core
        if (core && typeof core.update === 'function') await core.update().catch(() => {})
      }
      await personalBase.update()
    } catch (e) { console.warn('[RT-TICK] personal error:', e?.message) }
  }
  // Multi-device write-redundancy convergence (Phase A): re-publish our group
  // writer keys + cross-grant siblings on groups we're a writer of.
  await runGroupWriterRedundancyTick().catch(() => {})
  // Backup-integrity (TODO #11): primary re-publishes sibling-authored personal
  // events into its own core so re-paired devices reliably recover them.
  await runPersonalConsolidation().catch(() => {})
  // Liveness retry (Phase C): keep re-announcing on groups where we're still
  // read-only until some authorized writer grants us. Self-heals a device that
  // missed its grant window (no writer online when it first announced).
  await reannounceUnwritableGroups().catch(() => {})
}

// Phase C: re-broadcast our writer-announce on every group where this device is
// still read-only, so an authorized writer that comes online later (or that was
// connected before our identity proof was ready) grants us. Cheap: small
// messages to currently-connected peers only; no-op once writable. Complements
// Phase A (cross-grant via personal base) — both push a stuck device toward
// write access through independent transports (group topic vs. personal topic).
async function reannounceUnwritableGroups () {
  let profile = null
  for (const [groupId, base] of bases) {
    try {
      if (base.writable) continue
      const writerKey = base.local?.key ? b4a.toString(base.local.key, 'hex') : null
      if (!writerKey) continue
      if (!profile) profile = await getProfile().catch(() => null)
      const announceBuf = await buildWriterAnnounce(groupId, writerKey, profile?.id)
      for (const ch of activeChannels) { try { ch.send(announceBuf) } catch (e) {} }
    } catch (e) { /* per-group best-effort */ }
  }
}
function startRealtimeSyncTick () {
  if (_realtimeSyncTimer) return
  _realtimeSyncTimer = setInterval(() => {
    runRealtimeSyncTick().catch(() => {})
  }, REALTIME_SYNC_INTERVAL_MS)
}
function stopRealtimeSyncTick () {
  if (_realtimeSyncTimer) { clearInterval(_realtimeSyncTimer); _realtimeSyncTimer = null }
}

async function shutdown () {
  try {
    stopRealtimeSyncTick()
    await closePersonalBase()
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

// ── Storage retention (TODO #112; backport of @peerloom/core engine.retain) ──
// Prune old blocks from each base's input (writer) cores to bound append-only
// growth. For each writer we clear [0, consumed - keepRecent): blocks Autobase
// has already consumed into its persisted view, minus a recent buffer. Safe
// because Autobase reloads its persisted view + system on restart (it never
// re-reads these old input blocks), and a lagging/new peer re-downloads from a
// peer or fast-forwards. clear() keeps each core's Merkle tree intact so it
// stays valid (unlike core.purge(), which is broken on this stack); physical
// disk frees as RocksDB compacts. Conservative + best-effort, local-only, no
// wire change. Removes the disk-bloat reason for routine group rekeys.
const RETENTION_INTERVAL_MS = 30 * 60 * 1000
const RETENTION_KEEP_RECENT = 256
let _retentionTimer = null

async function retainBase (base, keepRecent = RETENTION_KEEP_RECENT) {
  if (!base) return 0
  try { await base.update() } catch (e) { /* best-effort */ }
  let cleared = 0
  const writers = []
  try { for (const w of (base.activeWriters || base.writers || [])) if (w && w.core) writers.push(w) } catch (e) {}
  for (const w of writers) {
    const consumed = typeof w.length === 'number' ? w.length : 0
    const upto = consumed - keepRecent
    if (upto <= 0) continue
    try { await w.core.clear(0, upto); cleared += upto } catch (e) { /* best-effort per writer */ }
  }
  return cleared
}

// Sweep retention across every mounted group base + the personal base. Serial +
// best-effort so a slow/failing base never blocks the others.
async function retentionSweep () {
  let cleared = 0
  for (const [, base] of bases) { try { cleared += await retainBase(base) } catch (e) {} }
  if (personalBase) { try { cleared += await retainBase(personalBase) } catch (e) {} }
  console.log('[retention] sweep done:', cleared, 'old blocks cleared across', bases.size, 'groups + personal')
  return cleared
}

// Auto retention: an initial settle sweep, then on a fixed interval. Unref'd so
// it never keeps the worklet alive on its own. Idempotent.
function startRetention () {
  if (_retentionTimer) return
  const initial = setTimeout(() => { retentionSweep().catch(() => {}) }, Math.min(RETENTION_INTERVAL_MS, 15000))
  if (initial && typeof initial.unref === 'function') initial.unref()
  _retentionTimer = setInterval(() => { retentionSweep().catch(() => {}) }, RETENTION_INTERVAL_MS)
  if (_retentionTimer && typeof _retentionTimer.unref === 'function') _retentionTimer.unref()
}

let _initPromise = null
async function init (dir, opts = {}, attempt = 0) {
  // Backwards-compat: older RN shells may pass attempt as the second arg.
  if (typeof opts === 'number') { attempt = opts; opts = {} }
  if (opts && typeof opts.platform === 'string') _platform = opts.platform
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
    installFaultHandlers()
    console.log('Init DB at', dataDir)

    // Main local DB
    const core = new Hypercore(dataDir + '/core', { valueEncoding: 'json' })
    await core.ready()
    db = new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'json' })
    await db.ready()

    // Corestore for Autobase groups
    store = new Corestore(dataDir + '/store')
    await store.ready()
    startStoreFlushCadence()

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
          // Process any blocks that replicated before onopen fired (race fix for late joiners).
          // Live updates are handled by Autobase's internal core.on('append') hook plus the
          // periodic startRealtimeSyncTick() safety net.
          for (const [, base] of bases) {
            base.update().catch(e => console.warn('[REPL] initial update error:', e.message))
          }

          // Send our writerKey for every group we've joined
          const _announceProfile = await getProfile().catch(() => null)
          const _announceMemberId = _announceProfile?.id ?? null
          for (const [groupId, base] of bases) {
            const writerKey = b4a.toString(base.local.key, 'hex')
            const announce = await buildWriterAnnounce(groupId, writerKey, _announceMemberId)
            msg.send(announce)
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
                  emitSync(groupId, { groupChanged: true })
                }
              } catch(e) { console.error('[MEMBER_LEFT] error:', e.message) }
              return
            }
            // Handle pending-approval message — owner queued our rejoin for review.
            // Persist so the banner survives restarts; cleared when the owner
            // approves (next group update arrives with us in members[]) or denies
            // (triggers the blocked path above).
            if (parsed.pendingApproval) {
              const gid = parsed.groupId
              if (gid) {
                await db.put('pendingApproval:' + gid, { ts: Date.now() }).catch(() => {})
                send({ type: 'event', event: 'pendingApproval', data: gid })
              }
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

            // Identity proof verification (Phase 1 — tolerate missing proofs).
            // If the payload carries { identityPublicKey, proof }, verify the
            // proof binds writerKey to that identity. On success, index the
            // binding locally and (if we're the owner) stamp it onto the member
            // record. On failure, log and drop — a bogus proof is a worse
            // signal than a missing one.
            let verifiedIdentityHex = null
            if (groupId && writerKey && parsed.proof && parsed.identityPublicKey) {
              try {
                const proofBuf = b4a.from(parsed.proof, 'hex')
                const writerKeyBuf = b4a.from(writerKey, 'hex')
                const result = IdentityKey.verify(proofBuf, null, { expectedDevice: writerKeyBuf })
                if (!result) {
                  console.warn('[identity] writer-announce proof FAILED for group', groupId, 'writer', writerKey.slice(0, 12) + '…')
                  return
                }
                const recoveredHex = b4a.toString(result.identityPublicKey, 'hex')
                if (recoveredHex !== parsed.identityPublicKey) {
                  console.warn('[identity] proof identity mismatch: payload', parsed.identityPublicKey.slice(0, 12) + '…', 'recovered', recoveredHex.slice(0, 12) + '…')
                  return
                }
                verifiedIdentityHex = recoveredHex
                await db.put('writerIdentity:' + groupId + ':' + writerKey, {
                  identityPublicKey: verifiedIdentityHex,
                  memberId: parsed.memberId ?? null,
                  ts: Date.now(),
                }).catch(() => {})
                // Phase 5: if this identity has been kicked, block the
                // freshly-announced writerKey so any incoming addWriter op for
                // it dies at the apply gate even if the apply-time
                // writerIdentity lookup races ahead of this binding write.
                const idBlocked = await db.get('blockedIdentity:' + groupId + ':' + verifiedIdentityHex).catch(() => null)
                if (idBlocked) {
                  await db.put('blockedWriter:' + groupId + ':' + writerKey, {
                    memberId: parsed.memberId ?? null,
                    identityPublicKey: verifiedIdentityHex,
                    ts: Date.now(),
                  }).catch(() => {})
                  console.log('[identity] writer-announce from blocked identity, blocking writerKey', writerKey.slice(0, 12) + '…')
                }
              } catch (e) {
                console.warn('[identity] verify threw for group', groupId, e.message)
                return
              }
            }

            // Owner-side: if we verified the identity and the announcing peer
            // is already in our members list, stamp identityPublicKey onto
            // their record and rebroadcast the group so all peers converge.
            // Additive patch — we never overwrite a matching value.
            if (verifiedIdentityHex && parsed.memberId) {
              try {
                const ownerProfile = await getProfile().catch(() => null)
                const g = await getGroup(groupId).catch(() => null)
                if (g && ownerProfile && g.ownerId === ownerProfile.id) {
                  const members = g.members ?? []
                  const idx = members.findIndex(m => m.id === parsed.memberId)
                  if (idx !== -1 && members[idx].identityPublicKey !== verifiedIdentityHex) {
                    const updatedMembers = members.map((m, i) =>
                      i === idx ? { ...m, identityPublicKey: verifiedIdentityHex } : m
                    )
                    const updated = { ...g, members: updatedMembers, updatedAt: Date.now() }
                    await putGroup(updated).catch(() => {})
                    const b = bases.get(groupId)
                    if (b) await appendGroupWithAvatarSplit(b, updated).catch(() => {})
                    console.log('[identity] stamped identityPublicKey on member', parsed.memberId, 'in', groupId)
                  }
                }
              } catch (e) {
                console.warn('[identity] member-stamp failed for', groupId, e.message)
              }
            }

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
                const isMember = group && (group.members ?? []).some(m => m.id === profile.id)
                // Only group participants (owner or current members) can make
                // admission decisions on behalf of the group.
                if (!isOwner && !isMember) return
                const connKey = groupId + ':' + writerKey
                if (connSeenWriters.has(connKey)) return
                connSeenWriters.add(connKey)
                // Still track globally to handle duplicate announcements from same peer
                const _pendingSet = pendingWriterAnnouncements.get(groupId) || new Set()
                _pendingSet.add(writerKey)
                pendingWriterAnnouncements.set(groupId, _pendingSet)
                // Phase 2 admission control. Five cases for a writer-announce:
                //   (A) identity in removedMembers[] → queue for owner approval (OWNER ONLY)
                //   (B) memberId in removedMembers[] (no identity path) → auto-block (OWNER ONLY)
                //   (C) new joiner with no valid identity proof → reject (any member)
                //   (D) identity matches existing member with a different memberId
                //       (legacy profile.id migration) → rebind members[n].id (any member)
                //   (E) otherwise → fall through to the existing addWriter path (any member)
                // Cases A/B stay owner-only: kicks are an authoritative decision only
                // the owner makes. Cases C/D/E can be handled by any member so new
                // joiners (and restored owners) don't have to wait for the owner to
                // come online — Autobase dedupes concurrent addWriter ops.
                const removedMembers = group.removedMembers ?? []
                const activeMembers = group.members ?? []
                const parsed_memberId = parsed.memberId ?? null
                const memberIdInMembers = parsed_memberId && activeMembers.some(m => m.id === parsed_memberId)
                const identityInMembers = verifiedIdentityHex && activeMembers.some(m => m.identityPublicKey === verifiedIdentityHex)
                const removedByMemberId = parsed_memberId ? removedMembers.find(m => (m.id ?? m) === parsed_memberId) : null
                const removedByIdentity = verifiedIdentityHex ? removedMembers.find(m => m.identityPublicKey === verifiedIdentityHex) : null
                // Legacy-tombstone match: pre-Phase 2 kicks left rows with no identityPublicKey
                // and a UUID that no longer matches the returning member's deterministic id.
                // If the joiner's announce carries a profile name that matches a legacy
                // tombstone row, treat it as a rejoin request.
                const announceName = (parsed.name || '').trim().toLowerCase()
                const removedByName = (verifiedIdentityHex && announceName)
                  ? removedMembers.find(m => !m.identityPublicKey && (m.name || '').trim().toLowerCase() === announceName)
                  : null

                // (A) Queue a pendingRejoin for owner decision — valid identity
                // proof from a user previously kicked. Don't block; don't grant.
                // Non-owner peers ignore and let the owner decide when online.
                if ((removedByIdentity || (removedByMemberId && verifiedIdentityHex) || removedByName) && !memberIdInMembers && !identityInMembers) {
                  if (!isOwner) {
                    console.log('[identity] non-owner saw rejoin request for', groupId, '— awaiting owner')
                    return
                  }
                  const match = removedByIdentity || removedByMemberId || removedByName
                  const deniedNode = await db.get('deniedRejoin:' + groupId + ':' + verifiedIdentityHex).catch(() => null)
                  if (deniedNode?.value) {
                    // Owner already denied this identity — fall through to block.
                    await db.put('blockedWriter:' + groupId + ':' + parsed.writerKey, { memberId: parsed_memberId, ts: Date.now() }).catch(() => {})
                    try {
                      const ownerProfile = await getProfile().catch(() => null)
                      msg.send(Buffer.from(JSON.stringify({ blocked: true, groupId, ownerName: ownerProfile?.name || 'The owner' })))
                    } catch(e) {}
                    return
                  }
                  // Send pendingApproval reply FIRST, before any awaits. The joiner's
                  // Hyperswarm connection can be short-lived (LAN roam, background
                  // transition, etc.); if we await db writes before replying the
                  // channel may close and the banner message never arrives.
                  try {
                    msg.send(Buffer.from(JSON.stringify({ pendingApproval: true, groupId })))
                  } catch(e) {}
                  const alreadyPending = await db.get('pendingRejoin:' + groupId + ':' + verifiedIdentityHex).catch(() => null)
                  await db.put('pendingRejoin:' + groupId + ':' + verifiedIdentityHex, {
                    groupId,
                    identityPublicKey: verifiedIdentityHex,
                    memberId: parsed_memberId,
                    writerKey: parsed.writerKey,
                    name: match?.name || null,
                    avatarHash: match?.avatarHash || null,
                    requestedAt: alreadyPending?.value?.requestedAt || Date.now(),
                  }).catch(() => {})
                  send({ type: 'event', event: 'pendingRejoin', data: { groupId, identityPublicKey: verifiedIdentityHex, memberId: parsed_memberId, name: match?.name || null } })
                  if (!alreadyPending?.value) {
                    const groupName = group.name || 'a group'
                    const displayName = match?.name || 'Someone'
                    send({ type: 'event', event: 'syncNotify', data: {
                      title: displayName + ' wants to rejoin ' + groupName,
                      body: 'Tap to approve or deny',
                      tab: 'groups',
                      groupSettingsId: groupId,
                      immediate: true,
                    }})
                  }
                  console.log('[identity] queued pendingRejoin for', groupId, 'identity', verifiedIdentityHex.slice(0, 12) + '…')
                  return
                }

                // (B) Legacy auto-block: memberId matches removedMembers[] and we
                // have no identity to distinguish a post-wipe return from a plain
                // impersonation attempt. Owner-only — only owner writes authoritative blocks.
                if (removedByMemberId && !verifiedIdentityHex) {
                  if (!isOwner) return
                  await db.put('blockedWriter:' + groupId + ':' + parsed.writerKey, { memberId: parsed_memberId, ts: Date.now() }).catch(() => {})
                  try {
                    const ownerProfile = await getProfile().catch(() => null)
                    msg.send(Buffer.from(JSON.stringify({ blocked: true, groupId, ownerName: ownerProfile?.name || 'The owner' })))
                  } catch(e) {}
                  return
                }

                // (C) Enforcement: a brand-new joiner (not in members[] or
                // removedMembers[]) must present a valid identity proof.
                // Existing members without proof (pre-Phase 1 peers) remain
                // accepted so the rollout stays tolerant.
                if (!memberIdInMembers && !identityInMembers && !verifiedIdentityHex) {
                  console.warn('[identity] rejecting proof-less new joiner', parsed_memberId, 'for', groupId)
                  try {
                    msg.send(Buffer.from(JSON.stringify({ rejected: 'missing_identity_proof', groupId })))
                  } catch(e) {}
                  return
                }

                // (D) Identity-match rebind + dedupe. Same identity may appear
                // under >1 memberId (a legacy UUID left over from pre-Phase 1
                // plus a broadcastSelf entry under the restored deterministic
                // id), or under a single legacy id that needs rebinding. Collapse
                // all identity-matched entries into a single record keyed on the
                // announcing memberId, keeping the richest record's fields.
                if (verifiedIdentityHex && parsed_memberId) {
                  const matches = []
                  activeMembers.forEach((m, i) => {
                    if (m.identityPublicKey === verifiedIdentityHex) matches.push(i)
                  })
                  const idxById = activeMembers.findIndex(m => m.id === parsed_memberId)
                  // Dedupe/rebind when identity appears under >1 id, or under a
                  // different id than the announcer. Stamp identity when the
                  // announcer's active entry exists but has no identity recorded
                  // yet — otherwise a later kick strips identity from removedMembers.
                  const needsFix = matches.length > 1
                    || (matches.length === 1 && activeMembers[matches[0]].id !== parsed_memberId)
                    || (matches.length === 0 && idxById >= 0 && !activeMembers[idxById].identityPublicKey)
                  if (needsFix) {
                    let keeperIdx
                    if (matches.length > 0) {
                      keeperIdx = matches.reduce((best, i) => {
                        const bScore = JSON.stringify(activeMembers[best] ?? {}).length
                        const iScore = JSON.stringify(activeMembers[i] ?? {}).length
                        return iScore > bScore ? i : best
                      }, matches[0])
                    } else {
                      keeperIdx = idxById
                    }
                    const keeper = {
                      ...activeMembers[keeperIdx],
                      id: parsed_memberId,
                      identityPublicKey: verifiedIdentityHex,
                      // Stamp the announcer's fresh writerKey so the owner-activity
                      // heartbeat (apply()) matches this writer against ownerMember.writerKey
                      // after a restore — otherwise the member record stays bound to
                      // the owner's pre-wipe writerKey and their activity stops resetting
                      // the claim clock.
                      writerKey: parsed.writerKey,
                    }
                    const drop = new Set(matches)
                    drop.add(keeperIdx)
                    const updatedMembers = [
                      ...activeMembers.filter((_, i) => !drop.has(i)),
                      keeper,
                    ]
                    const updated = { ...group, members: updatedMembers, updatedAt: Date.now() }
                    await putGroup(updated).catch(() => {})
                    await appendGroupWithAvatarSplit(base, updated).catch(() => {})
                    console.log('[identity] stamp/rebind', matches.length, 'existing matches → 1 entry under id', parsed_memberId, 'in', groupId)
                  }
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
                console.log('[ADDWRITER] granting write to:', writerKey, 'for group:', groupId, 'as', isOwner ? 'owner' : 'member')
                safeAppend(base, { addWriter: writerKey })
                  .then(async (ok) => {
                    if (!ok) return
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

      // ── Device-pair channel (TODO #11 Phase 4) ─────────────────────────────
      // Opened on every connection but gated on _pairSession. Idle on peers
      // unrelated to pairing. Pre-existing connections (e.g. a shared group)
      // don't participate — the canonical flow pairs a fresh install against a
      // primary that has no prior swarm connection to the secondary.
      const pairChannel = mux.createChannel({
        protocol: PAIR_CHANNEL_PROTO,
        id: PAIR_CHANNEL_ID,
        async onopen () {
          try {
            // Register this channel so a pair session started LATER over this
            // already-open connection can still nudge its hello (broadcastPairHello
            // / consumePairLink, TODO #113); then cover the fresh-connection case.
            if (pairMsg) _pairChannels.add(pairMsg)
            broadcastPairHello()
          } catch (e) { console.warn('[pair] onopen error:', e.message) }
        },
        onclose () { if (pairMsg) _pairChannels.delete(pairMsg) }
      })

      const pairMsg = pairChannel ? pairChannel.addMessage({
        onmessage: async function (buf) {
          try {
            const parsed = JSON.parse(buf.toString())
            const replySend = (m) => { try { pairMsg.send(Buffer.from(JSON.stringify(m))) } catch(e) { console.warn('[pair] reply send error:', e.message) } }
            if (parsed.type === 'hello')               await _handlePairHello(parsed, replySend)
            else if (parsed.type === 'granted')        await _handlePairGranted(parsed, replySend)
            else if (parsed.type === 'personalWriter') await _handlePairPersonalWriter(parsed, replySend)
            else if (parsed.type === 'complete')       await _handlePairComplete(replySend)
            else if (parsed.type === 'groupWriters')   await _handlePairGroupWriters(parsed, replySend)
            else if (parsed.type === 'groupWritersAck') _handlePairGroupWritersAck(parsed)
            else if (parsed.type === 'error') {
              console.warn('[pair] peer error:', parsed.reason, parsed.message)
              _emitPair('pairingFailed', { reason: parsed.reason ?? 'peer_error', message: parsed.message })
              if (_pairSession?.role === 'secondary') _pairSession.reject?.(new Error(parsed.message ?? parsed.reason ?? 'peer_error'))
              _clearPairSession()
            }
          } catch (e) { console.error('[pair] onmessage error:', e.message) }
        }
      }) : null

      if (pairChannel) pairChannel.open()

    })

    // Ensure identity (mnemonic + derived Ed25519 keypair) before profile
    // bootstrap so new profiles can anchor their id to the mnemonic-derived
    // identityPublicKey. If this fails we fall through to legacy profile
    // creation — identity is advisory in Phase 1.
    let identity = null
    try {
      identity = await ensureIdentity()
    } catch (e) {
      console.warn('[identity] ensureIdentity failed, falling back to legacy profile:', e.message)
    }

    // Bootstrap profile
    const existing = await db.get(NS.profile)
    if (!existing) {
      const pk = b4a.allocUnsafe(sodium.crypto_sign_PUBLICKEYBYTES)
      const sk = b4a.allocUnsafe(sodium.crypto_sign_SECRETKEYBYTES)
      sodium.crypto_sign_keypair(pk, sk)
      const idHex = identity
        ? deriveProfileIdFromIdentity(identity.identityPublicKey)
        : b4a.toString(pk, 'hex')
      const record = {
        id:        idHex,
        name:      '',
        avatar:    '',
        publicKey: b4a.toString(pk, 'hex'),
        secretKey: b4a.toString(sk, 'hex'),
        createdAt: Date.now(),
      }
      if (identity) {
        record.identityPublicKey = b4a.toString(identity.identityPublicKey, 'hex')
      }
      await db.put(NS.profile, record)
    } else if (identity && !existing.value?.identityPublicKey) {
      // Existing profile pre-dates identity. Additively stamp identityPublicKey
      // so later wipe+rejoin flows can match this user to a restored identity.
      // Intentionally do NOT rewrite profile.id — invitee/RSVP references
      // across every group already point at the legacy UUID.
      await db.put(NS.profile, {
        ...existing.value,
        identityPublicKey: b4a.toString(identity.identityPublicKey, 'hex'),
        updatedAt: Date.now(),
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
    // Self-heal: drop any duplicate event keys (same id under different dates)
    // left behind by out-of-order Autobase replay (see listEvents dedupe).
    dedupeStaleEventKeys().catch(e => console.warn('event dedupe:', e.message))
    // Reopen the personal Autobase if the user previously enabled multi-device
    // (personalMeta:bootstrap present). No-op otherwise — single-device installs
    // never pay the setup cost. Chained resumePendingPair() recovers from a
    // crash between the pair handshake's granted→complete steps.
    ensurePersonalBase()
      .then(() => resumePendingPair())
      .catch(e => console.warn('[personal] ensure/resume error:', e.message))
    send({ type: 'event', event: 'ready' })
    scheduleMorningDigest().catch(e => console.warn('morning digest init:', e.message))
    startRealtimeSyncTick()
    startRetention()   // TODO #112: bound append-only growth on a 30-min cadence
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
