import { handleInviteLink } from '../invite.js'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'

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

const db = {
  getProfile:    ()          => window.__pearDB.call('getProfile'),
  updateProfile: (u)         => window.__pearDB.call('updateProfile', u),
  listEvents:    (opts)      => window.__pearDB.call('listEvents', opts),
  putEvent:      (ev)        => window.__pearDB.call('putEvent', ev),
  deleteEvent:   (d, id)     => window.__pearDB.call('deleteEvent', d, id),
  getGroup:      (id)        => window.__pearDB.call('getGroup', id),
  listGroups:    ()          => window.__pearDB.call('listGroups'),
  putGroup:      (g)         => window.__pearDB.call('putGroup', g),
  deleteGroup:   (id)        => window.__pearDB.call('deleteGroup', id),
  listMembers:   (gid)       => window.__pearDB.call('listMembers', gid),
  putMember:     (gid, m)    => window.__pearDB.call('putMember', gid, m),
  removeMember:  (gid, mid)  => window.__pearDB.call('removeMember', gid, mid),
}

const notifs = {
  scheduleForEvent: (ev) => window.__pearDB.call('scheduleForEvent', ev),
  cancelForEvent:   (id) => window.__pearDB.call('cancelForEvent', id),
  restoreAll:       ()   => window.__pearDB.call('restoreAll'),
}

const sync = {
  joinGroup:   (g)          => window.__pearDB.call('joinGroup', g),
  leaveGroup:  (id)         => window.__pearDB.call('leaveGroup', id),
  putEvent:    (gid, ev)    => window.__pearDB.call('putEvent:sync', gid, ev),
  deleteEvent: (gid, id, d) => window.__pearDB.call('deleteEvent:sync', gid, id, d),
  putGroup:    (g)          => window.__pearDB.call('putGroup:sync', g),
}

window.__pearHandleInvite = async function(url) {
  console.log('__pearHandleInvite called:', url)
  handleInviteLink(url, db, sync, group => {
    emitter.emit('group:joined', group)
  })
}

const root = createRoot(document.getElementById('root'))
root.render(<App db={db} notifs={notifs} sync={sync} />)
