import { handleInviteLink, buildReinviteLink } from '../invite.js'
import { createRoot } from 'react-dom/client'
import App, { emitter } from './App.jsx'
import { installFixtures } from './screenshot-fixtures.js'
import { injectGlobalStyles } from './theme.js'

// Tokens + reset go in before the first render, so nothing paints unthemed.
// (:root is the dark palette, so no data-theme attribute is needed to start —
// App flips it to light once the profile loads.)
injectGlobalStyles()

// IPC bridge — installed only if a host hasn't already wired one.
// Desktop pre-sets __pearDB inline in index.html to talk over a Pear worker pipe;
// mobile lands here and uses ReactNativeWebView.postMessage.
if (!window.__pearDB) {
  let _nextId = 1
  const _pending = new Map()

  window.__pearDB = {
    call (method, ...args) {
      return new Promise((resolve, reject) => {
        const id = _nextId++
        _pending.set(id, msg => {
          if (msg.error) reject(new Error(msg.error))
          else resolve(msg.result)
        })
        window.ReactNativeWebView.postMessage(JSON.stringify({ id, method, args }))
      })
    }
  }

  window.__pearResponse = function (msg) {
    const resolve = _pending.get(msg.id)
    if (resolve) { _pending.delete(msg.id); resolve(msg) }
  }

  window.__pearEvent = function (event, data) {
    window.dispatchEvent(new CustomEvent('pear:' + event, { detail: data }))
  }
}

// Bridge CustomEvents → emitter so App.jsx sync/groupKeyUpdated handlers fire
window.addEventListener('pear:sync', e => emitter.emit('sync', e.detail))
window.addEventListener('pear:qrScanResult', e => emitter.emit('qrScanResult', e.detail))
window.addEventListener('pear:cameraResult', e => emitter.emit('cameraResult', e.detail))
window.addEventListener('pear:groupKeyUpdated', e => emitter.emit('groupKeyUpdated', e.detail))
window.addEventListener('pear:groupDeleted', e => emitter.emit('groupDeleted', e.detail))
window.addEventListener('pear:inviteBlocked', (e) => { emitter.emit('groupDeleted', e.detail); emitter.emit('inviteBlocked') })
// A join that was refused outright, and one that simply never landed (TODO #119).
// joinFailed already tore the stub group down in the worklet, so drop it from the
// UI's list too; joinStalled is advisory and leaves the group in place to retry.
window.addEventListener('pear:joinFailed', (e) => { emitter.emit('groupDeleted', e.detail?.groupId); emitter.emit('joinFailed', e.detail) })
window.addEventListener('pear:joinStalled', e => emitter.emit('joinStalled', e.detail))
window.addEventListener('pear:syncing', e => emitter.emit('syncing', e.detail))
window.addEventListener('pear:synced', e => emitter.emit('synced', e.detail))
window.addEventListener('pear:pendingRejoin', e => emitter.emit('pendingRejoin', e.detail))
window.addEventListener('pear:pendingApproval', e => emitter.emit('pendingApproval', e.detail))
window.addEventListener('pear:pendingApprovalCleared', e => emitter.emit('pendingApprovalCleared', e.detail))
window.addEventListener('pear:pairingStarted',   e => emitter.emit('pairingStarted', e.detail))
window.addEventListener('pear:pairingCompleted', e => emitter.emit('pairingCompleted', e.detail))
window.addEventListener('pear:pairingFailed',    e => emitter.emit('pairingFailed', e.detail))
window.addEventListener('pear:pairingExpired',   e => emitter.emit('pairingExpired', e.detail))
window.addEventListener('pear:profileChanged',   e => emitter.emit('profileChanged', e.detail))
window.addEventListener('pear:linkedDevicesChanged', e => emitter.emit('linkedDevicesChanged', e.detail))
window.addEventListener('pear:blindPeersChanged', e => emitter.emit('blindPeersChanged', e.detail))

const db = {
  getProfile:    ()          => window.__pearDB.call('getProfile'),
  updateProfile: (u)         => window.__pearDB.call('updateProfile', u),
  listEvents:    (opts)      => window.__pearDB.call('listEvents', opts),
  putEvent:      (ev)        => window.__pearDB.call('putEvent', ev),
  deleteEvent:   (d, id)     => window.__pearDB.call('deleteEvent', d, id),
  deleteEventSeries: (rid)   => window.__pearDB.call('deleteEventSeries', rid),
  localDeleteEvent: (d, id)  => window.__pearDB.call('localDeleteEvent', d, id),
  getGroup:      (id)        => window.__pearDB.call('getGroup', id),
  listGroups:    ()          => window.__pearDB.call('listGroups'),
  putGroup:      (g)         => window.__pearDB.call('putGroup', g),
  deleteGroup:   (id)        => window.__pearDB.call('deleteGroup', id),
  keylessGroupStatus: (id)   => window.__pearDB.call('keylessGroupStatus', id),
  repairKeylessGroup: (id, k) => window.__pearDB.call('repairKeylessGroup', id, k),
  isBlockedFromGroup: (id)   => window.__pearDB.call('isBlockedFromGroup', id),
  clearBlockedFromGroup: (id) => window.__pearDB.call('clearBlockedFromGroup', id),
  reinviteMember: (gid, mid) => window.__pearDB.call('reinviteMember', gid, mid),
  listMembers:   (gid)       => window.__pearDB.call('listMembers', gid),
  putMember:     (gid, m)    => window.__pearDB.call('putMember', gid, m),
  removeMember:  (gid, mid)  => window.__pearDB.call('removeMember', gid, mid),
  resyncGroup:   (groupId)   => window.__pearDB.call('resyncGroup', groupId),
  resyncAll:     ()          => window.__pearDB.call('resyncAll'),
  removeBrokenGroup: (id)    => window.__pearDB.call('removeBrokenGroup', id),
  setMemberNickname: (groupId, nick) => window.__pearDB.call('setMemberNickname', groupId, nick),
  getReminders:  (id)     => window.__pearDB.call('getReminders', id),
  putReminders:  (id, r)  => window.__pearDB.call('putReminders', id, r),
  getRsvp:       (eid, mid)       => window.__pearDB.call('getRsvp', eid, mid),
  listRsvps:     (eid)            => window.__pearDB.call('listRsvps', eid),
  listMyRsvps:   ()               => window.__pearDB.call('listMyRsvps'),
  putRsvp:       (eid, mid, s, gids) => window.__pearDB.call('putRsvp', eid, mid, s, gids),
  getPrivateNote: (id)       => window.__pearDB.call('getPrivateNote', id),
  putPrivateNote: (id, text) => window.__pearDB.call('putPrivateNote', id, text),
  getRelayStatus:     ()  => window.__pearDB.call('getRelayStatus'),
  setUseRelay:        (on) => window.__pearDB.call('setUseRelay', on),
  getBlindPeerKey:    ()  => window.__pearDB.call('getBlindPeerKey'),
  setBlindPeerKey:    (k) => window.__pearDB.call('setBlindPeerKey', k),
  removeBlindPeerKey: ()  => window.__pearDB.call('removeBlindPeerKey'),
  mintSeedBundle:     ()   => window.__pearDB.call('mintSeedBundle'),
  mintSeedInvite:     (id) => window.__pearDB.call('mintSeedInvite', id),
  seederPairScan:     (link) => window.__pearDB.call('seederPairScan', link),
  cancelSeederPairScan: ()  => window.__pearDB.call('cancelSeederPairScan'),
  listBlindPeers:     ()   => window.__pearDB.call('listBlindPeers'),
  removeBlindPeer:    (pk) => window.__pearDB.call('removeBlindPeer', pk),
  renameBlindPeer:    (pk, n) => window.__pearDB.call('renameBlindPeer', pk, n),
  setSeederAutoFollow: (pk, on) => window.__pearDB.call('setSeederAutoFollow', pk, on),
  getBackupStatus:    ()  => window.__pearDB.call('getBackupStatus'),
  setBackupEnabled:   (b) => window.__pearDB.call('setBackupEnabled', b),
  revealMnemonic:     ()  => window.__pearDB.call('revealMnemonic'),
  restoreMnemonic:    (m) => window.__pearDB.call('restoreMnemonic', m),
  listPendingRejoins: ()  => window.__pearDB.call('listPendingRejoins'),
  approveRejoin:      (gid, ipk) => window.__pearDB.call('approveRejoin', gid, ipk),
  denyRejoin:         (gid, ipk) => window.__pearDB.call('denyRejoin', gid, ipk),
  listPendingApprovals: ()  => window.__pearDB.call('listPendingApprovals'),
  enablePersonalSync:   ()  => window.__pearDB.call('enablePersonalSync'),
  getPersonalSyncStatus: () => window.__pearDB.call('getPersonalSyncStatus'),
  startPairing:         ()  => window.__pearDB.call('startPairing'),
  cancelPairing:        ()  => window.__pearDB.call('cancelPairing'),
  consumePairLink:      (url) => window.__pearDB.call('consumePairLink', url),
  getPairingStatus:     ()  => window.__pearDB.call('getPairingStatus'),
  listLinkedDevices:    ()  => window.__pearDB.call('listLinkedDevices'),
  setDeviceNickname:    (n) => window.__pearDB.call('setDeviceNickname', n),
  removeDeviceFromList: (k) => window.__pearDB.call('removeDeviceFromList', k),
}

// Trailing-edge debounce for reconcile (TODO #82 Phase 2). Rapid back-to-back
// saves (e.g. user creates event → immediately edits) collapse into one pass
// that runs against the final state, instead of two interleaving passes that
// race over the same fixed alarm-ID range.
//
// Every reconcile pass forwards the WebView's current IANA TZ to the bare
// worklet. Chromium refreshes its TZ when the OS changes, but the bare
// worklet's V8 caches the system TZ at engine init and never updates — so
// without an explicit `tzName` the worklet would keep computing fireAt
// against the zone the app launched in, even after the user crosses
// timezones. The explicit name lets the worklet route date math through
// Intl (ICU static tzdata), bypassing the cache entirely.
let _reconcileTimer = null
async function _runReconcile () {
  try {
    let tzName = null
    try { tzName = Intl.DateTimeFormat().resolvedOptions().timeZone } catch (_) {}
    const triples = await window.__pearDB.call('computeUpcomingReminders', 50, tzName)
    await window.__pearDB.call('reconcileSchedule', triples)
  } catch (e) {
    console.warn('[notifs.reconcile]', e?.message)
  }
}

const notifs = {
  scheduleForEvent: (ev, reminders) => window.__pearDB.call('scheduleForEvent', ev, reminders),
  cancelForEvent:   (id) => window.__pearDB.call('cancelForEvent', id),
  restoreAll:       ()   => window.__pearDB.call('restoreAll'),
  reconcile: () => {
    if (_reconcileTimer) clearTimeout(_reconcileTimer)
    _reconcileTimer = setTimeout(() => {
      _reconcileTimer = null
      _runReconcile()
    }, 200)
  },
}

// Foreground reconcile (TODO #82 Phase 2). visibilitychange fires when the
// WebView becomes visible after the app returns to foreground — re-arms the
// top-K alarms from current state, catching anything that expired or got
// missed during background.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      notifs.reconcile()
    }
  })
}

// Timezone-change reconcile. RN shell forwards Android's ACTION_TIMEZONE_CHANGED
// / ACTION_TIME_CHANGED broadcasts here so we re-derive fireAt against the new
// local zone — without this, AlarmManager keeps firing at the absolute UTC ms
// computed in the previous zone, which shows up as alarms 1 hour off the
// expected wall-clock after a flight.
window.__pearOnTimezoneChange = () => { notifs.reconcile() }

const sync = {
  createGroup: (name, meta) => window.__pearDB.call('createGroup', name, meta),
  joinGroup:   (g)          => window.__pearDB.call('joinGroup', g),
  leaveGroup:  (id)         => window.__pearDB.call('leaveGroup', id),
  deleteGroup: (id)         => window.__pearDB.call('deleteGroup:sync', id),
  putEvent:    (gid, ev)    => window.__pearDB.call('putEvent:sync', gid, ev),
  // `scope` is optional: pass 'group' to unshare the event from this group only,
  // leaving copies in other groups intact (TODO #122). Omit for a real delete.
  deleteEvent: (gid, id, d, who, whoId, rid, evTitle, scope) => window.__pearDB.call('deleteEvent:sync', gid, id, d, who, whoId, rid, evTitle, scope),
  putGroup:    (g)          => window.__pearDB.call('putGroup:sync', g),
  memberLeft:  (groupId, memberId) => window.__pearDB.call('memberLeft:sync', groupId, memberId),
  purgeMember: (groupId, memberId) => window.__pearDB.call('purgeMember:sync', groupId, memberId),
  debugGroup: (id) => window.__pearDB.call('debugGroup', id),
  nativeShare: (title, text) => window.__pearDB.call('nativeShare', title, text),
  exportIcs: (content) => window.__pearDB.call('exportIcs', content),
  exportRecoveryPhrase: (content) => window.__pearDB.call('exportRecoveryPhrase', content),
  qrScan: () => window.__pearDB.call('qrScan'),
  takePhoto: () => window.__pearDB.call('takePhoto'),
  haptic: (style) => window.__pearDB.call('haptic', style),
  openURL: (url) => window.__pearDB.call('openURL', url),
  canOpenLightning: () => window.__pearDB.call('canOpenLightning'),
  openLightning: (addr) => window.__pearDB.call('openLightning', addr),
  copyText: (text) => window.__pearDB.call('copyText', text),
  reclaimStorage: () => window.__pearDB.call('reclaimStorage'),
  storageBreakdown: () => window.__pearDB.call('storageBreakdown'),
  analyzeStorage: (opts) => window.__pearDB.call('analyzeStorage', opts),
  rebuildLocalDb: () => window.__pearDB.call('rebuildLocalDb'),
  rekeyGroup:   (id) => window.__pearDB.call('rekeyGroup', id),
  commitRekey:  (id) => window.__pearDB.call('commitRekey', id),
  purgeMigratedGroup:     (id, opts) => window.__pearDB.call('purgeMigratedGroup', id, opts),
  purgeAllMigratedGroups: (opts)     => window.__pearDB.call('purgeAllMigratedGroups', opts),
  auditStorage:           (opts)     => window.__pearDB.call('auditStorage', opts),
  purgeOrphanDataRanges:  (opts)     => window.__pearDB.call('purgeOrphanDataRanges', opts),
  transferOwnership: (groupId, targetProfileId) => window.__pearDB.call('transferOwnership', groupId, targetProfileId),
  claimOwnership:    (groupId)                  => window.__pearDB.call('claimOwnership', groupId),
}

// Avatar hash resolver with in-memory LRU cache (shared across the app).
// Records will carry `avatarHash` in place of inline base64 once dedup writes land;
// this read-both shim resolves either form.
const AVATAR_CACHE_MAX = 256
const _avatarCache = new Map()
const _avatarInflight = new Map()
window.__pearResolveAvatar = function (hash) {
  if (!hash) return Promise.resolve(null)
  if (_avatarCache.has(hash)) {
    const v = _avatarCache.get(hash)
    _avatarCache.delete(hash); _avatarCache.set(hash, v)
    return Promise.resolve(v)
  }
  if (_avatarInflight.has(hash)) return _avatarInflight.get(hash)
  const p = window.__pearDB.call('getAvatar', hash).then(data => {
    _avatarInflight.delete(hash)
    if (data == null) return null
    _avatarCache.set(hash, data)
    if (_avatarCache.size > AVATAR_CACHE_MAX) {
      const firstKey = _avatarCache.keys().next().value
      _avatarCache.delete(firstKey)
    }
    return data
  }).catch(() => { _avatarInflight.delete(hash); return null })
  _avatarInflight.set(hash, p)
  return p
}

window.__pearBuildReinviteLink = function(group, publicKey) { return buildReinviteLink(group, publicKey) }

// Light tactile feedback on every button tap. Capture phase, so it fires before
// any onClick that stops propagation, and every button — including ones added
// later — buzzes without per-handler wiring.
//
// A button carrying data-haptic fires its own stronger cue ('medium' for a
// destructive commit, 'success' on a completed copy) and opts out here, so a tap
// is one buzz and never two. Disabled buttons skip it: the visible action will
// not fire either, and a buzz would promise otherwise.
document.addEventListener('click', e => {
  const btn = e.target.closest?.('button')
  if (!btn || btn.disabled) return
  if (btn.dataset?.haptic) return
  window.__pearSync?.haptic('light')
}, true)

window.__pearEvent_handlers = window.__pearEvent_handlers || {}
const _origPearEvent = window.__pearEvent
window.__pearEvent = function(name, data) {
  if (name === 'canOpenLightning') {
    window.dispatchEvent(new CustomEvent('pear:canOpenLightning', { detail: data }))
    return
  }
  _origPearEvent?.(name, data)
}

window.__pearSetTab = function(tab) {
  window.dispatchEvent(new CustomEvent('pear:setTab', { detail: tab }))
}

window.__pearOpenGroupSettings = function(groupId) {
  window.dispatchEvent(new CustomEvent('pear:openGroupSettings', { detail: groupId }))
}

// Buffer invites that arrive before the App component has mounted its
// `pear:pendingJoin` listener. On iOS cold-open the native side can deliver
// the URL, RN can inject __pearHandleInvite, and the CustomEvent can fire
// before React has rendered <App> — without a buffer the event is lost.
const __pearInviteBuffer = []
window.__pearHandleInvite = function(url) {
  if (!url) return
  __pearInviteBuffer.push(url)
  window.dispatchEvent(new CustomEvent('pear:pendingJoin', { detail: url }))
}
window.__pearDrainInvites = function() {
  return __pearInviteBuffer.splice(0)
}

// pearcal://pair URLs go straight to bare's consumePairLink, NOT through the
// join-sheet flow — same split mobile does in app/index.tsx:434-439. The
// renderer only sees them if the host injects this function (Electron does;
// mobile bypasses it by calling consumePairLink on the worklet directly).
// Bare buffers calls until init resolves, so this is safe at cold launch.
window.__pearHandlePair = function(url) {
  if (!url || !window.__pearDB) return
  window.__pearDB.call('consumePairLink', url).catch(e => {
    console.warn('[pair] consumePairLink failed:', e?.message ?? e)
  })
}

const root = createRoot(document.getElementById('root'))
const _screenshotScene = window.__PEARCAL_SCREENSHOT_SCENE
if (_screenshotScene) {
  const fx = installFixtures(_screenshotScene)
  if (fx) {
    root.render(<App db={fx.db} notifs={fx.notifs} sync={fx.sync} />)
  } else {
    root.render(<App db={db} notifs={notifs} sync={sync} />)
  }
} else {
  root.render(<App db={db} notifs={notifs} sync={sync} />)
}
