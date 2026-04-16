// Owner-signing primitives for signed group-state envelopes (e.g. the
// migration marker in a group rekey). Signatures are Ed25519 via
// sodium-native; payloads are serialized with a canonical JSON form
// (sorted keys, recursive) so that signer and verifier agree on bytes
// regardless of object key insertion order.

const sodium = require('sodium-native')
const b4a    = require('b4a')

function canonicalize (value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']'
  const keys = Object.keys(value).sort()
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}'
}

function signMessage (payload, secretKeyHex) {
  const msg = b4a.from(canonicalize(payload))
  const sk  = b4a.from(secretKeyHex, 'hex')
  const sig = b4a.alloc(sodium.crypto_sign_BYTES)
  sodium.crypto_sign_detached(sig, msg, sk)
  return b4a.toString(sig, 'hex')
}

function verifySignature (payload, sigHex, publicKeyHex) {
  try {
    const msg = b4a.from(canonicalize(payload))
    const sig = b4a.from(sigHex, 'hex')
    const pk  = b4a.from(publicKeyHex, 'hex')
    if (sig.length !== sodium.crypto_sign_BYTES) return false
    if (pk.length  !== sodium.crypto_sign_PUBLICKEYBYTES) return false
    return sodium.crypto_sign_verify_detached(sig, msg, pk)
  } catch {
    return false
  }
}

module.exports = { canonicalize, signMessage, verifySignature }
