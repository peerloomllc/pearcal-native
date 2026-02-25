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
    case 'listGroups':       return listGroups()
    case 'putGroup':         return putGroup(args[0])
    case 'deleteGroup':      return deleteGroup(args[0])
    case 'listMembers':      return listMembers(args[0])
    case 'putMember':        return putMember(args[0], args[1])
    case 'removeMember':     return removeMember(args[0], args[1])
    case 'joinGroup':        return joinGroup(args[0])
    case 'leaveGroup':       return leaveGroup(args[0])
    case 'putEvent:sync':    return syncPutEvent(args[0], args[1])
    case 'deleteEvent:sync': return syncDeleteEvent(args[0], args[1], args[2])
    case 'putGroup:sync':    return syncPutGroup(args[0])
    // Notifications handled on RN side
    case 'scheduleForEvent': return null
    case 'cancelForEvent':   return null
    case 'restoreAll':       return null
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
  for await (const { key } of db.createReadStream({ gt: NS.members + id, lt: NS.members + id + '\xff' })) {
    await db.del(key)
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

async function joinGroup (group) {
  if (bases.has(group.id)) return

  console.log('Joining group swarm:', group.id)

  const bootstrap = b4a.from(group.groupKey, 'hex')
  const groupStore = store.namespace(group.id)

  const base = new Autobase(groupStore, bootstrap, {
    valueEncoding: 'json',
    open: (s) => new Hyperbee(s.get('view'), { keyEncoding: 'utf-8', valueEncoding: 'json' }),
    apply: makeApply(group.id),
    ackInterval: 1000,
  })
  await base.ready()
  console.log("Autobase key:", b4a.toString(base.key, "hex"), "bootstrap:", group.groupKey)
  bases.set(group.id, base)

  // Announce on Hyperswarm using group key as topic
  const topic = b4a.from(group.groupKey.slice(0, 64).padEnd(64, '0'), 'hex')
  swarm.join(topic, { server: true, client: true })

  console.log('Joined group:', group.id)
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
  await base.append({ op: 'put', type: 'event', key: 'events:' + event.date + ':' + event.id, value: event })
}

async function syncDeleteEvent (groupId, eventId, date) {
  const base = bases.get(groupId)
  if (!base) throw new Error('Not in group: ' + groupId)
  await base.append({ op: 'del', type: 'event', key: 'events:' + date + ':' + eventId })
}

async function syncPutGroup (group) {
  const base = bases.get(group.id)
  if (!base) throw new Error('Not in group: ' + group.id)
  await base.append({ op: 'put', type: 'group', key: 'groups:' + group.id, value: group })
}

function makeApply (groupId) {
  return async function apply (nodes, view, host) {
    for (const node of nodes) {
      const val = node.value
      if (!val) continue

      // Writer announcement — add them as a writer
      if (val.addWriter) {
        await host.addWriter(b4a.from(val.addWriter, 'hex'), { indexer: true })
        continue
      }

      // Write to the shared Autobase view
      if (val.op === 'put') {
        await view.put(val.key, val.value)
        // Also mirror to local Hyperbee so UI sees it immediately
        await mirrorToLocal(val.type, val.key, val.value, groupId)
      } else if (val.op === 'del') {
        await view.del(val.key)
        await deleteFromLocal(val.type, val.key)
      }
    }
  }
}

async function mirrorToLocal (type, key, value, groupId) {
  try {
    if (type === 'event') {
      await db.put(key, { ...value, updatedAt: Date.now() })
    } else if (type === 'group') {
      await db.put(key, { ...value, updatedAt: Date.now() })
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

async function init (dir) {
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
      console.log('Swarm connection from peer')
      store.replicate(conn)
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
        avatar:    '',
        publicKey: b4a.toString(pk, 'hex'),
        secretKey: b4a.toString(sk, 'hex'),
        createdAt: Date.now(),
      })
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
    send({ type: 'event', event: 'error', data: e.message })
  }
}

send({ type: 'event', event: 'bareReady' })
