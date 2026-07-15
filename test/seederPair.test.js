// Seeder QR-pairing core: the link (QR payload), the rendezvous topic, and the
// channel wire (proposal 2026-07-15-pearcal-seeder-port, QR-pairing model ported
// from PearCircle 2026-06-22). (feature/seeder-admit-ui)
const test = require('node:test')
const assert = require('node:assert/strict')
const b4a = require('b4a')
const { buildSeederPairLink, parseSeederPairLink } = require('../src/lib/seederPairLink.js')
const { generateRendezvousKey, seederPairTopic, SEEDER_PAIR_CONTEXT } = require('../src/lib/seederPairTopic.js')
const { SEEDER_PAIR_PROTOCOL, setupSeederPairChannel } = require('../src/lib/seederPair.js')

const RV = 'A'.repeat(43)             // valid 43-char base64url
const SEEDER = 'ab'.repeat(32)        // 64-char hex

// ── link build/parse ──────────────────────────────────────────────────────
test('buildSeederPairLink round-trips through parseSeederPairLink', () => {
  const link = buildSeederPairLink({ rv: RV, seeder: SEEDER })
  const p = parseSeederPairLink(link)
  assert.equal(p.ok, true)
  assert.equal(p.rv, RV)
  assert.equal(p.seeder, SEEDER)
})

test('pearcal://seedpair scheme parses', () => {
  const link = buildSeederPairLink({ rv: RV, seeder: SEEDER }).replace('https://peerloomllc.com/seedpair', 'pearcal://seedpair')
  assert.equal(parseSeederPairLink(link).ok, true)
})

test('the pair link carries no group fields — only rv + seeder', () => {
  const link = buildSeederPairLink({ rv: RV, seeder: SEEDER })
  assert.ok(!/group=|key=|enc=|bootstrap=/.test(link), 'pair link must never carry group secrets')
})

test('parseSeederPairLink rejects a group /seed invite', () => {
  const seedInvite = 'https://peerloomllc.com/seed?group=Zw&name=Fam&key=' + 'a'.repeat(64) + '&inviter=' + 'c'.repeat(64)
  assert.equal(parseSeederPairLink(seedInvite).ok, false)
})

test('parseSeederPairLink rejects malformed rv / seeder', () => {
  assert.equal(parseSeederPairLink('https://peerloomllc.com/seedpair?rv=short&seeder=' + SEEDER).ok, false)
  assert.equal(parseSeederPairLink('https://peerloomllc.com/seedpair?rv=' + RV + '&seeder=nothex').ok, false)
})

test('buildSeederPairLink throws on bad inputs', () => {
  assert.throws(() => buildSeederPairLink({ rv: 'short', seeder: SEEDER }))
  assert.throws(() => buildSeederPairLink({ rv: RV, seeder: 'nothex' }))
})

// ── rendezvous topic ──────────────────────────────────────────────────────
test('generateRendezvousKey mints a 43-char base64url string usable by the link', () => {
  const rv = generateRendezvousKey()
  assert.match(rv, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(parseSeederPairLink(buildSeederPairLink({ rv, seeder: SEEDER })).rv, rv)
})

test('seederPairTopic is deterministic, 32 bytes, and domain-separated', () => {
  const rv = generateRendezvousKey()
  const t1 = seederPairTopic(rv)
  const t2 = seederPairTopic(rv)
  assert.equal(t1.length, 32)
  assert.equal(b4a.toString(t1, 'hex'), b4a.toString(t2, 'hex'))
  // Different context prefix ⇒ a raw blake2b(rvBytes) must NOT equal the topic
  // (guards against a rendezvous key colliding with a plain groupKey topic).
  const sodium = require('sodium-native')
  const rvBytes = b4a.from(rv.replace(/-/g, '+').replace(/_/g, '/') + '=', 'base64')
  const raw = b4a.alloc(32); sodium.crypto_generichash(raw, rvBytes)
  assert.notEqual(b4a.toString(raw, 'hex'), b4a.toString(t1, 'hex'))
  assert.equal(SEEDER_PAIR_CONTEXT, 'pearcal/seeder-pair')
})

test('different rendezvous keys yield different topics', () => {
  assert.notEqual(
    b4a.toString(seederPairTopic(generateRendezvousKey()), 'hex'),
    b4a.toString(seederPairTopic(generateRendezvousKey()), 'hex'),
  )
})

// ── channel wire (in-process mux fake) ────────────────────────────────────
// Minimal Protomux stand-in: two endpoints share channel state keyed by
// protocol+id, and messages route by index to the peer's onmessage.
function makeMuxPair () {
  const channels = new Map() // key -> { a, b } endpoints
  function endpoint (side) {
    return {
      createChannel ({ protocol, id, onopen, onclose }) {
        const key = protocol + ':' + b4a.toString(id, 'hex')
        let entry = channels.get(key)
        if (!entry) { entry = { a: null, b: null }; channels.set(key, entry) }
        const msgs = []
        const ch = {
          _side: side, _key: key, _onopen: onopen, _msgs: msgs, _opened: false,
          addMessage ({ encoding, onmessage }) {
            const m = { encoding, onmessage, index: msgs.length,
              send (payload) {
                const peer = entry[side === 'a' ? 'b' : 'a']
                if (!peer || !peer._opened) return
                const pm = peer._msgs[this.index]
                if (pm && pm.onmessage) queueMicrotask(() => pm.onmessage(payload))
              } }
            msgs.push(m); return m
          },
          open () {
            this._opened = true
            queueMicrotask(() => { if (this._onopen) this._onopen() })
            const peer = entry[side === 'a' ? 'b' : 'a']
            if (peer && peer._opened) { /* both open */ }
          },
        }
        entry[side] = ch
        return ch
      },
    }
  }
  return { muxA: endpoint('a'), muxB: endpoint('b') }
}

test('channel: member pushes bundle, seed enrolls and acks back', async () => {
  const { muxA, muxB } = makeMuxPair()
  const rv = generateRendezvousKey()
  const received = []
  let ack = null

  // seed side
  setupSeederPairChannel({
    mux: muxA, role: 'seed', rv,
    onBundle: async ({ invites }) => {
      received.push(...invites)
      return { enrolled: invites.length, names: invites.map((_, i) => 'g' + i) }
    },
  })
  // member side
  setupSeederPairChannel({
    mux: muxB, role: 'member', rv,
    getBundle: async () => ['https://peerloomllc.com/seed?one', 'https://peerloomllc.com/seed?two'],
    onAck: async (a) => { ack = a },
  })

  await new Promise(r => setTimeout(r, 20))
  assert.deepEqual(received, ['https://peerloomllc.com/seed?one', 'https://peerloomllc.com/seed?two'])
  assert.equal(ack.enrolled, 2)
  assert.deepEqual(ack.names, ['g0', 'g1'])
})

test('channel: setup validates role and rv', () => {
  const { muxA } = makeMuxPair()
  assert.throws(() => setupSeederPairChannel({ mux: muxA, role: 'nope', rv: generateRendezvousKey() }))
  assert.throws(() => setupSeederPairChannel({ mux: muxA, role: 'seed', rv: 'short' }))
  assert.equal(SEEDER_PAIR_PROTOCOL, 'pearcal/seeder-pair/1')
})
