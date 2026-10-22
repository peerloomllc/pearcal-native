// Keeping this person's keyring on their PeerLoom Seeders up to date
// (proposals/2026-10-22-phrase-recovers-calendars.md, step 2). Ported from
// pearoffice/src/worklet/keyringSync.js.
//
// On by default once the device is paired with a seeder (decided 2026-10-22).
// When this device's calendars or seeders change, it fetches the keyring from
// each paired seeder, merges in what changed here, seals it with the next seq
// and puts it on every paired seeder. At most once a minute, and a check every
// minute catches changes nothing told it about.
//
// What changed here, against the last keyring this device wrote
// (`keyring:local` in the local db):
//   - a calendar here that is new, or whose entry differs: listed, now;
//   - a calendar the keyring lists that this device left or deleted
//     (`isGone`): marked removed, now. A calendar this device never had (a
//     linked device's) stays as it is;
//   - each paired seeder: listed.
//
// Everything that touches the app comes in as a function, so this runs in
// tests without a database, a swarm or a seeder.

const b4a = require('b4a')
const { deriveKeys, empty, seal, open, clean, merge } = require('./keyring.js')

const hex = (buf) => b4a.toString(buf, 'hex')

// The seeder's refusal (peerloom-seeder src/seeder.js putKeyring, worded for
// PearOffice's "file list") as a reason Settings can act on.
function refusalOf (message) {
  if (/Only paired devices/i.test(message)) return 'not-paired'
  if (/too many/i.test(message)) return 'full'
  if (/belongs to someone else/i.test(message)) return 'taken'
  if (/did not answer|timed out|refused|ECONN|closed/i.test(message)) return 'offline'
  return 'other'
}

/**
 * @param {object} o
 * @param {() => Promise<string>} o.getMnemonic
 * @param {() => Promise<object[]>} o.listGroups   keyring entries for this device's calendars
 * @param {(groupId: string) => Promise<boolean>} o.isGone  left or deleted here
 * @param {() => Promise<string[]>} o.listSeeders  seeders this device is paired with
 * @param {(seederKey: string, locator: string) => Promise<object|null>} o.keyringGet
 * @param {(seederKey: string, rec: object) => Promise<void>} o.keyringPut
 * @param {{ get: (k: string) => Promise<any>, put: (k: string, v: any) => Promise<void> }} o.store
 */
function createKeyringSync ({ getMnemonic, listGroups, isGone, listSeeders, keyringGet, keyringPut, store, emit = () => {}, log = () => {}, now = () => Date.now(), gapMs = 60 * 1000, checkMs = 60 * 1000, settleMs = 3000 }) {
  let keys = null
  let keysFor = null
  let timer = null
  let checker = null
  let running = null
  let lastRun = 0
  let closed = false

  async function keysNow () {
    const mnemonic = await getMnemonic()
    if (!keys || keysFor !== mnemonic) { keys = deriveKeys(mnemonic); keysFor = mnemonic }
    return keys
  }

  async function local () {
    return (await store.get('keyring:local')) || { seq: 0, keyring: empty(), fingerprint: '', held: [], locator: null }
  }

  const fingerprintOf = (entries, seederKeys) => JSON.stringify([entries.map((e) => JSON.stringify(e)).sort(), [...seederKeys].sort()])

  async function withLocalChanges (keyring, entries, seederKeys) {
    const k = clean(keyring)
    const at = now()
    const here = new Set()
    // A change made here is always later than the version it replaces, even
    // within the same millisecond; otherwise the merge's tie-break could keep
    // the old one (caught by the rename test).
    const after = (item) => Math.max(at, item ? item.at + 1 : 0)
    for (const e of entries) {
      here.add(e.groupId)
      const item = k.groups[e.groupId]
      if (!item || item.removed || JSON.stringify(item.entry) !== JSON.stringify(e)) k.groups[e.groupId] = { at: after(item), entry: e }
    }
    for (const [id, item] of Object.entries(k.groups)) {
      if (!item.removed && !here.has(id) && await isGone(id)) k.groups[id] = { at: after(item), removed: true }
    }
    for (const s of seederKeys) if (!k.seeders[s] || k.seeders[s].removed) k.seeders[s] = { at }
    return k
  }

  async function write ({ force = false } = {}) {
    if (closed) return { written: false }
    const seederKeys = await listSeeders()
    if (!seederKeys.length) return { written: false }
    const ks = await keysNow()
    const locator = hex(ks.locator)
    const entries = await listGroups()
    let last = await local()
    // A different identity on this device (restored over another): start
    // again rather than carry the old identity's calendars into the new one.
    if (last.locator && last.locator !== locator) last = { seq: 0, keyring: empty(), fingerprint: '', held: [], locator }
    const fingerprint = fingerprintOf(entries, seederKeys)
    if (!force && fingerprint === last.fingerprint && seederKeys.every((s) => last.held.includes(s))) return { written: false }

    let keyring = await withLocalChanges(last.keyring, entries, seederKeys)
    let seq = last.seq
    const got = await Promise.all(seederKeys.map((s) => keyringGet(s, locator).catch(() => null)))
    for (const rec of got) {
      if (!rec) continue
      const theirs = open(rec, ks)
      if (!theirs) continue
      seq = Math.max(seq, rec.seq)
      keyring = merge(keyring, theirs, now())
    }
    keyring = merge(keyring, empty(), now()) // drops removals older than 30 days
    seq = Math.max(seq + 1, 1)
    const rec = seal(keyring, ks, seq)
    const held = []
    const refused = {}   // seederKey -> why it said no, for Settings
    let behind = false
    for (const s of seederKeys) {
      try {
        await keyringPut(s, rec)
        held.push(s)
      } catch (e) {
        const why = e?.message || String(e)
        if (/newer/.test(why)) behind = true
        else refused[s] = refusalOf(why)
        log('keyring not backed up to ' + s.slice(0, 8) + ': ' + why)
      }
    }
    await store.put('keyring:local', { seq, keyring, fingerprint, held, refused, locator, at: now() })
    emit({ seeders: held.length, paired: seederKeys.length })
    // Another device wrote in between: merge its version in and write again.
    if (behind) poke({ soon: true })
    return { written: true, seq, held }
  }

  function run (opts) {
    if (running) return running
    lastRun = now()
    running = write(opts).catch((e) => { log('keyring: ' + (e?.message || e)); return { written: false, error: e?.message } }).finally(() => { running = null })
    return running
  }

  // Something changed: write within `settleMs`, but at most once per `gapMs`.
  function poke ({ soon = false } = {}) {
    if (closed || timer) return
    const wait = soon ? settleMs : Math.max(settleMs, lastRun + gapMs - now())
    timer = setTimeout(() => { timer = null; run() }, wait)
    if (timer.unref) timer.unref()
  }

  function start () {
    poke({ soon: true })
    checker = setInterval(() => poke(), checkMs)
    if (checker.unref) checker.unref()
  }

  // For Settings: how many paired seeders hold the latest version, and when,
  // and why any paired seeder said no.
  async function status () {
    const last = await local()
    const paired = await listSeeders()
    const refused = {}
    for (const s of paired) if (last.refused?.[s]) refused[s] = last.refused[s]
    return { seeders: last.held.filter((s) => paired.includes(s)).length, paired: paired.length, at: last.at || null, refused }
  }

  function close () {
    closed = true
    clearTimeout(timer)
    clearInterval(checker)
  }

  return { start, poke, run, status, close }
}

module.exports = { createKeyringSync, refusalOf }
