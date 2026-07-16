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
const { buildSeederPairLink } = require('./lib/seederPairLink.js')
const { generateRendezvousKey, seederPairTopic } = require('./lib/seederPairTopic.js')
const { setupSeederPairChannel, SEEDER_PAIR_PROTOCOL } = require('./lib/seederPair.js')

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

// ── Seeder QR pairing (proposal 2026-07-15-pearcal-seeder-port, QR-pairing
// model). The seeder shows a QR = one-time rendezvous topic + its pubkey; the
// phone scans it, joins the rendezvous, verifies our pubkey, and pushes its seed
// bundle over a one-time pearcal/seeder-pair/1 channel. No copy-paste.
const SEEDER_PAIR_TTL_MS = 5 * 60 * 1000 // rendezvous lifetime
let _pairSession = null   // { rv, topic, topicHex, ttlTimer }
const _activeMuxes = new Set() // live replication muxers, for opening the pair channel

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

// Blind-safe per-group metrics from the mounted cores: total bytes held, opaque
// block count (NOT events — we can't decrypt), and writer-core count. Zero if
// the group isn't mounted yet.
function _groupMetrics (groupId) {
  const m = mounted.get(groupId)
  if (!m) return { bytes: 0, blocks: 0, writers: 0 }
  let bytes = m.core?.byteLength || 0
  let blocks = m.core?.length || 0
  for (const c of m.writerCores.values()) { bytes += c?.byteLength || 0; blocks += c?.length || 0 }
  return { bytes, blocks, writers: m.writerCores.size }
}

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

// Track a live replication mux so a QR-pairing session can open its channel on
// connections that already exist (a member may connect over the rendezvous topic
// before, or after, the session is opened).
async function trackSeederConn (stream) {
  try { await stream.noiseStream.opened } catch { return }
  const mux = stream.noiseStream.userData
  if (!mux) return
  _activeMuxes.add(mux)
  // React to the member opening a pair channel (the member always initiates at
  // scan time). Creating our side *inside* the notify claims the member's
  // pending open, so timing never races. Opening eagerly instead failed on a
  // reused connection: we'd open seconds before the member, and protomux rejects
  // an unclaimed incoming open, closing the channel on both ends.
  mux.pair({ protocol: SEEDER_PAIR_PROTOCOL }, (id) => {
    // Create our side using the rv from the MEMBER's incoming channel id — NOT
    // our current session rv. The QR auto-renews on TTL, so a member can scan rv
    // X and open just as we renew to rv Y; keying off our session rv would build
    // a mismatched channel (Y) that never claims the member's open (X). The rv is
    // only a per-session nonce here; the connection is already authenticated, and
    // enrolling is not sensitive (PearCircle's "a pairing window is open" trust).
    if (!_pairSession) return
    const rv = _rvFromChannelId(id)
    if (rv) setupSeederPairChannelFor(mux, rv)
  })
  stream.on('close', () => {
    _activeMuxes.delete(mux)
    try { mux.unpair({ protocol: SEEDER_PAIR_PROTOCOL }) } catch {}
  })
}

// The channel id carried on the wire IS the 32-byte rendezvous key; recover the
// 43-char base64url rv the member scanned so we build a matching channel.
function _rvFromChannelId (id) {
  try {
    if (!id || id.length !== 32) return null
    return b4a.toString(id, 'base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  } catch { return null }
}

// Seed side: open the receive channel for a member's pairing open on a mux,
// keyed by the rv the member scanned (passed in from the incoming channel id).
function setupSeederPairChannelFor (mux, rv) {
  if (!_pairSession || !rv) return
  setupSeederPairChannel({
    mux,
    role: 'seed',
    rv, // the member's scanned rv (from the incoming channel id), not our session rv
    onBundle: async ({ invites }) => {
      const res = await enrollSeedBundle(invites.join('\n')).catch(() => ({ results: [] }))
      const names = []
      let enrolled = 0
      for (const r of (res?.results ?? [])) {
        if (r?.ok) { enrolled++; if (!r.alreadyEnrolled && r.name) names.push(r.name) }
      }
      const nickRow = await db.get('seeder:nickname').catch(() => null)
      const nickname = nickRow?.value?.name || null
      console.log('[seed] pair: enrolled', enrolled, 'group(s) via QR')
      try { send({ type: 'event', event: 'seeder:pair:result', data: { enrolled, names } }) } catch {}
      if (enrolled > 0) closeSeederPairSession('paired') // one-shot: pairing done
      return { enrolled, names, nickname }
    },
  })
}

// Seed side: mint a fresh rendezvous + join its topic; return the QR link.
// Idempotent — re-opening returns the same live session's link.
async function openSeederPairSession () {
  if (!identity) return { error: 'seeder not booted' }
  const seederHex = b4a.toString(identity.publicKey, 'hex')
  if (_pairSession) {
    return { link: buildSeederPairLink({ rv: _pairSession.rv, seeder: seederHex }), ttlMs: SEEDER_PAIR_TTL_MS, reused: true }
  }
  const rv = generateRendezvousKey()
  const topic = seederPairTopic(rv)
  const topicHex = b4a.toString(topic, 'hex')
  try { swarm.join(topic, { server: true, client: true }) } catch (e) {
    return { error: 'join failed: ' + (e?.message ?? String(e)) }
  }
  const ttlTimer = setTimeout(() => closeSeederPairSession('ttl'), SEEDER_PAIR_TTL_MS)
  if (typeof ttlTimer.unref === 'function') ttlTimer.unref()
  _pairSession = { rv, topic, topicHex, ttlTimer }
  // No eager channel creation — each connection's mux.pair handler (registered
  // in trackSeederConn) reacts to the member's open once this session is live.
  console.log('[seed] pair session open — rv', rv.slice(0, 8))
  return { link: buildSeederPairLink({ rv, seeder: seederHex }), ttlMs: SEEDER_PAIR_TTL_MS }
}

function closeSeederPairSession (reason) {
  if (!_pairSession) return
  const s = _pairSession; _pairSession = null
  try { clearTimeout(s.ttlTimer) } catch {}
  try { swarm.leave(s.topic) } catch {}
  console.log('[seed] pair session closed:', reason)
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

  // Load the seeder identity BEFORE the swarm and key the swarm with it, so the
  // authenticated remote pubkey a member sees on a rendezvous connection equals
  // the identity pubkey carried in the QR (the QR-pairing security anchor).
  identity = await loadOrCreateSeederIdentity()

  swarm = new Hyperswarm({ keyPair: identity })
  // Blind replication: replicate the whole corestore to any connected peer, and
  // open the writer-announce channel so members tell us their writer cores.
  swarm.on('connection', (conn) => {
    const s = store.replicate(conn)
    s.on('error', () => {})
    conn.on('error', () => {})
    setupWriterAnnounceListener(s)
    trackSeederConn(s)
  })

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
    case 'seeder:status': {
      const nick = await db.get('seeder:nickname').catch(() => null)
      let bytes = 0, blocks = 0
      for (const groupId of mounted.keys()) { const m = _groupMetrics(groupId); bytes += m.bytes; blocks += m.blocks }
      return {
        pubkey: identity ? b4a.toString(identity.publicKey, 'hex') : null,
        nickname: nick?.value?.name ?? null,
        booted: _booted,
        uptime: _now() - bootTs,
        enrolled: enrolled.size,
        mounted: mounted.size,
        // Blind-safe metrics only: the seeder holds ciphertext, so it can report
        // storage (bytes) and opaque block counts and peer count — never event
        // counts, which would require decrypting.
        peers: (swarm && swarm.connections) ? swarm.connections.size : 0,
        bytes,
        blocks,
      }
    }
    case 'seeder:nickname:get': {
      const n = await db.get('seeder:nickname').catch(() => null)
      return { name: n?.value?.name ?? null }
    }
    case 'seeder:nickname:set': {
      const a = args
      const name = (typeof a === 'string' ? a : (a?.name ?? (Array.isArray(a) ? a[0] : ''))) || ''
      await db.put('seeder:nickname', { name: String(name).slice(0, 64), updatedAt: _now() })
      return { ok: true, name: String(name).slice(0, 64) }
    }
    case 'seeder:enrolled:list':
      return [...enrolled.values()].map((row) => ({ ...row, ..._groupMetrics(row.groupId) }))
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
    case 'seeder:pair:open':
      return openSeederPairSession()
    case 'seeder:pair:close':
      closeSeederPairSession('manual')
      return { ok: true }
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
