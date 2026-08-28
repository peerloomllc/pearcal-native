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
const { SEEDER_PAIR_TTL_MS } = require('./lib/seederPairTiming.js')
const {
  SEED_ENROLL_PROTOCOL, SEED_ENROLL_ID,
  parseSeedEnrollBatch, buildSeedEnrollAck,
  parseSeedLeave, buildSeedLeaveAck,
} = require('./lib/seedEnroll.js')
const { isDeviceFileModifiedError, healCorestoreDeviceFiles } = require('./lib/deviceFileHeal.js')

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
const mounted = new Map()  // groupId -> { core, writerCores: Map<hex,core>, topicHex, discovery }

// Periodic re-announce+re-lookup of every mounted topic so the seeder re-discovers
// devices that rejoined under a new ephemeral swarm pubkey (RCA
// proposals/2026-07-17-seeder-discovery-staleness-rca.md). Kept modest — a refresh
// is a couple of DHT round-trips per topic.
const DISCOVERY_REFRESH_MS = 90 * 1000
let _discoveryRefreshTimer = null

// ── Seeder QR pairing (proposal 2026-07-15-pearcal-seeder-port, QR-pairing
// model). The seeder shows a QR = one-time rendezvous topic + its pubkey; the
// phone scans it, joins the rendezvous, verifies our pubkey, and pushes its seed
// bundle over a one-time pearcal/seeder-pair/1 channel. No copy-paste.
let _pairSession = null   // { rv, topic, topicHex, ttlTimer }
const _activeMuxes = new Set() // live replication muxers, for opening the pair channel

// Must byte-match src/bare.js's writer-announce channel so members announce
// their Autobase writer cores to us (we can't read the encrypted view to find
// them ourselves). We only LISTEN — the seeder never announces a writer.
const WRITER_ANNOUNCE_PROTOCOL = 'pearcal/writer-announce'
const WRITER_ANNOUNCE_ID = Buffer.from('pearcal-writer-announce-v1')

// Seeder self-announce. Byte-matches bare.js's listener. On every group
// connection we send our nickname so a member learns we exist and lists us as
// its blind peer — even when it enrolled us via a pasted /seed invite and never
// met us at pair time. Our identity pubkey IS the stream's authenticated remote
// pubkey on the member side (swarm is keyed with the identity keypair), so the
// hello need only carry the nickname; the member attributes it to us from the
// connection, not the message. Only the seeder ever sends here.
const SEEDER_HELLO_PROTOCOL = 'pearcal/seeder-hello'
const SEEDER_HELLO_ID = Buffer.from('pearcal-seeder-hello-v1')

// Live seed-enroll wire (TODO #116 facet #3) is defined in ./lib/seedEnroll.js
// (imported at the top) so the member (bare.js) and seeder ends can't drift.

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
  // A blind seeder never holds the encryptionKey, so it cannot tell whether an
  // enrolled group is ENCRYPTED (bare.js joins the domain-separated blake2b topic)
  // or LEGACY/unencrypted (bare.js joins the RAW groupKey topic). Joining only the
  // blake2b topic silently strands every legacy group: members are on the raw
  // topic, seeders on the blake2b topic, and they never meet over the swarm (only
  // via the one-time QR rendezvous). So join BOTH — the wrong one is just an empty
  // extra join. See RCA proposals/2026-07-17-seeder-discovery-staleness-rca.md.
  const encTopic = topicForGroupKey(groupKey) // encrypted-branch: blake2b(domain, groupKey)
  const rawTopic = b4a.from(groupKey.slice(0, 64).padEnd(64, '0'), 'hex') // legacy-branch: raw groupKey
  const topicHex = b4a.toString(encTopic, 'hex')
  const rawTopicHex = b4a.toString(rawTopic, 'hex')
  // Keep the PeerDiscovery handles so the periodic refresh (see init) can re-run
  // announce+lookup — members re-announce under a NEW swarm pubkey on every app
  // restart (bare.js uses an ephemeral swarm keypair), so a one-shot join would
  // never re-discover a device that reboots.
  const discovery = swarm.join(encTopic, { server: true, client: true })
  const rawDiscovery = rawTopicHex === topicHex ? null : swarm.join(rawTopic, { server: true, client: true })
  const entry = { core, writerCores: new Map(), topicHex, rawTopicHex, discovery, rawDiscovery }
  mounted.set(groupId, entry)
  if (rawDiscovery) console.log('[seed] also joined legacy raw topic', rawTopicHex.slice(0, 12) + '… for', groupId)
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

// Open the live seed-enroll channel on a replication stream. A member with
// auto-follow enabled pushes { seedInvites: [...] } for groups created after we
// were admitted; we enroll each (idempotent) and ack { enrolled: [groupId...] }
// so the member re-announces those groups' writer cores over the same stream.
async function setupSeedEnrollListener (stream) {
  try { await stream.noiseStream.opened } catch { return }
  const mux = stream.noiseStream.userData
  if (!mux) return
  let msg = null
  const channel = mux.createChannel({
    protocol: SEED_ENROLL_PROTOCOL,
    id: SEED_ENROLL_ID,
    onopen () {},
    onclose () {},
  })
  if (!channel) return
  msg = channel.addMessage({
    onmessage: async (buf) => {
      // Live enroll: mount groups the member pushed (facet #3).
      const invites = parseSeedEnrollBatch(buf)
      const enrolled = []
      for (const invite of invites) {
        try {
          const r = await enrollSeedInvite(invite)
          if (r?.ok && r.groupId) enrolled.push(r.groupId)
        } catch (e) { /* one bad invite doesn't abort the batch */ }
      }
      if (enrolled.length) {
        console.log('[seed] live-enroll: mounted', enrolled.length, 'group(s):', enrolled.join(', '))
        try { msg.send(buildSeedEnrollAck(enrolled)) } catch {}
      }
      // Group-wide revocation (Phase 2): a member removed us from these groups.
      // Leave each (idempotent — leaveSeedGroup on an un-mounted group is a
      // no-op) and ack so the member logs it. We're blind and can't read the
      // group's `revoked` tombstone ourselves; this channel signal is how we
      // learn. Not writer-authenticated — worst case a spurious leave costs
      // availability only (a legit auto-follow member re-enrolls a non-revoked
      // group on its next connect), never disclosure.
      const leaveGroups = parseSeedLeave(buf)
      const left = []
      for (const groupId of leaveGroups) {
        try { await leaveSeedGroup(groupId); left.push(groupId) }
        catch (e) { /* idempotent; a bad id doesn't abort the batch */ }
      }
      if (left.length) {
        console.log('[seed] revocation: left', left.length, 'group(s):', left.join(', '))
        try { msg.send(buildSeedLeaveAck(left)) } catch {}
      }
    },
  })
  channel.open()
}

// Announce ourselves to a connected member so it can list us as its blind peer.
// See SEEDER_HELLO_PROTOCOL. Both sides open the channel (byte-identical to
// bare.js); we send { nickname } once on open and never consume — members don't
// announce here — so we register an empty message so the message index matches.
// Active seeder-hello send handles, one per connection. We re-broadcast the
// hello whenever our enrolled-group count changes (enroll/leave) so an
// already-connected member updates its blind-peer count live (#116 facet #2)
// instead of only on the next reconnect + section reopen.
const _helloChannels = new Set()

async function broadcastSeederHello () {
  if (_helloChannels.size === 0) return
  const nickRow = await db.get('seeder:nickname').catch(() => null)
  const payload = Buffer.from(JSON.stringify({ nickname: nickRow?.value?.name || null, groupCount: enrolled.size }))
  for (const msg of _helloChannels) { try { msg.send(payload) } catch {} }
}

async function setupSeederHelloAnnouncer (stream) {
  try { await stream.noiseStream.opened } catch { return }
  const mux = stream.noiseStream.userData
  if (!mux) return
  let msg = null
  const channel = mux.createChannel({
    protocol: SEEDER_HELLO_PROTOCOL,
    id: SEEDER_HELLO_ID,
    async onopen () {
      _helloChannels.add(msg)
      const nickRow = await db.get('seeder:nickname').catch(() => null)
      const nickname = nickRow?.value?.name || null
      try { msg.send(Buffer.from(JSON.stringify({ nickname, groupCount: enrolled.size }))) } catch {}
    },
    onclose () { _helloChannels.delete(msg) },
  })
  if (!channel) return
  msg = channel.addMessage({ onmessage () {} })
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
    // Re-opening returns what is LEFT of the live session, not a fresh TTL. The
    // dashboard counts this down (issue #265), so handing back the full 5 min
    // here would show a QR as valid for minutes after its rendezvous had gone.
    const left = Math.max(0, SEEDER_PAIR_TTL_MS - (Date.now() - _pairSession.openedAt))
    return { link: buildSeederPairLink({ rv: _pairSession.rv, seeder: seederHex }), ttlMs: left, reused: true }
  }
  const rv = generateRendezvousKey()
  const topic = seederPairTopic(rv)
  const topicHex = b4a.toString(topic, 'hex')
  try { swarm.join(topic, { server: true, client: true }) } catch (e) {
    return { error: 'join failed: ' + (e?.message ?? String(e)) }
  }
  const ttlTimer = setTimeout(() => closeSeederPairSession('ttl'), SEEDER_PAIR_TTL_MS)
  if (typeof ttlTimer.unref === 'function') ttlTimer.unref()
  _pairSession = { rv, topic, topicHex, ttlTimer, openedAt: Date.now() }
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
  // Enrolled a new group → push the updated count to connected members (#116 facet #2).
  broadcastSeederHello().catch(() => {})
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
    if (entry.rawTopicHex && entry.rawTopicHex !== entry.topicHex) {
      try { swarm.leave(b4a.from(entry.rawTopicHex, 'hex')).catch(() => {}) } catch {}
    }
    try { await entry.core.close() } catch {}
    for (const c of entry.writerCores.values()) { try { await c.close() } catch {} }
    mounted.delete(groupId)
  }
  await db.del('seeder:enrolled:' + groupId).catch(() => {})
  enrolled.delete(groupId)
  console.log('[seed] left group', groupId)
  // Left a group → push the updated count to connected members (#116 facet #2).
  broadcastSeederHello().catch(() => {})
  return { ok: true, groupId }
}

// ── Boot ────────────────────────────────────────────────────────────────────
// Open the two local stores. On failure, close whatever did open before
// rethrowing: device-file holds an fd lock on each CORESTORE, and that lock
// conflicts in-process, so a retry against a half-open first attempt can never
// succeed (see project_shutdown_fd_lock_leak).
async function openLocalStores () {
  const core = new Hypercore(dataDir + '/core', { valueEncoding: 'json' })
  let bee = null
  let cs = null
  try {
    await core.ready()
    bee = new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'json' })
    await bee.ready()
    cs = new Corestore(dataDir + '/store')
    await cs.ready()
    return { bee, cs }
  } catch (e) {
    if (cs) await cs.close().catch(() => {})
    await core.close().catch(() => {})
    throw e
  }
}

// Self-heal for TODO #172. hypercore-storage's device-file guard refuses a store
// whose CORESTORE marker no longer matches the file's inode or birth time, which
// is what a host-side copy of our data folder produces (StartOS 0.4.0.1 clones
// every package volume into a btrfs subvolume on first boot and deletes the
// original). The seeder is blind: it never writes a member's cores, only its own
// local Hyperbee, so a stale marker on a single surviving copy is a false alarm
// worth healing rather than a reason to stay down. Only the exact "was
// modified" case is healed; "was moved unsafely" (attribute missing) and
// "different platform" still fail as before. PEARCAL_SEED_NO_DEVICE_HEAL=1
// disables it.
function deviceHealDisabled () {
  const env = (typeof Bare !== 'undefined' && Bare.env) ? Bare.env
    : (typeof process !== 'undefined' && process.env) ? process.env : {}
  return env.PEARCAL_SEED_NO_DEVICE_HEAL === '1'
}

async function openLocalStoresWithHeal () {
  try {
    return await openLocalStores()
  } catch (e) {
    if (!isDeviceFileModifiedError(e) || deviceHealDisabled()) throw e
    const fs = typeof Bare !== 'undefined' ? require('bare-fs') : require('fs')
    const healed = healCorestoreDeviceFiles(fs, [dataDir + '/core', dataDir + '/store'])
    console.error('[seed] device-file guard tripped (' + e.message + '). The host copied our data folder;',
      'this is what StartOS 0.4.0.1 does on first boot. Re-stamped', healed.length,
      'CORESTORE marker(s) in place and retrying once:', JSON.stringify(healed.map((h) => h.file)))
    if (healed.length === 0) throw e
    return openLocalStores()
  }
}

async function init (dir) {
  if (_booted) return { ok: true, alreadyBooted: true }
  dataDir = dir
  const opened = await openLocalStoresWithHeal()
  db = opened.bee
  store = opened.cs

  // Load the seeder identity BEFORE the swarm and key the swarm with it, so the
  // authenticated remote pubkey a member sees on a rendezvous connection equals
  // the identity pubkey carried in the QR (the QR-pairing security anchor).
  identity = await loadOrCreateSeederIdentity()

  swarm = new Hyperswarm({ keyPair: identity })
  // Blind replication: replicate the whole corestore to any connected peer, and
  // open the writer-announce channel so members tell us their writer cores.
  swarm.on('connection', (conn, info) => {
    // Diagnostic (seeder-discovery investigation): log who connects, on which
    // topic(s), and the total peer count — so `peers:N` can be attributed to real
    // remotes instead of guessed. Cheap; safe to keep while diagnosing.
    try {
      const rpk = conn.remotePublicKey ? b4a.toString(conn.remotePublicKey, 'hex').slice(0, 16) : '?'
      const topics = (info && info.topics) ? info.topics.map((t) => b4a.toString(t, 'hex').slice(0, 12)).join(',') : ''
      const client = info ? !!info.client : false
      console.log('[seed] +conn peer', rpk, client ? '(we dialed)' : '(they dialed)',
                  topics ? 'topics=' + topics : '', '| peers now', swarm.connections.size)
      conn.on('close', () => {
        console.log('[seed] -conn peer', rpk, '| peers now', swarm.connections.size)
        // Prompt re-discovery of the dropped peer (mirrors bare.js's
        // stream.on('close') -> swarm.flush()) instead of waiting a full tick.
        try { swarm.flush().catch(() => {}) } catch (e) {}
      })
    } catch (e) {}
    const s = store.replicate(conn)
    s.on('error', () => {})
    conn.on('error', () => {})
    setupWriterAnnounceListener(s)
    setupSeederHelloAnnouncer(s)
    setupSeedEnrollListener(s)
    trackSeederConn(s)
  })

  await loadEnrolledGroups()
  for (const enr of enrolled.values()) {
    await mountGroup(enr).catch((e) => console.warn('[seed] mount error', enr.groupId, e?.message))
  }

  // Discovery refresh loop (RCA proposals/2026-07-17-seeder-discovery-staleness-rca.md).
  // A one-shot swarm.join only dials the peers present at mount; members re-announce
  // under a NEW ephemeral swarm pubkey on every app restart, so without a periodic
  // re-announce+re-lookup the seeder loses devices as they cycle and never re-finds
  // them (until the seeder itself restarts). Re-refresh each mounted topic + flush.
  if (_discoveryRefreshTimer) { try { clearInterval(_discoveryRefreshTimer) } catch {} }
  let _lastPeerCount = -1
  _discoveryRefreshTimer = setInterval(() => {
    for (const entry of mounted.values()) {
      try { entry.discovery?.refresh?.({ client: true, server: true }) } catch (e) {}
      try { entry.rawDiscovery?.refresh?.({ client: true, server: true }) } catch (e) {}
    }
    try { swarm.flush().catch(() => {}) } catch (e) {}
    // Quiet by default: only log when the connected-peer count changes (the
    // per-connection +conn/-conn lines already trace individual peers).
    try {
      const c = swarm.connections.size
      if (c !== _lastPeerCount) { console.log('[seed] peers:', c, '(was', _lastPeerCount < 0 ? 0 : _lastPeerCount, ')'); _lastPeerCount = c }
    } catch (e) {}
  }, DISCOVERY_REFRESH_MS)

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
  enrollSeedInvite, enrollSeedBundle, leaveSeedGroup, setupSeedEnrollListener,
  // Test/introspection accessors.
  _state: () => ({ enrolled, mounted, identity, store: () => store, swarm: () => swarm }),
}
