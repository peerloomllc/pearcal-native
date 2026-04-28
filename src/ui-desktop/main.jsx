// Desktop renderer entry. Mirrors src/ui/main.jsx for IPC bridge
// setup, but mounts the desktop App component (Apple-Calendar-shaped
// sidebar + grid layout) instead of the mobile-shaped tree.
//
// Most setup is identical to mobile because the IPC contract is
// platform-agnostic — preload.js wires window.ReactNativeWebView.
// postMessage to ipcMain bare-call, and the main-side electron
// shell-handlers intercept the same method names mobile's RN shell
// intercepts. Both renderers see the same db/notifs/sync surface.

import { handleInviteLink, buildReinviteLink } from '../invite.js'
import { createRoot } from 'react-dom/client'
import { emitter } from '../ui-shared/index.js'
import App from './App.jsx'

// IPC bridge — same shape as mobile main.jsx. The Electron preload
// already pre-wires window.ReactNativeWebView.postMessage, so the
// `if (!window.__pearDB)` branch fires here too — main.jsx-style
// bridge sits on top of preload's postMessage.
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

window.addEventListener('pear:sync', e => emitter.emit('sync', e.detail))
window.addEventListener('pear:cameraResult', e => emitter.emit('cameraResult', e.detail))
window.addEventListener('pear:groupKeyUpdated', e => emitter.emit('groupKeyUpdated', e.detail))
window.addEventListener('pear:groupDeleted', e => emitter.emit('groupDeleted', e.detail))
window.addEventListener('pear:inviteBlocked', (e) => { emitter.emit('groupDeleted', e.detail); emitter.emit('inviteBlocked') })
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
  getBlindPeerKey:    ()  => window.__pearDB.call('getBlindPeerKey'),
  setBlindPeerKey:    (k) => window.__pearDB.call('setBlindPeerKey', k),
  removeBlindPeerKey: ()  => window.__pearDB.call('removeBlindPeerKey'),
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

const notifs = {
  scheduleForEvent: (ev, reminders) => window.__pearDB.call('scheduleForEvent', ev, reminders),
  cancelForEvent:   (id) => window.__pearDB.call('cancelForEvent', id),
  restoreAll:       ()   => window.__pearDB.call('restoreAll'),
}

const sync = {
  createGroup: (name, meta) => window.__pearDB.call('createGroup', name, meta),
  joinGroup:   (g)          => window.__pearDB.call('joinGroup', g),
  leaveGroup:  (id)         => window.__pearDB.call('leaveGroup', id),
  deleteGroup: (id)         => window.__pearDB.call('deleteGroup:sync', id),
  putEvent:    (gid, ev)    => window.__pearDB.call('putEvent:sync', gid, ev),
  deleteEvent: (gid, id, d, who, whoId, rid, evTitle) => window.__pearDB.call('deleteEvent:sync', gid, id, d, who, whoId, rid, evTitle),
  putGroup:    (g)          => window.__pearDB.call('putGroup:sync', g),
  memberLeft:  (groupId, memberId) => window.__pearDB.call('memberLeft:sync', groupId, memberId),
  purgeMember: (groupId, memberId) => window.__pearDB.call('purgeMember:sync', groupId, memberId),
  nativeShare: (title, text) => window.__pearDB.call('nativeShare', title, text),
  exportIcs: (content) => window.__pearDB.call('exportIcs', content),
  exportRecoveryPhrase: (content) => window.__pearDB.call('exportRecoveryPhrase', content),
  takePhoto: () => window.__pearDB.call('takePhoto'),
  openURL: (url) => window.__pearDB.call('openURL', url),
}

window.__pearBuildReinviteLink = function(group, publicKey) { return buildReinviteLink(group, publicKey) }

// Deep link — pair URLs go straight to bare's consumePairLink, join URLs
// surface as a CustomEvent the App can pick up. Same split mobile uses
// in app/index.tsx:434-439 (electron's main process branches the URL
// before injecting __pearHandleInvite vs __pearHandlePair).
window.__pearHandleInvite = function(url) {
  if (!url) return
  window.dispatchEvent(new CustomEvent('pear:pendingJoin', { detail: url }))
}
window.__pearHandlePair = function(url) {
  if (!url || !window.__pearDB) return
  window.__pearDB.call('consumePairLink', url).catch(e => {
    console.warn('[pair] consumePairLink failed:', e?.message ?? e)
  })
}

const root = createRoot(document.getElementById('root'))
root.render(<App db={db} notifs={notifs} sync={sync} />)
