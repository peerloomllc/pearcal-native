// One-time Hyperswarm rendezvous topic for a seeder-pairing session. Ported
// from PearCircle src/swarm.js (2026-06-22-seeder-qr-pairing). Runs identically
// on the seed worklet (src/seed.js) and the member worklet (src/bare.js) so both
// ends derive the SAME topic from the QR's rendezvous key.

'use strict'

const sodium = require('sodium-native')
const b4a = require('b4a')

// Domain-separation prefix so a seeder-pair rendezvous topic can never collide
// with a group's swarm topic even if the random rendezvous key happens to equal
// some groupKey.
const SEEDER_PAIR_CONTEXT = 'pearcal/seeder-pair'
const TOPIC_BYTES = 32
const BASE64URL_43 = /^[A-Za-z0-9_-]{43}$/

// base64url with no padding (43 chars for 32 bytes) — b4a has no 'base64url'
// encoding, so map the base64 alphabet by hand.
function _toBase64url (buf) {
  return b4a.toString(buf, 'base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function _fromBase64url (s) {
  return b4a.from(s.replace(/-/g, '+').replace(/_/g, '/') + '=', 'base64')
}

// Mint a fresh 32-byte rendezvous key as a 43-char base64url string.
function generateRendezvousKey () {
  const buf = b4a.alloc(32)
  sodium.randombytes_buf(buf)
  return _toBase64url(buf)
}

// topic = blake2b(SEEDER_PAIR_CONTEXT || rvBytes).
function seederPairTopic (rvB64) {
  if (typeof rvB64 !== 'string' || !BASE64URL_43.test(rvB64)) {
    throw new Error('rendezvous key must be a 43-char base64url string (32 bytes)')
  }
  const rv = _fromBase64url(rvB64)
  const seed = b4a.concat([b4a.from(SEEDER_PAIR_CONTEXT), rv])
  const out = b4a.alloc(TOPIC_BYTES)
  sodium.crypto_generichash(out, seed)
  return out
}

module.exports = { generateRendezvousKey, seederPairTopic, SEEDER_PAIR_CONTEXT, TOPIC_BYTES, BASE64URL_43 }
