// Does the calendar list backup work against a REAL PeerLoom Seeder? (TODO
// #176 step 2, proposals/2026-10-22-phrase-recovers-calendars.md)
//
// Two PearCal engines and peerloom-seeder's own createSeeder, all on a local
// DHT. The owner pairs with the seeder the normal way (pairPeerloomSeeder with
// the link openPairing gives), and the checks read what the seeder holds over
// its protocol, as a restoring device would.
//
// Needs the sibling checkout ../peerloom-seeder. Run from the repo root:
//
//   node test/harness/keyring-e2e.js
//
// Checks:
//   1. After pairing, Settings' status says the list is backed up to 1 seeder.
//   2. The seeder holds a version the owner's 12 words open, listing the
//      calendar with its keys.
//   3. Another person's words do not open it.
//   4. The seeder's files contain neither the calendar's name nor its key.
//   5. A new calendar reaches the seeder's copy.
//   6. A calendar left is marked removed there.

const path = require('path')
const fs = require('fs')
const b4a = require('b4a')
const { createEngines, BARE_ENTRY } = require('./engines.js')
const keyring = require('../../src/lib/keyring.js')
const plsClient = require('../../src/peerloom-seeder/client.js')

const SEEDER_REPO = path.join(__dirname, '..', '..', '..', 'peerloom-seeder')

main().catch(e => { console.error('harness error:', e.stack); process.exit(1) })

async function main () {
  if (!fs.existsSync(path.join(SEEDER_REPO, 'src', 'seeder.js'))) {
    console.log('SKIP: no ../peerloom-seeder checkout')
    process.exit(0)
  }
  const { createSeeder } = require(path.join(SEEDER_REPO, 'src', 'seeder.js'))
  const E = await createEngines({ prefix: 'keyring-e2e' })
  const { peers, launch, check, until, finish } = E

  const seederDir = path.join(E.root, 'seeder')
  fs.mkdirSync(seederDir, { recursive: true })
  const seeder = await createSeeder({ dataDir: seederDir, bootstrap: E.testnet.bootstrap })
  const done = async () => { await seeder.close().catch(() => {}); return finish(E.failures() ? 1 : 0) }

  // A reader with no pairing, as a restoring device is before it claims.
  const DHT = require(require.resolve('hyperdht', { paths: [path.dirname(BARE_ENTRY)] }))
  const dht = new DHT({ bootstrap: E.testnet.bootstrap })
  const reader = plsClient.createAsker({ dht: () => dht, keyPair: DHT.keyPair() })
  const seederHex = () => typeof seeder.seederKey === 'string' ? seeder.seederKey : b4a.toString(seeder.seederKey, 'hex')
  const held = async (keys) => {
    const r = await reader.ask(seederHex(), { t: 'keyring-get', locator: b4a.toString(keys.locator, 'hex') }, 15000).catch(() => null)
    return r?.rec || null
  }

  await Promise.all(['owner', 'ana'].map(n => launch(n)))
  console.log('two engines and a seeder up\n')

  const MARKER = 'Keyring Marker 7Q'
  const group = await peers.owner.call('createGroup', MARKER, {})
  await peers.ana.call('putGroup', group)
  await peers.ana.call('joinGroup', group)

  const { link } = seeder.openPairing()
  const paired = await peers.owner.call('pairPeerloomSeeder', link)
  console.log('      owner paired with the seeder:', paired?.seederKey === seederHex(), JSON.stringify(paired).slice(0, 120))

  const st = await until(async () => { const s = await peers.owner.call('keyringStatus'); return s?.seeders === 1 ? s : null }, 90000)
  check('1. status: backed up to 1 seeder', !!st, JSON.stringify(st || await peers.owner.call('keyringStatus')))

  const ownerWords = fs.readFileSync(path.join(peers.owner.dir, 'mnemonic.txt'), 'utf8')
  const anaWords = fs.readFileSync(path.join(peers.ana.dir, 'mnemonic.txt'), 'utf8')
  const ownerKeys = keyring.deriveKeys(ownerWords)
  const rec = await held(ownerKeys)
  const k = rec && keyring.open(rec, ownerKeys)
  const entry = k && keyring.groups(k).find(e => e.groupId === group.id)
  check("2. the owner's words open the seeder's copy, with the keys", !!entry && entry.groupKey === group.groupKey && entry.encryptionKey === group.encryptionKey && entry.name === MARKER,
    entry ? JSON.stringify({ ...entry, groupKey: entry.groupKey.slice(0, 8), encryptionKey: entry.encryptionKey?.slice(0, 8) }) : 'rec=' + !!rec)

  check("3. someone else's words do not open it", !!rec && keyring.open(rec, keyring.deriveKeys(anaWords)) === null)

  const leaks = []
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name)
      if (f.isDirectory()) walk(p)
      else {
        const buf = fs.readFileSync(p)
        if (buf.includes(MARKER) || buf.includes(group.encryptionKey) || buf.includes(b4a.from(group.encryptionKey, 'hex'))) leaks.push(path.relative(seederDir, p))
      }
    }
  }
  walk(seederDir)
  check("4. the seeder's files hold neither the name nor the key", leaks.length === 0, leaks.join(', '))

  const second = await peers.owner.call('createGroup', 'Second calendar', {})
  const has = async (pred) => until(async () => {
    const r = await held(ownerKeys)
    const kk = r && keyring.open(r, ownerKeys)
    return kk && pred(kk) ? kk : null
  }, 150000, 5000)
  const k5 = await has(kk => keyring.groups(kk).some(e => e.groupId === second.id))
  check('5. a new calendar reaches the seeder', !!k5, k5 ? keyring.groups(k5).map(e => e.name).join(', ') : '')

  // What the app's Delete button does for an owner (App.jsx deleteGroup).
  await peers.owner.call('deleteGroup:sync', group.id).catch(() => {})
  await peers.owner.call('deleteGroup', group.id)
  await peers.owner.call('leaveGroup', group.id)
  const k6 = await has(kk => kk.groups[group.id]?.removed === true)
  check('6. a calendar left is marked removed there', !!k6, k6 ? JSON.stringify(k6.groups[group.id]) : '')

  await dht.destroy().catch(() => {})
  await done()
}
