// PearCal blind seeder — seed-mode worklet entry (proposal
// 2026-07-15-pearcal-seeder-port, Phase 2 skeleton).
//
// A SEPARATE bare entry (bundled via `bare-pack src/seed.js`) from the member
// app (`src/bare.js`). It replicates encrypted group Autobase blocks for groups
// it has been enrolled in, WITHOUT ever holding a group's encryptionKey — it can
// store + serve ciphertext but never read it (blindness; see the member-side
// per-group encryption in bare.js). It is deployed on an always-on machine
// (Linux/Umbrel/Mac) via the seeder-launcher.
//
// Phase 2 (this file): boot, storage, seeder identity, enrolled-groups
// persistence, `seeder:status` IPC, and idle. Replication of enrolled groups is
// Phase 3; seed-invite admission is Phase 4.
//
// Persistence (own local Hyperbee, seed-scoped keys):
//   identity:seeder          — seeder Ed25519 keypair (one per seeder device)
//   seeder:enrolled:{groupId}— per-group enrollment { groupId, groupKey, name,
//                              inviter, enrolledAt }; consumed by mount in Phase 3

const Hypercore = require('hypercore')
const Hyperbee = require('hyperbee')
const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const sodium = require('sodium-native')
const b4a = require('b4a')
const { parseSeedInvite } = require('./lib/seedInvite.js')

// ── IPC transport ───────────────────────────────────────────────────────────
// The seeder speaks the same JSON-newline envelope over whichever duplex the
// host provides, in priority order:
//   1. BareKit.IPC          — mobile shell (not used for the seeder, kept for parity)
//   2. Pear.worker.pipe()   — Pear worker
//   3. bare-process stdio   — standalone `bare seed.bundle` spawned by the launcher.
//      Outbound MUST be a synchronous fd-1 write: bare's piped stdout buffers
//      until exit and would deadlock the launcher's init handshake otherwise
//      (mirrors PearCircle bare.js).
//   4. node stdin/stdout    — `node src/seed.js` spawned by the dev launcher / tests.
// A direct `node src/seed.js --seed --data <dir>` boots headless (no host) — see
// the CLI section at the bottom.
let ipc = null
let send = () => {}
function setupTransport () {
  if (typeof BareKit !== 'undefined' && BareKit && BareKit.IPC) {
    ipc = BareKit.IPC
    send = (msg) => BareKit.IPC.write(Buffer.from(JSON.stringify(msg) + '\n'))
  } else if (typeof Pear !== 'undefined' && Pear.worker) {
    const p = Pear.worker.pipe()
    ipc = p
    send = (msg) => p.write(Buffer.from(JSON.stringify(msg) + '\n'))
  } else if (typeof Bare !== 'undefined') {
    const bp = require('bare-process')
    const bfs = require('bare-fs')
    ipc = bp.stdin
    send = (msg) => bfs.writeSync(1, Buffer.from(JSON.stringify(msg) + '\n'))
  } else if (typeof process !== 'undefined' && process.stdin && process.stdout) {
    ipc = process.stdin
    send = (msg) => process.stdout.write(Buffer.from(JSON.stringify(msg) + '\n'))
  }
}

// ── State ─────────────────────────────────────────────────────────────────────
let db = null
let store = null
let swarm = null
let identity = null
let dataDir = null
let _booted = false
const bootTs = _now()
const enrolled = new Map() // groupId -> enrollment row
const mounted = new Map()  // groupId -> { core, writerCores: Map<hex,core>, topicHex }

// Must byte-match src/bare.js's writer-announce channel so members announce
// their Autobase writer cores to us (we can't read the encrypted view to find
// them ourselves). We only LISTEN — the seeder never announces a writer.
const WRITER_ANNOUNCE_PROTOCOL = 'pearcal/writer-announce'
const WRITER_ANNOUNCE_ID = Buffer.from('pearcal-writer-announce-v1')

// Topic for an enrolled group. Seeded groups are ENCRYPTED, so this must match
// bare.js groupSwarmTopic()'s encrypted branch (domain-separated blake2b) — old
// code joins the plain groupKey topic and never meets the seeder or members.
function topicForGroupKey (groupKey) {
  const out = b4a.alloc(32)
  sodium.crypto_generichash(out, b4a.concat([b4a.from('pearcal-enc-topic-v1:'), b4a.from(groupKey, 'hex')]))
  return out
}

// Date.now() is unavailable in some bare sandboxes at module init; guard it.
function _now () { try { return Date.now() } catch { return 0 } }

// ── Seed mode detection ─────────────────────────────────────────────────────
// True in `--seed` argv (launcher / CLI) or when init passes { mode: 'seed' }.
function detectSeedMode (input) {
  if (Array.isArray(input)) return input.includes('--seed')
  if (input && typeof input === 'object' && input.mode === 'seed') return true
  return false
}

// ── Seeder identity ─────────────────────────────────────────────────────────
function _seederKeypair () {
  const publicKey = b4a.alloc(sodium.crypto_sign_PUBLICKEYBYTES)
  const secretKey = b4a.alloc(sodium.crypto_sign_SECRETKEYBYTES)
  sodium.crypto_sign_keypair(publicKey, secretKey)
  return { publicKey, secretKey }
}

async function loadOrCreateSeederIdentity () {
  const stored = await db.get('identity:seeder').catch(() => null)
  if (stored?.value) {
    return {
      publicKey: b4a.from(stored.value.publicKey, 'hex'),
      secretKey: b4a.from(stored.value.secretKey, 'hex'),
      fresh: false,
    }
  }
  const kp = _seederKeypair()
  await db.put('identity:seeder', {
    publicKey: b4a.toString(kp.publicKey, 'hex'),
    secretKey: b4a.toString(kp.secretKey, 'hex'),
    createdAt: _now(),
  })
  return { publicKey: kp.publicKey, secretKey: kp.secretKey, fresh: true }
}

// ── Enrolled-groups persistence ─────────────────────────────────────────────
async function loadEnrolledGroups () {
  enrolled.clear()
  try {
    for await (const { value } of db.createReadStream({ gt: 'seeder:enrolled:', lt: 'seeder:enrolled:~' })) {
      if (value && value.groupId) enrolled.set(value.groupId, value)
    }
  } catch (e) { console.warn('[seed] loadEnrolledGroups error:', e?.message) }
}

// ── Blind replication core ──────────────────────────────────────────────────
// Mount an enrolled group: open its bootstrap core BLIND (no encryptionKey),
// force a full background download so we hold every block — Hypercore
// replication is otherwise reactive/sparse and a fresh peer syncing FROM us
// would find nothing — and join the group's swarm topic. Writer cores are added
// as members announce them (onWriterAnnounce).
async function mountGroup (enrollment) {
  const { groupId, groupKey } = enrollment || {}
  if (!groupId || !groupKey || !/^[0-9a-f]{64}$/i.test(groupKey)) return null
  if (mounted.has(groupId)) return mounted.get(groupId)
  const core = store.get({ key: b4a.from(groupKey, 'hex') })
  await core.ready()
  core.download({ start: 0, end: -1, linear: false })
  const topicHex = b4a.toString(topicForGroupKey(groupKey), 'hex')
  swarm.join(b4a.from(topicHex, 'hex'), { server: true, client: true })
  const entry = { core, writerCores: new Map(), topicHex }
  mounted.set(groupId, entry)
  console.log('[seed] mounted group', groupId, '— topic', topicHex.slice(0, 12) + '…')
  return entry
}

// Open the writer-announce channel on a replication stream (byte-identical to
// bare.js) and replicate every writer core a member announces for a group we
// host. We only LISTEN — the seeder never announces a writer of its own.
async function setupWriterAnnounceListener (stream) {
  try { await stream.noiseStream.opened } catch { return }
  const mux = stream.noiseStream.userData
  if (!mux) return
  const channel = mux.createChannel({
    protocol: WRITER_ANNOUNCE_PROTOCOL,
    id: WRITER_ANNOUNCE_ID,
    onopen () {},
    onclose () {},
  })
  if (!channel) return
  channel.addMessage({ onmessage: (buf) => { onWriterAnnounce(buf).catch(() => {}) } })
  channel.open()
}

// A member announced { groupId, writerKey, ... }. If we host that group and
// don't already replicate this writer core, open it blind and download it in
// full. We hold ciphertext only — no encryptionKey, so we can never read it.
async function onWriterAnnounce (buf) {
  let parsed
  try { parsed = JSON.parse(buf.toString()) } catch { return }
  const groupId = parsed?.groupId
  const writerKey = parsed?.writerKey
  if (!groupId || !writerKey || !/^[0-9a-f]{64}$/i.test(writerKey)) return
  const entry = mounted.get(groupId)
  if (!entry || entry.writerCores.has(writerKey)) return
  const core = store.get({ key: b4a.from(writerKey, 'hex') })
  await core.ready()
  core.download({ start: 0, end: -1, linear: false })
  entry.writerCores.set(writerKey, core)
  console.log('[seed] +writer core', writerKey.slice(0, 12) + '…', 'for group', groupId)
}

// ── Admission (seed invites) ─────────────────────────────────────────────────
// Consume ONE /seed invite: parse (rejects member /join + strips any enc),
// persist the enrollment row, and mount the group. Idempotent — a re-enroll of
// an already-known group just ensures it's mounted.
async function enrollSeedInvite (invite) {
  if (typeof invite !== 'string' || invite.length === 0) throw new Error('invite must be a non-empty string')
  const parsed = parseSeedInvite(invite)
  if (!parsed.ok) throw new Error('invalid seed invite: ' + (parsed.error ?? 'unknown'))
  const { groupId, groupName, groupKey } = parsed
  const existing = await db.get('seeder:enrolled:' + groupId).catch(() => null)
  if (existing?.value) {
    if (!mounted.has(groupId)) await mountGroup(existing.value).catch(() => {})
    return { ok: true, groupId, name: existing.value.name ?? groupName, alreadyEnrolled: true }
  }
  // Franken guard: the same groupKey enrolled under a DIFFERENT groupId is
  // malformed (one group's id glued onto another's key). A blind seeder can't
  // read the view to verify the id, but groupKey is unique per group, so refuse.
  try {
    for await (const { value } of db.createReadStream({ gt: 'seeder:enrolled:', lt: 'seeder:enrolled:~' })) {
      if (value && value.groupKey === groupKey && value.groupId !== groupId) {
        throw new Error('franken seed invite: groupKey already enrolled under group ' + value.groupId)
      }
    }
  } catch (e) { if (/franken/.test(e.message)) throw e }
  const row = { groupId, groupKey, name: groupName, inviter: parsed.inviterKey, enrolledAt: _now() }
  await db.put('seeder:enrolled:' + groupId, row)
  enrolled.set(groupId, row)
  try {
    await mountGroup(row)
  } catch (e) {
    await db.del('seeder:enrolled:' + groupId).catch(() => {})
    enrolled.delete(groupId)
    throw new Error('seeder mount failed: ' + (e?.message ?? String(e)))
  }
  return { ok: true, groupId, name: groupName, alreadyEnrolled: false }
}

// Consume an all-groups bundle (newline-joined /seed invites). Per-line result
// so one bad line doesn't abort the rest.
async function enrollSeedBundle (bundle) {
  const results = []
  for (const line of String(bundle).split(/[\r\n]+/).map(s => s.trim()).filter(Boolean)) {
    try { results.push(await enrollSeedInvite(line)) }
    catch (e) { results.push({ ok: false, error: e?.message ?? String(e) }) }
  }
  return { ok: true, results }
}

// Reverse of enroll: leave the topic, close the cores, drop the enrollment.
async function leaveSeedGroup (groupId) {
  if (!groupId) throw new Error('seeder:leave requires a groupId')
  const entry = mounted.get(groupId)
  if (entry) {
    try { swarm.leave(b4a.from(entry.topicHex, 'hex')).catch(() => {}) } catch {}
    try { await entry.core.close() } catch {}
    for (const c of entry.writerCores.values()) { try { await c.close() } catch {} }
    mounted.delete(groupId)
  }
  await db.del('seeder:enrolled:' + groupId).catch(() => {})
  enrolled.delete(groupId)
  console.log('[seed] left group', groupId)
  return { ok: true, groupId }
}

// ── Boot ────────────────────────────────────────────────────────────────────
async function init (dir) {
  if (_booted) return { ok: true, alreadyBooted: true }
  dataDir = dir
  const core = new Hypercore(dataDir + '/core', { valueEncoding: 'json' })
  await core.ready()
  db = new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'json' })
  await db.ready()

  store = new Corestore(dataDir + '/store')
  await store.ready()

  swarm = new Hyperswarm()
  // Blind replication: replicate the whole corestore to any connected peer, and
  // open the writer-announce channel so members tell us their writer cores.
  swarm.on('connection', (conn) => {
    const s = store.replicate(conn)
    s.on('error', () => {})
    conn.on('error', () => {})
    setupWriterAnnounceListener(s)
  })

  identity = await loadOrCreateSeederIdentity()
  await loadEnrolledGroups()
  for (const enr of enrolled.values()) {
    await mountGroup(enr).catch((e) => console.warn('[seed] mount error', enr.groupId, e?.message))
  }
  _booted = true
  console.log('[seed] booted — pubkey', b4a.toString(identity.publicKey, 'hex').slice(0, 16) + '…',
              '| enrolled groups:', enrolled.size,
              '| identity', identity.fresh ? 'created' : 'loaded')
  return { ok: true, pubkey: b4a.toString(identity.publicKey, 'hex'), enrolled: enrolled.size }
}

// ── IPC surface (seed-only) ─────────────────────────────────────────────────
async function handle (method, args) {
  switch (method) {
    case 'init': {
      const a = args
      const dir = typeof a === 'string' ? a
        : (a?.dataDir ?? (Array.isArray(a) ? (a[0]?.dataDir ?? a[0]) : null))
      return init(dir)
    }
    case 'seeder:status':
      return {
        pubkey: identity ? b4a.toString(identity.publicKey, 'hex') : null,
        booted: _booted,
        uptime: _now() - bootTs,
        enrolled: enrolled.size,
        mounted: mounted.size,
      }
    case 'seeder:enrolled:list':
      return [...enrolled.values()]
    case 'seeder:enroll': {
      const a = args
      const invite = typeof a === 'string' ? a
        : (a?.invite ?? (Array.isArray(a) ? (a[0]?.invite ?? a[0]) : null))
      if (typeof invite !== 'string' || !invite) throw new Error('seeder:enroll requires an invite string')
      return /[\r\n]/.test(invite) ? enrollSeedBundle(invite) : enrollSeedInvite(invite)
    }
    case 'seeder:leave': {
      const a = args
      const groupId = typeof a === 'string' ? a
        : (a?.groupId ?? (Array.isArray(a) ? a[0] : null))
      return leaveSeedGroup(groupId)
    }
    default:
      throw new Error('Unknown seed method: ' + method)
  }
}

async function dispatch (method, args, id) {
  try {
    const result = await handle(method, args ?? [])
    send({ type: 'response', id, result })
  } catch (e) {
    console.error('[seed] dispatch error:', method, e?.message)
    send({ type: 'response', id, error: e?.message ?? String(e) })
  }
}

function attachReader () {
  if (!ipc) return
  let buf = ''
  ipc.on('data', (chunk) => {
    buf += chunk.toString()
    let nl
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (!line) continue
      try {
        const msg = JSON.parse(line)
        dispatch(msg.method, msg.args ?? [], msg.id)
      } catch (e) { console.error('[seed] IPC parse error:', e?.message) }
    }
  })
  if (typeof ipc.resume === 'function') ipc.resume()
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
const _argv = (typeof Bare !== 'undefined' && Bare.argv) ? Bare.argv
  : (typeof process !== 'undefined' && process.argv) ? process.argv : []
if (typeof BareKit !== 'undefined' || typeof Pear !== 'undefined') {
  // Mobile / Pear host drives us via IPC (waits for init).
  setupTransport()
  attachReader()
} else if (detectSeedMode(_argv)) {
  const di = _argv.indexOf('--data')
  const dir = di !== -1 ? _argv[di + 1] : null
  if (dir) {
    // Direct headless boot — no host (CLI testing). Boots immediately and idles.
    init(dir)
      .then(r => console.log('[seed] headless boot:', JSON.stringify(r)))
      .catch(e => { console.error('[seed] headless boot failed:', e?.message); if (typeof process !== 'undefined') process.exitCode = 1 })
    setInterval(() => {}, 1 << 30)
  } else {
    // Launcher-driven: bridge to stdio (bare-process or node) and wait for init.
    setupTransport()
    attachReader()
  }
}

module.exports = {
  detectSeedMode, loadOrCreateSeederIdentity, loadEnrolledGroups, init, handle,
  mountGroup, onWriterAnnounce, topicForGroupKey,
  enrollSeedInvite, enrollSeedBundle, leaveSeedGroup,
  // Test/introspection accessors.
  _state: () => ({ enrolled, mounted, identity, store: () => store, swarm: () => swarm }),
}
