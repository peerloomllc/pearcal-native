// Keeping the personal keyring (personalKeyring.js) on this person's PeerLoom
// Seeders up to date: personal events, private notes and reminders
// (proposals/2026-10-22-phrase-recovers-calendars.md section 4, step 5).
//
// On whenever the device is paired with a seeder, like the calendar list. At
// most once every 10 minutes (decided in the proposal), and only when the
// snapshot changed or a paired seeder does not hold the latest version yet.
// Each write fetches the version every seeder holds, merges this device's
// snapshot over it, seals it with the next seq and puts it on every paired
// seeder. The last version written is kept as `personal:local`.
//
// Everything that touches the app comes in as a function, so this runs in
// tests without a database, a swarm or a seeder.

const b4a = require('b4a')
const sodium = require('sodium-universal')
const { deriveKeys } = require('./keyring.js')
const { merge, seal, open, empty } = require('./personalKeyring.js')

const hex = (buf) => b4a.toString(buf, 'hex')

function fingerprintOf (snapshot) {
  const out = b4a.alloc(16)
  sodium.crypto_generichash(out, b4a.from(JSON.stringify(snapshot)))
  return hex(out)
}

// The merged personal keyring the given seeders hold, with the highest seq
// and which seeders had one that opens.
async function fetchPersonal (seederKeys, keys, keyringGet) {
  const locator = hex(keys.personalLocator)
  let snapshot = null
  let seq = 0
  const holders = []
  const got = await Promise.all(seederKeys.map((s) => keyringGet(s, locator).catch(() => null)))
  got.forEach((rec, i) => {
    const p = rec && open(rec, keys)
    if (!p) return
    holders.push(seederKeys[i])
    seq = Math.max(seq, rec.seq)
    snapshot = snapshot ? merge(snapshot, p) : p
  })
  return { snapshot, seq, holders }
}

/**
 * @param {object} o
 * @param {() => Promise<string>} o.getMnemonic
 * @param {() => Promise<object>} o.snapshot  this device's personal data, personalKeyring format
 * @param {() => Promise<string[]>} o.listSeeders
 * @param {(seederKey: string, locator: string) => Promise<object|null>} o.keyringGet
 * @param {(seederKey: string, rec: object) => Promise<void>} o.keyringPut
 * @param {{ get: (k: string) => Promise<any>, put: (k: string, v: any) => Promise<void> }} o.store
 */
function createPersonalBackup ({ getMnemonic, snapshot, listSeeders, keyringGet, keyringPut, store, log = () => {}, now = () => Date.now(), gapMs = 10 * 60 * 1000, checkMs = 10 * 60 * 1000, settleMs = 30 * 1000 }) {
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
    return (await store.get('personal:local')) || { seq: 0, fingerprint: '', held: [], locator: null }
  }

  async function write ({ force = false } = {}) {
    if (closed) return { written: false }
    const seederKeys = await listSeeders()
    if (!seederKeys.length) return { written: false }
    const ks = await keysNow()
    const locator = hex(ks.personalLocator)
    const mine = await snapshot()
    const fingerprint = fingerprintOf(mine)
    let last = await local()
    // Restored over another identity: start again.
    if (last.locator && last.locator !== locator) last = { seq: 0, fingerprint: '', held: [], locator }
    if (!force && fingerprint === last.fingerprint && seederKeys.every((s) => last.held.includes(s))) return { written: false }

    const theirs = await fetchPersonal(seederKeys, ks, keyringGet)
    const merged = merge(mine, theirs.snapshot || empty(), now())
    const seq = Math.max(last.seq, theirs.seq) + 1
    const { rec, dropped } = seal(merged, ks, seq)
    const held = []
    let behind = false
    for (const s of seederKeys) {
      try {
        await keyringPut(s, rec)
        held.push(s)
      } catch (e) {
        const why = e?.message || String(e)
        if (/newer/.test(why)) behind = true
        log('personal data not backed up to ' + s.slice(0, 8) + ': ' + why)
      }
    }
    await store.put('personal:local', { seq, fingerprint, held, locator, at: now(), events: Object.keys(merged.events).length, dropped })
    if (behind) poke({ soon: true })
    return { written: true, seq, held, dropped }
  }

  function run (opts) {
    if (running) return running
    // Only a write counts towards the 10 minutes: a run with no seeder paired
    // yet must not hold back the first real one.
    running = write(opts)
      .then((r) => { if (r.written) lastRun = now(); return r })
      .catch((e) => { log('personal backup: ' + (e?.message || e)); return { written: false, error: e?.message } })
      .finally(() => { running = null })
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

  async function status () {
    const last = await local()
    const paired = await listSeeders()
    return { seeders: last.held.filter((s) => paired.includes(s)).length, paired: paired.length, at: last.at || null, events: last.events ?? null, dropped: last.dropped || 0 }
  }

  function close () {
    closed = true
    clearTimeout(timer)
    clearInterval(checker)
  }

  return { start, poke, run, status, close }
}

module.exports = { createPersonalBackup, fetchPersonal }
