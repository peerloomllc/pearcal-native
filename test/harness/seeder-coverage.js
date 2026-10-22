// Does a PeerLoom Seeder end up holding EVERY member's writes for a calendar,
// when only one member is paired with it? (TODO #180)
//
// Found on the TCL restore test (#176, 2026-10-22): the Start9 seeder held the
// TCL's own writer cores but was missing other members' cores that the TCL
// had in full, so a restore from the seeder could not rebuild the calendars.
//
// Two PearCal engines and peerloom-seeder's own createSeeder on a local DHT.
// The owner and Ana both write to a calendar. Ana goes offline, the owner
// restarts and (only) the owner pairs with the seeder. Ana comes back and
// writes again. The checks read the seeder's
// own store.
//
// Needs the sibling checkout ../peerloom-seeder. Run from the repo root:
//
//   node test/harness/seeder-coverage.js
//
// Checks:
//   1. The seeder holds all of the owner's writes.
//   2. With Ana offline and the owner restarted, the seeder gets Ana's
//      earlier writes from the owner.
//   3. The seeder holds Ana's writes from after the pairing.
//   4. keyringStatus reports the calendar as fully on the seeder (#181).

const path = require('path')
const fs = require('fs')
const b4a = require('b4a')
const { createEngines } = require('./engines.js')

const SEEDER_REPO = path.join(__dirname, '..', '..', '..', 'peerloom-seeder')

main().catch(e => { console.error('harness error:', e.stack); process.exit(1) })

async function main () {
  if (!fs.existsSync(path.join(SEEDER_REPO, 'src', 'seeder.js'))) {
    console.log('SKIP: no ../peerloom-seeder checkout')
    process.exit(0)
  }
  const { createSeeder } = require(path.join(SEEDER_REPO, 'src', 'seeder.js'))
  const E = await createEngines({ prefix: 'seeder-coverage' })
  const { peers, launch, check, until, finish } = E

  const seederDir = path.join(E.root, 'seeder')
  fs.mkdirSync(seederDir, { recursive: true })
  const seeder = await createSeeder({ dataDir: seederDir, bootstrap: E.testnet.bootstrap })
  const done = async () => { await seeder.close().catch(() => {}); return finish(E.failures() ? 1 : 0) }

  // What the seeder holds of the core whose key starts with `prefix`.
  async function held (prefix) {
    const store = seeder.peer.store
    for await (const dk of store.list()) {
      const core = store.get({ discoveryKey: dk })
      try {
        await core.ready()
        if (!b4a.toString(core.key, 'hex').startsWith(prefix)) continue
        return { length: core.length, contiguous: core.contiguousLength }
      } catch {} finally { await core.close().catch(() => {}) }
    }
    return null
  }
  const local = async (name, gid) => (await peers[name].call('debugGroup', gid))?.me

  await Promise.all(['owner', 'ana'].map(n => launch(n)))
  console.log('two engines and a seeder up\n')

  const group = await peers.owner.call('createGroup', 'Coverage', {})
  await peers.ana.call('putGroup', group)
  await peers.ana.call('joinGroup', group)
  const put = async (name, n, tag) => {
    for (let i = 0; i < n; i++) {
      const ev = { id: 'e-' + tag + '-' + i, date: '2026-11-0' + (1 + i), title: tag + ' ' + i, groups: [group.id] }
      await peers[name].call('putEvent', ev)
      await peers[name].call('putEvent:sync', group.id, ev)
    }
  }
  // Ana must be a writer before her events count.
  await until(async () => (await peers.ana.call('listGroups')).find(g => g.id === group.id)?.members?.length >= 2 || null, 120000, 3000)
  await until(async () => (await peers.ana.call('debugGroup', group.id))?.b || null, 120000, 3000)
  await put('owner', 3, 'owner')
  await put('ana', 3, 'ana-before')
  const ownerSees = await until(async () => {
    const evs = await peers.owner.call('listEvents', {})
    return evs.filter(e => e.id.startsWith('e-ana-before')).length === 3 || null
  }, 120000, 3000)
  console.log('      owner has Ana\'s events:', !!ownerSees)
  const ownerKey = await local('owner', group.id)
  const anaKey = await local('ana', group.id)
  // As on the TCL: the other member is offline when the owner pairs, and the
  // owner has restarted since Ana's writes arrived, so only the owner can hand
  // them to the seeder.
  await E.stop('ana')
  await E.stop('owner')
  await launch('owner')
  const { link } = seeder.openPairing()
  await peers.owner.call('pairPeerloomSeeder', link)
  console.log('      owner restarted and paired, Ana offline; owner writer', ownerKey, 'ana writer', anaKey)

  const full = (h) => h && h.length > 0 && h.contiguous === h.length
  const o = await until(async () => { const h = await held(ownerKey); return full(h) ? h : null }, 150000, 5000)
  check("1. the seeder holds all of the owner's writes", !!o, JSON.stringify(o || await held(ownerKey)))
  const b = await until(async () => { const h = await held(anaKey); return full(h) && h.length >= 4 ? h : null }, 150000, 5000)
  check("2. the seeder holds Ana's writes from before the pairing, from the owner", !!b, JSON.stringify(b || await held(anaKey)))

  await launch('ana')
  await until(async () => (await peers.ana.call('debugGroup', group.id))?.b || null, 120000, 3000)
  await put('ana', 2, 'ana-after')
  await until(async () => {
    const evs = await peers.owner.call('listEvents', {})
    return evs.filter(e => e.id.startsWith('e-ana-after')).length === 2 || null
  }, 120000, 3000)

  // Give the seeder time to fetch: a few of the owner's minute-long pulls.
  const anaLen = (await peers.ana.call('debugGroup', group.id))?.writers?.find(w => anaKey.startsWith(w.k) || w.k.startsWith(anaKey.slice(0, 12)))?.core
  const a = await until(async () => { const h = await held(anaKey); return full(h) && h.length === anaLen ? h : null }, 150000, 5000)
  check("3. the seeder holds Ana's writes from after the pairing", !!a, JSON.stringify(a || await held(anaKey)) + ' ana has ' + anaLen)

  // #181: Settings says so, from what the owner sees on its pulls.
  const cov = await until(async () => { const c = (await peers.owner.call('keyringStatus'))?.calendars; return c && c.total >= 1 && c.complete === c.total ? c : null }, 180000, 5000)
  check('4. Settings says the calendar is fully on the seeder', !!cov, JSON.stringify(cov || (await peers.owner.call('keyringStatus'))?.calendars))

  await done()
}
