// The keyring: an encrypted list of a person's calendars, kept by their
// PeerLoom Seeders, so the 12 words bring calendars back
// (proposals/2026-10-22-phrase-recovers-calendars.md, TODO #176). Ported from
// pearoffice/src/worklet/keyring.js.
//
// Everything comes from the recovery phrase with a keyed BLAKE2b, one purpose
// string each, under pearcal/ so a PearCal phrase never opens a PearOffice
// keyring:
//
//   root      from the phrase's 16 bytes of entropy
//   locator   the keyring's address at a seeder
//   topic     where a restoring device finds seeders that hold it
//   sign key  Ed25519, signs each version
//   box key   XChaCha20-Poly1305, encrypts it
//
// The topic, the signature layout and the claim come from the seeder's own
// keyringRecord.js, whose namespaces are protocol constants and stay as they
// are.
//
// A keyring, before encryption:
//
//   { v: 1, groups: { <groupId>: item }, seeders: { <seederKey>: item } }
//   item  { at, entry } for a calendar, { at } for a seeder,
//         { at, removed: true } once left
//   entry { groupId, name, groupKey, encryptionKey?, encrypted, ownerId }
//
// Merging keeps, per id, the item with the later `at`. Removals are kept for
// 30 days so a device that has not caught up cannot add a left calendar back,
// then dropped.
//
// A sealed version, as a seeder stores it:
//
//   { locator, seq, nonce, ciphertext, signKey, sig }   keys hex, bytes base64
//
// The signature covers the locator, seq, nonce and ciphertext, and the locator
// is also the AEAD's additional data, so a ciphertext cannot be moved to
// another address.

const b4a = require('b4a')
const sodium = require('sodium-universal')
const bip39 = require('bip39-mnemonic')
const { hash, signed, checkSealed, topicOf, signClaim, MAX_BYTES } = require('../peerloom-seeder/keyringRecord.js')

const NS = {
  root: 'pearcal/keyring/root/1',
  locator: 'pearcal/keyring/locator/1',
  sign: 'pearcal/keyring/sign/1',
  box: 'pearcal/keyring/box/1',
  // A second keyring at its own address: personal events, private notes and
  // reminders (src/lib/personalKeyring.js, step 5). Same sign and box keys.
  personal: 'pearcal/keyring/personal/1'
}
const MAX_GROUPS = 2000
const MAX_SEEDERS = 32
const MAX_NAME = 200
const TOMBSTONE_MS = 30 * 24 * 60 * 60 * 1000
const KEY = /^[0-9a-f]{64}$/
const GROUP_ID = /^[A-Za-z0-9_-]{1,64}$/
const OWNER_ID = /^[A-Za-z0-9-]{1,64}$/

const hex = (buf) => b4a.toString(buf, 'hex')

// The 32-byte root every keyring key comes from. Throws on a phrase that is
// not a valid 12-word BIP39 phrase, so a typo never derives a wrong keyring.
function rootFromMnemonic (mnemonic) {
  const words = typeof mnemonic === 'string' ? bip39.normalizeMnemonic(mnemonic) : null
  if (!words || words.split(' ').length !== 12 || !bip39.validateMnemonic(words)) throw new Error('Not a valid recovery phrase')
  return hash(b4a.from(bip39.mnemonicToEntropy(words)), NS.root)
}

function deriveKeys (mnemonic) {
  const root = rootFromMnemonic(mnemonic)
  const locator = hash(root, NS.locator)
  const signKeyPair = { publicKey: b4a.alloc(sodium.crypto_sign_PUBLICKEYBYTES), secretKey: b4a.alloc(sodium.crypto_sign_SECRETKEYBYTES) }
  sodium.crypto_sign_seed_keypair(signKeyPair.publicKey, signKeyPair.secretKey, hash(root, NS.sign))
  return { locator, topic: topicOf(locator), signKeyPair, boxKey: hash(root, NS.box), personalLocator: hash(root, NS.personal) }
}

function empty () {
  return { v: 1, groups: {}, seeders: {} }
}

function seal (keyring, keys, seq) {
  return sealAt(clean(keyring), keys.locator, keys, seq)
}

// Any JSON value, sealed at `locator` with the keyring's sign and box keys.
function sealAt (value, locator, keys, seq) {
  if (!Number.isSafeInteger(seq) || seq < 1) throw new Error('seq must be a positive integer')
  const plain = b4a.from(JSON.stringify(value))
  const nonce = b4a.alloc(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES)
  sodium.randombytes_buf(nonce)
  const ciphertext = b4a.alloc(plain.length + sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES)
  sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(ciphertext, plain, locator, null, nonce, keys.boxKey)
  if (ciphertext.length > MAX_BYTES) throw new Error('Too large to back up')
  const sig = b4a.alloc(sodium.crypto_sign_BYTES)
  sodium.crypto_sign_detached(sig, signed(locator, seq, nonce, ciphertext), keys.signKeyPair.secretKey)
  return {
    locator: hex(locator),
    seq,
    nonce: b4a.toString(nonce, 'base64'),
    ciphertext: b4a.toString(ciphertext, 'base64'),
    signKey: hex(keys.signKeyPair.publicKey),
    sig: hex(sig)
  }
}

// The keyring in a sealed version, or null when it is not ours, does not
// check out or does not decrypt.
function open (rec, keys) {
  const parsed = openAt(rec, keys.locator, keys)
  return parsed === null ? null : clean(parsed)
}

// The JSON value sealed at `locator`, or null.
function openAt (rec, locator, keys) {
  const bytes = checkSealed(rec)
  if (!bytes) return null
  if (!b4a.equals(bytes.locator, locator) || !b4a.equals(bytes.signKey, keys.signKeyPair.publicKey)) return null
  const plain = b4a.alloc(bytes.ciphertext.length - sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES)
  try {
    sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(plain, null, bytes.ciphertext, locator, bytes.nonce, keys.boxKey)
  } catch { return null }
  try { return JSON.parse(b4a.toString(plain)) } catch { return null }
}

// What a calendar contributes to the keyring, from its local group record.
// null for a record that cannot be rejoined from (no groupKey), so nothing
// half-usable is backed up.
function entryFromGroup (g) {
  if (!g || typeof g !== 'object') return null
  return cleanEntry({
    groupId: g.id,
    name: g.name,
    groupKey: g.groupKey,
    encryptionKey: g.encryptionKey,
    encrypted: !!(g.encrypted || g.encryptionKey),
    ownerId: g.ownerId
  })
}

function cleanEntry (e) {
  if (!e || typeof e !== 'object') return null
  if (typeof e.groupId !== 'string' || !GROUP_ID.test(e.groupId)) return null
  if (typeof e.groupKey !== 'string' || !KEY.test(e.groupKey)) return null
  if (typeof e.ownerId !== 'string' || !OWNER_ID.test(e.ownerId)) return null
  const out = {
    groupId: e.groupId,
    name: typeof e.name === 'string' ? e.name.slice(0, MAX_NAME) : '',
    groupKey: e.groupKey,
    encrypted: e.encrypted === true,
    ownerId: e.ownerId
  }
  if (e.encryptionKey !== undefined && e.encryptionKey !== null) {
    if (typeof e.encryptionKey !== 'string' || !KEY.test(e.encryptionKey)) return null
    out.encryptionKey = e.encryptionKey
    out.encrypted = true
  }
  return out
}

function cleanItem (item, isGroup) {
  if (!item || typeof item !== 'object' || !Number.isSafeInteger(item.at) || item.at < 0) return null
  if (item.removed === true) return { at: item.at, removed: true }
  if (!isGroup) return { at: item.at }
  const entry = cleanEntry(item.entry)
  return entry ? { at: item.at, entry } : null
}

// Drops anything malformed, so a damaged or hostile keyring cannot carry bad
// keys into a restore.
function clean (k) {
  const out = empty()
  if (!k || typeof k !== 'object' || k.v !== 1) return out
  let n = 0
  for (const [id, item] of Object.entries(k.groups || {})) {
    if (!GROUP_ID.test(id) || n >= MAX_GROUPS) continue
    const c = cleanItem(item, true)
    if (c && (c.removed || c.entry.groupId === id)) { out.groups[id] = c; n++ }
  }
  n = 0
  for (const [key, item] of Object.entries(k.seeders || {})) {
    if (!KEY.test(key) || n >= MAX_SEEDERS) continue
    const c = cleanItem(item, false)
    if (c) { out.seeders[key] = c; n++ }
  }
  return out
}

// The later item; on a tie a removal wins, then the larger JSON, so every
// device picks the same one whatever order it merges in.
function later (x, y) {
  if (x.at !== y.at) return x.at > y.at
  if (!!x.removed !== !!y.removed) return !!x.removed
  return JSON.stringify(x) > JSON.stringify(y)
}

function mergeSection (a, b, now) {
  const out = {}
  for (const src of [a, b]) {
    for (const [id, item] of Object.entries(src)) {
      if (!out[id] || later(item, out[id])) out[id] = item
    }
  }
  for (const [id, item] of Object.entries(out)) {
    if (item.removed && item.at < now - TOMBSTONE_MS) delete out[id]
  }
  return out
}

// Both keyrings' items, the later of each; old removals dropped.
function merge (a, b, now = Date.now()) {
  a = clean(a)
  b = clean(b)
  return { v: 1, groups: mergeSection(a.groups, b.groups, now), seeders: mergeSection(a.seeders, b.seeders, now) }
}

// The calendars a keyring still lists.
function groups (k) {
  return Object.values(clean(k).groups).filter((i) => !i.removed).map((i) => i.entry)
}

function seeders (k) {
  return Object.entries(clean(k).seeders).filter(([, i]) => !i.removed).map(([key]) => key)
}

module.exports = {
  deriveKeys, topicOf, signClaim, empty, seal, sealAt, checkSealed, open, openAt, clean, merge,
  entryFromGroup, groups, seeders, NS, MAX_BYTES, MAX_GROUPS, TOMBSTONE_MS
}
