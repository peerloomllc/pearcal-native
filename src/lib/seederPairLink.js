// One-time seeder-pairing link — the QR payload for the blind-seeder admission
// flow. Ported from PearCircle's 2026-06-22-seeder-qr-pairing (proposal
// 2026-07-15-pearcal-seeder-port, QR-pairing model). The SEEDER displays this
// as a QR; the member scans it.
//
// It is NOT a group invite: it carries ONLY a one-time rendezvous key + the
// seeder's pubkey, so scanning it reveals nothing about any group. The member
// joins the rendezvous topic, verifies the connection's authenticated remote
// pubkey equals `seeder`, and only THEN pushes its seed bundle — so group
// secrets never reach an impostor who merely knows the rendezvous topic.
//
// Format: https://peerloomllc.com/seedpair?rv={base64url(32)}&seeder={hex(32)}&v=1
//         pearcal://seedpair?...   (custom scheme also accepted)

'use strict'

const HTTPS_PAIR = 'https://peerloomllc.com/seedpair'
const PEAR_PAIR = 'pearcal://seedpair'
const HEX_64 = /^[0-9a-f]{64}$/i
const BASE64URL_43 = /^[A-Za-z0-9_-]{43}$/

/**
 * Build a seeder-pair link. @param {{rv:string, seeder:string}} args
 * @returns {string}
 */
function buildSeederPairLink ({ rv, seeder } = {}) {
  if (typeof rv !== 'string' || !BASE64URL_43.test(rv)) {
    throw new Error('rv must be a 43-char base64url string (32 bytes)')
  }
  if (typeof seeder !== 'string' || !HEX_64.test(seeder)) {
    throw new Error('seeder must be a 64-char hex string (32 bytes)')
  }
  return `${HTTPS_PAIR}?rv=${rv}&seeder=${seeder.toLowerCase()}&v=1`
}

/**
 * Parse a seeder-pair link. Rejects group /join and /seed links so a group
 * invite can never be mistaken for a pairing handle.
 * @returns {{ok:boolean, rv?:string, seeder?:string, error?:string}}
 */
function parseSeederPairLink (url) {
  if (typeof url !== 'string') return { ok: false, error: 'url must be a string' }
  // Normalise the custom scheme onto the https host so one parser handles both.
  const normalised = url.trim().replace(/^pearcal:\/\/seedpair/, HTTPS_PAIR)
  if (!normalised.startsWith(HTTPS_PAIR + '?')) {
    return { ok: false, error: 'not a PearCal seeder-pair link' }
  }
  let u
  try { u = new URL(normalised) } catch { return { ok: false, error: 'malformed_url' } }
  const rv = u.searchParams.get('rv')
  const seeder = u.searchParams.get('seeder')
  if (typeof rv !== 'string' || !BASE64URL_43.test(rv)) {
    return { ok: false, error: 'invalid or missing rendezvous key' }
  }
  if (typeof seeder !== 'string' || !HEX_64.test(seeder)) {
    return { ok: false, error: 'invalid or missing seeder pubkey' }
  }
  return { ok: true, rv, seeder: seeder.toLowerCase() }
}

module.exports = { buildSeederPairLink, parseSeederPairLink, HTTPS_PAIR, PEAR_PAIR, HEX_64, BASE64URL_43 }
