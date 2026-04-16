import { handleInviteLink, buildReinviteLink } from '../invite.js'
import { createRoot } from 'react-dom/client'
import App, { emitter } from './App.jsx'
import { installFixtures } from './screenshot-fixtures.js'

// IPC bridge
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

// Bridge CustomEvents → emitter so App.jsx sync/groupKeyUpdated handlers fire
window.addEventListener('pear:sync', e => emitter.emit('sync', e.detail))
window.addEventListener('pear:qrScanResult', e => emitter.emit('qrScanResult', e.detail))
window.addEventListener('pear:cameraResult', e => emitter.emit('cameraResult', e.detail))
window.addEventListener('pear:groupKeyUpdated', e => emitter.emit('groupKeyUpdated', e.detail))
window.addEventListener('pear:groupDeleted', e => emitter.emit('groupDeleted', e.detail))
window.addEventListener('pear:inviteBlocked', (e) => { emitter.emit('groupDeleted', e.detail); emitter.emit('inviteBlocked') })

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
  isBlockedFromGroup: (id)   => window.__pearDB.call('isBlockedFromGroup', id),
  clearBlockedFromGroup: (id) => window.__pearDB.call('clearBlockedFromGroup', id),
  reinviteMember: (gid, mid) => window.__pearDB.call('reinviteMember', gid, mid),
  listMembers:   (gid)       => window.__pearDB.call('listMembers', gid),
  putMember:     (gid, m)    => window.__pearDB.call('putMember', gid, m),
  removeMember:  (gid, mid)  => window.__pearDB.call('removeMember', gid, mid),
  resyncGroup:   (groupId)   => window.__pearDB.call('resyncGroup', groupId),
  setMemberNickname: (groupId, nick) => window.__pearDB.call('setMemberNickname', groupId, nick),
  getReminders:  (id)     => window.__pearDB.call('getReminders', id),
  putReminders:  (id, r)  => window.__pearDB.call('putReminders', id, r),
  getRsvp:       (eid, mid)       => window.__pearDB.call('getRsvp', eid, mid),
  listRsvps:     (eid)            => window.__pearDB.call('listRsvps', eid),
  listMyRsvps:   ()               => window.__pearDB.call('listMyRsvps'),
  putRsvp:       (eid, mid, s, gids) => window.__pearDB.call('putRsvp', eid, mid, s, gids),
  getPrivateNote: (id)       => window.__pearDB.call('getPrivateNote', id),
  putPrivateNote: (id, text) => window.__pearDB.call('putPrivateNote', id, text),
  getBlindPeerKey:    ()  => window.__pearDB.call('getBlindPeerKey'),
  setBlindPeerKey:    (k) => window.__pearDB.call('setBlindPeerKey', k),
  removeBlindPeerKey: ()  => window.__pearDB.call('removeBlindPeerKey'),
}

const notifs = {
  scheduleForEvent: (ev, reminders) => window.__pearDB.call('scheduleForEvent', ev, reminders),
  cancelForEvent:   (id) => window.__pearDB.call('cancelForEvent', id),
  restoreAll:       ()   => window.__pearDB.call('restoreAll'),
}

const sync = {
  joinGroup:   (g)          => window.__pearDB.call('joinGroup', g),
  leaveGroup:  (id)         => window.__pearDB.call('leaveGroup', id),
  deleteGroup: (id)         => window.__pearDB.call('deleteGroup:sync', id),
  putEvent:    (gid, ev)    => window.__pearDB.call('putEvent:sync', gid, ev),
  deleteEvent: (gid, id, d, who, whoId, rid, evTitle) => window.__pearDB.call('deleteEvent:sync', gid, id, d, who, whoId, rid, evTitle),
  putGroup:    (g)          => window.__pearDB.call('putGroup:sync', g),
  memberLeft:  (groupId, memberId) => window.__pearDB.call('memberLeft:sync', groupId, memberId),
  purgeMember: (groupId, memberId) => window.__pearDB.call('purgeMember:sync', groupId, memberId),
  debugGroup: (id) => window.__pearDB.call('debugGroup', id),
  nativeShare: (title, text) => window.__pearDB.call('nativeShare', title, text),
  exportIcs: (content) => window.__pearDB.call('exportIcs', content),
  qrScan: () => window.__pearDB.call('qrScan'),
  takePhoto: () => window.__pearDB.call('takePhoto'),
  haptic: (style) => window.__pearDB.call('haptic', style),
  openURL: (url) => window.__pearDB.call('openURL', url),
  canOpenLightning: () => window.__pearDB.call('canOpenLightning'),
  openLightning: (addr) => window.__pearDB.call('openLightning', addr),
  reclaimStorage: () => window.__pearDB.call('reclaimStorage'),
  storageBreakdown: () => window.__pearDB.call('storageBreakdown'),
  analyzeStorage: (opts) => window.__pearDB.call('analyzeStorage', opts),
  rebuildLocalDb: () => window.__pearDB.call('rebuildLocalDb'),
  rekeyGroup:   (id) => window.__pearDB.call('rekeyGroup', id),
  commitRekey:  (id) => window.__pearDB.call('commitRekey', id),
}

// Avatar hash resolver with in-memory LRU cache (shared across the app).
// Records will carry `avatarHash` in place of inline base64 once dedup writes land;
// this read-both shim resolves either form.
const AVATAR_CACHE_MAX = 64
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

// Global haptic on all button taps
document.addEventListener('click', e => {
  if (e.target.closest('button')) {
    window.__pearSync?.haptic('light')
  }
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
