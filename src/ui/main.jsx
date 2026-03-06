import { handleInviteLink, buildReinviteLink } from '../invite.js'
import { createRoot } from 'react-dom/client'
import App, { emitter } from './App.jsx'

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
window.addEventListener('pear:groupKeyUpdated', e => emitter.emit('groupKeyUpdated', e.detail))
window.addEventListener('pear:groupDeleted', e => emitter.emit('groupDeleted', e.detail))
window.addEventListener('pear:inviteBlocked', (e) => { emitter.emit('groupDeleted', e.detail); emitter.emit('inviteBlocked') })

const db = {
  getProfile:    ()          => window.__pearDB.call('getProfile'),
  updateProfile: (u)         => window.__pearDB.call('updateProfile', u),
  listEvents:    (opts)      => window.__pearDB.call('listEvents', opts),
  putEvent:      (ev)        => window.__pearDB.call('putEvent', ev),
  deleteEvent:   (d, id)     => window.__pearDB.call('deleteEvent', d, id),
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
}

const notifs = {
  scheduleForEvent: (ev) => window.__pearDB.call('scheduleForEvent', ev),
  cancelForEvent:   (id) => window.__pearDB.call('cancelForEvent', id),
  restoreAll:       ()   => window.__pearDB.call('restoreAll'),
}

const sync = {
  joinGroup:   (g)          => window.__pearDB.call('joinGroup', g),
  leaveGroup:  (id)         => window.__pearDB.call('leaveGroup', id),
  deleteGroup: (id)         => window.__pearDB.call('deleteGroup:sync', id),
  putEvent:    (gid, ev)    => window.__pearDB.call('putEvent:sync', gid, ev),
  deleteEvent: (gid, id, d, who) => window.__pearDB.call('deleteEvent:sync', gid, id, d, who),
  putGroup:    (g)          => window.__pearDB.call('putGroup:sync', g),
  memberLeft:  (groupId, memberId) => window.__pearDB.call('memberLeft:sync', groupId, memberId),
  nativeShare: (title, text) => window.__pearDB.call('nativeShare', title, text),
  qrScan: () => window.__pearDB.call('qrScan'),
}

window.__pearBuildReinviteLink = function(group, publicKey) { return buildReinviteLink(group, publicKey) }

window.__pearSetTab = function(tab) {
  window.dispatchEvent(new CustomEvent('pear:setTab', { detail: tab }))
}

window.__pearHandleInvite = async function(url) {
  const result = await handleInviteLink(url, db, sync, group => {
    window.dispatchEvent(new CustomEvent('pear:groupJoined', { detail: group }))
  })
  if (result && (result.ok || result.error === 'already_member') && result.group) {
    window.dispatchEvent(new CustomEvent('pear:groupJoined', { detail: result.group }))
  }
  if (result && result.error === 'blocked_from_group') {
    window.dispatchEvent(new CustomEvent('pear:inviteBlocked', {}))
  }
}

const root = createRoot(document.getElementById('root'))
root.render(<App db={db} notifs={notifs} sync={sync} />)
