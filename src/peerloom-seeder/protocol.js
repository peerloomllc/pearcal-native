// Seeder pairing protocol, shared by the seeder and the apps
// (proposals/2026-10-12-generic-seeder.md in the suite root).
//
// The seeder shows a link (and a QR code):
//   peerloom://seeder?rv=<rendezvous>&seeder=<seederKey>&v=1
// valid for 5 minutes. A device meets it on topic
//   blake2b("peerloom/seeder-pair/v1" + rv)
// and talks only if the connection's remote public key equals seederKey.
// On channel `peerloom/seeder-pair/1` (id = rv) the device sends
//   { t: 'trust', deviceKey, app }  its swarm public key, which must match the
//                                   connection's remote key, and an optional
//                                   label for the seeder's dashboard
// and the seeder answers { t: 'ok' } or { t: 'no', reason }. Nothing about
// any space is sent.
//
// Requests from paired devices after pairing, on `peerloom/seeder/1`:
//   { t: 'drop', bootstrap, afterMs }  ->  { t: 'ok', due } | { t: 'no', reason }
//   { t: 'keep', bootstrap }           ->  { t: 'ok', cancelled }
//   { t: 'keyring-put', rec }            paired devices  ->  { t: 'ok', seq }
//   { t: 'keyring-get', locator }        anyone          ->  { t: 'ok', rec | null }
//   { t: 'keyring-claim', locator, sig } anyone          ->  { t: 'ok', paired: true }
//
// This started as PearOffice's seeder. PearOffice's names (`pearoffice://`
// links, `pearoffice/seeder-pair/...`, `pearoffice/seeder/1`) are the same
// protocol under its old names. Seeders answer both, so PearOffice versions
// from before the shared seeder keep working with it.

const b4a = require('b4a')
const sodium = require('sodium-universal')

const NAMES = {
  peerloom: {
    scheme: 'peerloom',
    pairProtocol: 'peerloom/seeder-pair/1',
    pairNamespace: 'peerloom/seeder-pair/v1',
    seederProtocol: 'peerloom/seeder/1'
  },
  pearoffice: {
    scheme: 'pearoffice',
    pairProtocol: 'pearoffice/seeder-pair/1',
    pairNamespace: 'pearoffice/seeder-pair/v1',
    seederProtocol: 'pearoffice/seeder/1'
  }
}

const PAIR_WINDOW_MS = 5 * 60 * 1000
const DROP_MAX_MS = 30 * 24 * 3600 * 1000
const DROP_GRACE_MS = 7 * 24 * 3600 * 1000
const APP_LABEL_MAX = 40

function namesOf (style) {
  const n = NAMES[style || 'peerloom']
  if (!n) throw new Error('Unknown seeder protocol names: ' + style)
  return n
}

function pairTopic (rv, style) {
  const out = b4a.alloc(32)
  sodium.crypto_generichash(out, b4a.concat([b4a.from(namesOf(style).pairNamespace), rv]))
  return out
}

function b64url (buf) {
  return b4a.toString(buf, 'base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function seederLink ({ rv, seederKey, style }) {
  return namesOf(style).scheme + '://seeder?' + new URLSearchParams({ rv: b64url(rv), seeder: b4a.toString(seederKey, 'hex'), v: '1' }).toString()
}

// Either scheme. `style` says which names to talk with afterwards.
function parseSeederLink (link) {
  const m = /^(peerloom|pearoffice):\/\/seeder\?(.+)$/.exec(String(link).trim())
  if (!m) throw new Error('That is not a seeder link')
  const q = new URLSearchParams(m[2])
  if (q.get('v') !== '1') throw new Error('This seeder needs a newer version of the app')
  const rv = b4a.from((q.get('rv') || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  const seeder = q.get('seeder') || ''
  if (rv.length !== 32 || !/^[0-9a-f]{64}$/.test(seeder)) throw new Error('This seeder link is damaged')
  return { rv, seederKey: b4a.from(seeder, 'hex'), style: m[1] }
}

// A device's label as the seeder keeps it: trimmed, short, or null.
function cleanLabel (app) {
  if (typeof app !== 'string') return null
  const s = app.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, APP_LABEL_MAX)
  return s || null
}

module.exports = { NAMES, PAIR_WINDOW_MS, DROP_MAX_MS, DROP_GRACE_MS, APP_LABEL_MAX, namesOf, pairTopic, seederLink, parseSeederLink, cleanLabel }
