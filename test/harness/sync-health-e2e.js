// Does a REAL stale verdict come out of the REAL engine? (#155 / PR #296)
//
// Everything here is production code except the passage of time. It runs the
// actual src/bare.js under plain Node via the Electron BareKit shim, creates a
// real group, then backdates two timestamps in its real database and asks
// listGroups what it thinks. No shortened thresholds, no stubbed classifier, no
// forced return values - the failure mode of every shortcut is that it proves
// the plumbing while exercising different arithmetic than production.
//
// Run it after `cd electron && node scripts/prepack.js`:
//
//   node test/harness/sync-health-e2e.js
//
// Four cases, and three of them are the ones where warning would be the bug.

const path = require('path')
const fs = require('fs')
const os = require('os')

const BARE_ENTRY = require.resolve('../../electron/vendor/src/bare.js')
const { createBareKitShim } = require('../../electron/src/main/barekit-shim.js')
const { tmpDir } = require('../helpers/tmpdir')

const DAY = 24 * 60 * 60 * 1000
const shim = createBareKitShim()
const dataDir = tmpDir('sh-e2e-')
const mnemonicFile = path.join(dataDir, 'mnemonic.txt')

let buf = ''
let nextId = 1
const pending = new Map()
const events = []

function send (o) { shim.sendToBare(Buffer.from(JSON.stringify(o) + '\n')) }

function call (method, args = []) {
  return new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    send({ id, method, args })
    setTimeout(() => { if (pending.delete(id)) reject(new Error('timeout: ' + method)) }, 60000)
  })
}

shim.onBareOut(chunk => {
  buf += chunk.toString()
  const lines = buf.split('\n')
  buf = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.trim()) continue
    let m; try { m = JSON.parse(line) } catch (e) { continue }
    if (m.type === 'response' && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id)
      m.error ? p.reject(new Error(m.error)) : p.resolve(m.result)
    }
    if (m.type === 'event') events.push(m)
    if (m.type === 'nativeRequest') {
      const { nativeId, method } = m
      let result = null
      try {
        if (method === 'hasMnemonic') result = fs.existsSync(mnemonicFile)
        else if (method === 'getMnemonic') result = fs.existsSync(mnemonicFile) ? fs.readFileSync(mnemonicFile, 'utf8') : null
        else if (method === 'setMnemonic') { fs.writeFileSync(mnemonicFile, m.args[0]); result = true }
        else if (method === 'getBackupStatus') result = { enabled: false }
      } catch (e) {}
      send({ type: 'nativeResponse', nativeId, result })
    }
  }
})

require(BARE_ENTRY)

const waitEvent = (name, ms = 90000) => new Promise((resolve, reject) => {
  const start = Date.now()
  const iv = setInterval(() => {
    if (events.some(e => e.event === name)) { clearInterval(iv); resolve() }
    else if (Date.now() - start > ms) { clearInterval(iv); reject(new Error('no ' + name)) }
  }, 100)
})

// The only thing faked: the clock. Written through the SAME database the engine
// reads, so the classifier sees exactly what it would see after a real lapse.
// The worklet holds an exclusive lock on this database while it runs - the very
// thing PR #288 was about - so it has to be shut down around the write, then
// brought back up. That also means each case re-exercises init.
async function backdate (Hyperbee, Hypercore, entries) {
  // Await the shutdown RESPONSE rather than guessing at a delay: the lock is
  // only released once every handle is actually closed.
  await call('shutdown').catch(() => {})
  await new Promise(r => setTimeout(r, 1500))
  const core = new Hypercore(dataDir + '/core', { valueEncoding: 'json' })
  await core.ready()
  const db = new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'json' })
  await db.ready()
  for (const [k, v] of entries) await db.put(k, v)
  await db.close(); await core.close()
  events.length = 0
  send({ method: 'init', dataDir, platform: 'desktop' })
  await waitEvent('ready')
}

let failures = 0
function check (name, actual, expected) {
  const ok = actual === expected
  if (!ok) failures++
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name.padEnd(52) + 'got ' + actual + (ok ? '' : ', wanted ' + expected))
}

async function main () {
  const fromBare = p => require(require.resolve(p, { paths: [path.dirname(BARE_ENTRY)] }))
  const Hyperbee = fromBare('hyperbee')
  const Hypercore = fromBare('hypercore')

  await waitEvent('bareReady', 30000)
  send({ method: 'init', dataDir, platform: 'desktop' })
  await waitEvent('ready')
  console.log('worklet up, real data dir:', dataDir, '\n')

  const group = await call('createGroup', ['StaleTest', {}])
  const gid = group.id
  console.log('created group', gid, '\n')

  const health = async () => (await call('listGroups')).find(g => g.id === gid)?.syncHealth

  // 1. Fresh group, one member. Nobody to sync with, so silence is not a fault.
  check('fresh single-member group', (await health())?.state, 'alone')

  // 2. Two members but only just joined: still settling.
  const twoMembers = { ...group, members: [{ id: 'me', name: 'Me' }, { id: 'them', name: 'Them' }] }
  await call('putGroup', [twoMembers])
  await backdate(Hyperbee, Hypercore, [['joinedAt:' + gid, { ts: Date.now() - 5 * 60 * 1000 }]])
  check('two members, joined 5 minutes ago', (await health())?.state, 'ok')

  // 3. Joined long ago, but this device only started watching moments ago. This
  //    is the false alarm caught on the TCL: every pre-existing group looks
  //    silent the instant the feature ships.
  await backdate(Hyperbee, Hypercore, [
    ['joinedAt:' + gid, { ts: Date.now() - 90 * DAY }],
    ['syncWatchSince', { ts: Date.now() - 60 * 1000 }],
  ])
  check('joined 90d ago, watching for 1 minute', (await health())?.state, 'ok')

  // 4. THE REAL THING: watched for days, exchanged nothing.
  await backdate(Hyperbee, Hypercore, [
    ['syncWatchSince', { ts: Date.now() - 5 * DAY }],
    ['lastSync:' + gid, { ts: Date.now() - 3 * DAY }],
  ])
  const stale = await health()
  check('watched 5d, last exchange 3d ago', stale?.state, 'stale')
  console.log('       reason:', stale?.reason, '| sinceMs:', Math.round((stale?.sinceMs ?? 0) / DAY) + ' days')

  console.log('\n' + (failures ? failures + ' FAILED' : 'all four verdicts correct, from the real engine'))
  process.exit(failures ? 1 : 0)
}

main().catch(e => { console.error('harness error:', e.message); process.exit(1) })
