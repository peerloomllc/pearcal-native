import sodium from 'sodium-universal'
import b4a from 'b4a'

/**
 * Generate a new Ed25519 keypair for a user or group identity.
 * @returns {{ publicKey: Buffer, secretKey: Buffer }}
 */
export function generateKeypair () {
  const publicKey = b4a.allocUnsafe(sodium.crypto_sign_PUBLICKEYBYTES)
  const secretKey = b4a.allocUnsafe(sodium.crypto_sign_SECRETKEYBYTES)
  sodium.crypto_sign_keypair(publicKey, secretKey)
  return { publicKey, secretKey }
}

/**
 * Encode a key buffer as a hex string (used for display + storage).
 * @param {Buffer} key
 * @returns {string}
 */
export function keyToHex (key) {
  return b4a.toString(key, 'hex')
}

/**
 * Decode a hex string back to a key buffer.
 * @param {string} hex
 * @returns {Buffer}
 */
export function hexToKey (hex) {
  return b4a.from(hex, 'hex')
}

/**
 * Derive a short numeric ID from a hex key (for Android notification IDs).
 * @param {string} hex
 * @returns {number}
 */
export function keyToNotifId (hex) {
  let h = 0
  for (const c of hex.slice(0, 16)) {
    h = (Math.imul(31, h) + c.charCodeAt(0)) | 0
  }
  return Math.abs(h)
}