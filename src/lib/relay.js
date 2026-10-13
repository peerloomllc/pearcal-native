// TODO #130 — the PeerLoom blind relay, PearCal's off-LAN backstop.
//
// Hyperswarm hole-punches directly whenever it can. On a symmetric / double-
// randomised NAT it never can, and the punch aborts with HOLEPUNCH_ABORTED after
// ~10s. PearCal is phone-TO-phone, so BOTH ends are typically on carrier CGNAT —
// the hardest case there is. A blind relay is one public box both ends can reach
// outbound; hyperdht pairs the two half-connections through it and forwards the
// bytes. The stream stays Noise-encrypted end to end, so the relay carries
// ciphertext plus metadata (which two keys talk, how many bytes) and never a
// readable calendar. Transient encrypted transit, not storage.
//
// The relay node itself is PearTune's (proposal peartune/proposals/2026-07-23-
// blind-relay.md, deployed 2026-07-23) and is deliberately app-agnostic — a blind
// byte-forwarder cares nothing about the app on top. PearCal points at the same
// key; nothing is deployed here.
//
// This file is the pure policy so it is unit-testable — bare.js touches BareKit
// at load and cannot be required from tests. Same split as groupRecord.js.

'use strict'

const b4a = require('b4a')

// The deployed PeerLoom relay's public key. Its private seed lives only on the
// relay box (relay.seed, 0600) + Tim's password manager.
//
// Held BOTH ways on purpose. The z32 form is what the relay node prints, what the
// suite quotes and what the UI shows, so it is the one a human compares against a
// deployment. The hex form is what we actually decode, so this module pulls in no
// dependency that bare.js does not already have (b4a is everywhere; z32 was only a
// transitive dep). test/relay.test.js asserts the two agree, so they cannot drift.
const RELAY_PUBLIC_KEY_Z = 'qshao3eawtzecrt5p7buswr4meyyhw6q6b51qtxazd8wwfdp8uqy'
const RELAY_PUBLIC_KEY_HEX = '75b9886518a46e86123b6f433b509a5a000e53cef0772745f8b8cf4a146d3cdc'

// Null would mean "no relay configured", which relayThroughFor treats as a pure
// no-op — the rollback for this whole feature is emptying this constant.
const RELAY_PUBLIC_KEY = RELAY_PUBLIC_KEY_HEX ? b4a.from(RELAY_PUBLIC_KEY_HEX, 'hex') : null

// The direct-first relay policy — the function Hyperswarm calls per outbound
// connect (`relayThrough` accepts either a key or a `(force, swarm) => key|null`
// fn). Returns the relay key to route through, or null for direct-only.
//
//   force      - Hyperswarm sets peerInfo.forceRelaying=true after a
//                HOLEPUNCH_ABORTED / HOLEPUNCH_DOUBLE_RANDOMIZED_NATS /
//                REMOTE_NOT_HOLEPUNCHABLE for this peer, then retries. This is
//                what makes us direct-FIRST: null on the normal attempt, the key
//                only once a direct punch has actually failed.
//   randomized - this device's own NAT is double-randomized, i.e. a direct punch
//                can never land. Relay from the first attempt (this mirrors
//                Hyperswarm's own default gate, `force || swarm.dht.randomized`).
//   useRelay   - the user's privacy toggle (Profile → Connection, default on).
//                Off means pure peer-to-peer: never touch PeerLoom's relay, and
//                accept that a 0%-punch network simply will not connect.
//   relayKey   - the baked relay key, or null when no relay is configured.
//
// Order matters: the toggle and the is-a-relay-even-configured check gate first,
// so a user who opted out never relays regardless of what their NAT is doing.
function relayThroughFor ({ force, randomized, useRelay, relayKey }) {
  if (!useRelay || !relayKey) return null
  return (force || randomized) ? relayKey : null
}

// The errors after which a direct connection will not work: Hyperswarm's own
// list (hyperswarm/index.js shouldForceRelaying).
const PUNCH_FAILED = new Set(['HOLEPUNCH_ABORTED', 'HOLEPUNCH_DOUBLE_RANDOMIZED_NATS', 'REMOTE_NOT_HOLEPUNCHABLE'])

// PeerLoom Seeder dials (blind-peering backups, pulls, requests) use
// dht.connect outside Hyperswarm, where a relay key means "relay from the
// first attempt". This wraps the DHT so those dials are direct first too, per
// remote key: after a failed holepunch to a key, later dials to it relay. A
// seeder on a Start9 is reachable from a phone on the same network only
// through the relay. From PearCircle (pearcircle #245) and PearOffice.
//   useRelay - () => the live toggle; relayKey - as above.
function relayingDht (dht, { useRelay, relayKey }) {
  const failed = new Set()
  function connect (remotePublicKey, opts = {}) {
    const key = b4a.toString(remotePublicKey, 'hex')
    const relayThrough = relayThroughFor({ force: failed.has(key), randomized: !!dht.randomized, useRelay: useRelay(), relayKey })
    const socket = dht.connect(remotePublicKey, relayThrough ? { ...opts, relayThrough } : opts)
    socket.on('error', (err) => { if (err && PUNCH_FAILED.has(err.code)) failed.add(key) })
    return socket
  }
  return new Proxy(dht, {
    get (target, prop) {
      if (prop === 'connect') return connect
      const v = Reflect.get(target, prop, target)
      return typeof v === 'function' ? v.bind(target) : v
    }
  })
}

module.exports = { RELAY_PUBLIC_KEY, RELAY_PUBLIC_KEY_Z, RELAY_PUBLIC_KEY_HEX, relayThroughFor, relayingDht, PUNCH_FAILED }
