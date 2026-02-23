const Hypercore = require('hypercore')
const Hyperbee = require('hyperbee')
const sodium = require('sodium-native')
const b4a = require('b4a')

const send = (msg) => BareKit.IPC.write(Buffer.from(JSON.stringify(msg) + '\n'))

let db = null
let buf = ''

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
    } catch(e) {}
  }
})

async function dispatch (method, args, id) {
  try {
    const result = await handle(method, args)
    send({ type: 'response', id, result })
  } catch(e) {
    send({ type: 'response', id, error: e.message })
  }
}

async function handle (method, args) {
  switch (method) {
    case 'ping': return 'pong'
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
    case 'scheduleForEvent': return null
    case 'cancelForEvent':   return null
    case 'restoreAll':       return null
    case 'joinGroup':        return null
    case 'leaveGroup':       return null
    case 'putEvent:sync':    return null
    case 'deleteEvent:sync': return null
    case 'putGroup:sync':    return null
    default: throw new Error('Unknown method: ' + method)
  }
}

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

async function listEvents (opts) { opts = opts || {}
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

async function init (dataDir) {
  try {
    console.log('Init DB at', dataDir)
    const core = new Hypercore(dataDir + '/core', { valueEncoding: 'json' })
    await core.ready()
    db = new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'json' })
    await db.ready()

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

    console.log('DB ready')
    send({ type: 'event', event: 'ready' })
  } catch(e) {
    console.error('Init failed:', e.message)
    send({ type: 'event', event: 'error', data: e.message })
  }
}

send({ type: 'event', event: 'bareReady' })
