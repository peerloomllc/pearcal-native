// Bringing calendars back after a restore from the recovery phrase
// (proposals/2026-10-22-phrase-recovers-calendars.md, step 4). Ported from
// pearoffice/src/worklet/restoring.js.
//
// `restoreFromPhrase` in bare.js restores the identity, leaves
// `restore:pending` in the local db and starts this. Then:
//
//   1. looks up the seeders announcing the keyring's topic and asks each for
//      the keyring for up to 90 s, keeping every version that opens, merged;
//   2. claims each seeder that had it, and each seeder it lists, so they
//      treat this device as paired (keyringRecord.js), and pairs with each
//      one that agreed;
//   3. saves each calendar it lists with its keys and joins it, marking it
//      `recovered:{groupId}` until a member's device lets this one in.
//
// A restart part way through carries on from the start: everything above can
// run twice.
//
// Everything that touches the app comes in as a function, so this runs in
// tests without a database, a swarm or a seeder.

const b4a = require('b4a')
const { deriveKeys, open, merge, empty, groups, seeders, signClaim } = require('./keyring.js')

const hex = (buf) => b4a.toString(buf, 'hex')

/**
 * @param {object} o
 * @param {() => Promise<string>} o.getMnemonic
 * @param {(topic: Buffer) => Promise<string[]>} o.lookup  seeder keys announcing the topic
 * @param {(seederKey: string, locator: string) => Promise<object|null>} o.keyringGet
 * @param {(seederKey: string, locator: string, sig: string) => Promise<void>} o.keyringClaim
 * @param {() => Promise<string>} o.deviceKey  the key this device dials seeders with
 * @param {(seederKey: string) => Promise<void>} o.addSeeder  remember as paired
 * @param {(groupId: string) => Promise<boolean>} o.haveGroup
 * @param {(entry: object, seederKeys: string[]) => Promise<void>} o.addGroup  save with its keys, then join
 * @param {{ get, put, del }} o.store
 */
function createRestoring ({ getMnemonic, lookup, keyringGet, keyringClaim, deviceKey, addSeeder, haveGroup, addGroup, store, emit = () => {}, log = () => {}, now = () => Date.now(), lookMs = 90 * 1000, settleMs = 5000, retryMs = 5000 }) {
  let closed = false
  let running = null
  let stop = null

  async function setStatus (status) {
    await store.put('restore:status', { ...status, at: now() })
    emit(status)
  }

  async function status () {
    return (await store.get('restore:status')) || null
  }

  // Asks every seeder announcing the topic. Resolves { keyring, seq, holders }
  // or null when none had one that opens within `lookMs`.
  function find (keys) {
    const locator = hex(keys.locator)
    return new Promise((resolve) => {
      const tried = new Set()
      const holders = []
      let keyring = null
      let seq = 0
      let settle = null
      let again = null
      let finished = false
      const finish = () => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        clearTimeout(settle)
        clearTimeout(again)
        stop = null
        resolve(keyring ? { keyring, seq, holders } : null)
      }
      const tryKey = async (seederKey) => {
        if (tried.has(seederKey) || finished) return
        tried.add(seederKey)
        try {
          const rec = await keyringGet(seederKey, locator)
          const k = rec && open(rec, keys)
          if (!k || finished) return
          holders.push(seederKey)
          keyring = merge(keyring || empty(), k, now())
          seq = Math.max(seq, rec.seq)
          // Give other seeders a moment to answer, then go with what came.
          if (!settle) settle = setTimeout(finish, settleMs)
        } catch (e) {
          // Asked again on the next lookup: it may have been unreachable.
          tried.delete(seederKey)
          log('restore: no calendar list from ' + seederKey.slice(0, 8) + ': ' + (e?.message || e))
        }
      }
      const look = async () => {
        if (finished) return
        const found = await lookup(keys.topic).catch((e) => { log('restore: lookup failed: ' + (e?.message || e)); return [] })
        for (const k of found) tryKey(k)
        if (!finished) again = setTimeout(look, retryMs)
      }
      const timer = setTimeout(finish, lookMs)
      stop = finish
      look()
    })
  }

  async function run () {
    if (closed) return null
    const keys = deriveKeys(await getMnemonic())
    await setStatus({ state: 'looking' })
    const found = await find(keys)
    if (closed) return null
    if (!found) {
      await store.del('restore:pending')
      await setStatus({ state: 'none' })
      log('restore: no calendar list found')
      return { calendars: 0, seeders: 0 }
    }
    const locator = hex(keys.locator)
    const list = groups(found.keyring)
    // Start this device's keyring from what came back, so its next backup
    // carries it on.
    await store.put('keyring:local', { seq: found.seq, keyring: found.keyring, fingerprint: '', held: [], locator, at: now() })
    await setStatus({ state: 'opening', calendars: list.length })

    // Claim first, so each seeder treats this device as paired before it
    // asks for the calendars' data. Every seeder at once: one that is gone
    // does not hold up the rest.
    const fromSeeders = [...new Set([...found.holders, ...seeders(found.keyring)])]
    const me = await deviceKey()
    const claimed = []
    await Promise.all(fromSeeders.map(async (sk) => {
      try {
        await keyringClaim(sk, locator, signClaim(keys.signKeyPair, locator, sk, me))
        await addSeeder(sk)
        claimed.push(sk)
      } catch (e) {
        log('restore: seeder ' + sk.slice(0, 8) + ' did not take this device: ' + (e?.message || e))
      }
    }))

    let added = 0
    for (const e of list) {
      if (closed) return null
      if (await haveGroup(e.groupId)) continue
      try {
        await addGroup(e, claimed.length ? claimed : fromSeeders)
        added++
      } catch (err) {
        log('restore: could not open calendar ' + e.groupId + ': ' + (err?.message || err))
      }
    }
    await store.del('restore:pending')
    await setStatus({ state: 'done', calendars: list.length, added, seeders: claimed.length })
    log('restore: ' + list.length + ' calendars from ' + found.holders.length + ' seeder(s), ' + claimed.length + ' claimed')
    return { calendars: list.length, added, seeders: claimed.length }
  }

  // Starts a restore, or carries on with one a restart cut short.
  async function start () {
    if (closed || !(await store.get('restore:pending'))) return null
    if (!running) {
      running = run().catch(async (e) => {
        // restore:pending stays, so the next start tries again.
        log('restore failed: ' + (e?.message || e))
        await setStatus({ state: 'failed', error: e?.message || String(e) }).catch(() => {})
        return null
      }).finally(() => { running = null })
    }
    return running
  }

  function close () {
    closed = true
    if (stop) stop()
  }

  return { start, status, close }
}

module.exports = { createRestoring }
