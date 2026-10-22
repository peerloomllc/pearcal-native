// The parts of a keyring a seeder needs: checking a sealed version and a
// claim, and the topic it announces (from PearOffice,
// pearoffice/proposals/2026-10-07-phrase-recovers-files.md). The app keeps
// the seed and does the sealing.
//
// The namespaces still say pearoffice/: they are signed into every record
// and claim, so changing them would break every keyring already stored.
//
// A claim: a device that has just restored from its phrase asks a seeder to
// treat it as paired. It signs, with the keyring's sign key, the locator,
// the seeder's key and its own swarm key. The seeder checks the signature
// against the sign key of the keyring it holds at that locator, and the
// device key against the connection's remote key, which Noise has already
// proved. A claim for one device is no use on any other.

const b4a = require('b4a')
const sodium = require('sodium-universal')

const NS = {
  topic: 'pearoffice/keyring/topic/1',
  sig: 'pearoffice/keyring/sig/1',
  claim: 'pearoffice/keyring/claim/1'
}
const MAX_BYTES = 1024 * 1024 // ciphertext
const KEY = /^[0-9a-f]{64}$/
const SIG = /^[0-9a-f]{128}$/
const B64 = /^[A-Za-z0-9+/]*={0,2}$/

function hash (key, ns) {
  const out = b4a.alloc(32)
  sodium.crypto_generichash(out, b4a.from(ns), key)
  return out
}

// Where a restoring device finds seeders holding the keyring at `locator`.
function topicOf (locator) {
  return hash(locator, NS.topic)
}

function signed (locator, seq, nonce, ciphertext) {
  const s = b4a.alloc(8)
  const view = new DataView(s.buffer, s.byteOffset, 8)
  view.setUint32(0, Math.floor(seq / 0x100000000))
  view.setUint32(4, seq >>> 0)
  return b4a.concat([b4a.from(NS.sig), locator, s, nonce, ciphertext])
}

// The checks a seeder can make without the seed: the shape, the size and
// that `signKey` signed it. Returns the decoded bytes, or null.
function checkSealed (rec) {
  if (!rec || typeof rec !== 'object') return null
  const { locator, seq, nonce, ciphertext, signKey, sig } = rec
  if (typeof locator !== 'string' || !KEY.test(locator)) return null
  if (typeof signKey !== 'string' || !KEY.test(signKey)) return null
  if (typeof sig !== 'string' || !SIG.test(sig)) return null
  if (!Number.isSafeInteger(seq) || seq < 1) return null
  if (typeof nonce !== 'string' || typeof ciphertext !== 'string' || !B64.test(nonce) || !B64.test(ciphertext)) return null
  if (ciphertext.length > Math.ceil(MAX_BYTES / 3) * 4) return null
  const bytes = {
    locator: b4a.from(locator, 'hex'),
    nonce: b4a.from(nonce, 'base64'),
    ciphertext: b4a.from(ciphertext, 'base64'),
    signKey: b4a.from(signKey, 'hex'),
    sig: b4a.from(sig, 'hex')
  }
  if (bytes.nonce.length !== sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES) return null
  if (bytes.ciphertext.length < sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES || bytes.ciphertext.length > MAX_BYTES) return null
  try {
    if (!sodium.crypto_sign_verify_detached(bytes.sig, signed(bytes.locator, seq, bytes.nonce, bytes.ciphertext), bytes.signKey)) return null
  } catch { return null }
  return bytes
}

function claimed (locator, seederKey, deviceKey) {
  return b4a.concat([b4a.from(NS.claim), b4a.from(locator, 'hex'), b4a.from(seederKey, 'hex'), b4a.from(deviceKey, 'hex')])
}

// signKeyPair: the keyring's; keys hex. Returns the signature, hex.
function signClaim (signKeyPair, locator, seederKey, deviceKey) {
  const sig = b4a.alloc(sodium.crypto_sign_BYTES)
  sodium.crypto_sign_detached(sig, claimed(locator, seederKey, deviceKey), signKeyPair.secretKey)
  return b4a.toString(sig, 'hex')
}

function checkClaim ({ locator, sig }, signKey, seederKey, deviceKey) {
  if (typeof locator !== 'string' || !KEY.test(locator) || typeof sig !== 'string' || !SIG.test(sig)) return false
  try {
    return sodium.crypto_sign_verify_detached(b4a.from(sig, 'hex'), claimed(locator, seederKey, deviceKey), b4a.from(signKey, 'hex'))
  } catch { return false }
}

module.exports = { NS, MAX_BYTES, hash, topicOf, signed, checkSealed, signClaim, checkClaim }
