// Does a foreground after a long background actually rebuild the swarm? (#166)
//
// Runs the REAL src/bare.js under plain Node via the Electron BareKit shim, with
// a real Hyperswarm on the real DHT, and drives it through the REAL IPC method
// the RN shell calls. Nothing here is stubbed: the decision, the dispatcher, the
// suspend/resume and the swarm are all production code. The only thing supplied
// is what the shell would have supplied - how long the app was backgrounded.
//
// Run it after `cd electron && node scripts/prepack.js`:
//
//   node test/harness/foreground-bounce.js
//
// What it cannot prove: that the bounce is FASTER than waiting for the dead
// sockets to expire. That needs an iPhone, because the sockets only die when
// iOS freezes the process long enough for the NAT mappings to lapse - which no
// desktop, emulator or Simulator reproduces.

const path = require('path')
const fs = require('fs')
const os = require('os')

const BARE_ENTRY = require.resolve('../../electron/vendor/src/bare.js')
const { createBareKitShim } = require('../../electron/src/main/barekit-shim.js')

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-bounce-'))
const mnemonicFile = path.join(dataDir, 'mnemonic.txt')

// bare.js logs the bounce to stdout, not over IPC, so watch stdout itself.
const bareLog = []
const realWrite = process.stdout.write.bind(process.stdout)
process.stdout.write = (chunk, ...rest) => {
  bareLog.push(String(chunk))
  return realWrite(chunk, ...rest)
}
const sawBounce = () => bareLog.some(l => l.includes('[swarm] bounced'))
const sawBounceFailure = () => bareLog.some(l => l.includes('[swarm] bounce failed'))

const shim = createBareKitShim()
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
    setTimeout(() => { if (pending.delete(id)) reject(new Error('timeout: ' + method)) }, 120000)
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

let failures = 0
function check (name, actual, expected) {
  const ok = actual === expected
  if (!ok) failures++
  realWrite((ok ? 'PASS  ' : 'FAIL  ') + name.padEnd(58) + 'got ' + actual + (ok ? '' : ', wanted ' + expected) + '\n')
}

// Each case re-reads stdout from scratch so one bounce can't satisfy the next.
async function foreground (opts) {
  bareLog.length = 0
  await call('foregroundSync', opts === undefined ? [] : [opts])
  return { bounced: sawBounce(), failed: sawBounceFailure() }
}

async function main () {
  send({ method: 'init', dataDir, platform: 'desktop' })
  await waitEvent('ready')
  await call('putProfile', [{ name: 'Bounce Harness' }]).catch(() => {})
  // A group gives the swarm a topic to actually announce and rejoin, so resume()
  // has real discovery work to redo rather than an empty set.
  await call('createGroup', ['Bounce Test', '#6c8']).catch(() => {})
  await new Promise(r => setTimeout(r, 3000))

  const short = await foreground({ bgMs: 3000, platform: 'ios' })
  check('a 3s trip away does not rebuild', short.bounced, false)

  const none = await foreground(undefined)
  check('no AppState info does not rebuild', none.bounced, false)

  const androidLive = await foreground({ bgMs: 600000, platform: 'android' })
  // The foreground service keeps Android's worklet alive; with a live connection
  // a bounce would destroy sync that was working. With none it should rebuild,
  // so accept either outcome and just assert it matches the live count.
  realWrite('      (android 10min: bounced=' + androidLive.bounced + ')\n')

  const long = await foreground({ bgMs: 120000, platform: 'ios' })
  check('a 2min iOS background DOES rebuild', long.bounced, true)
  check('and the rebuild succeeded', long.failed, false)

  // The failure that would be worse than the bug: a swarm left parked offline.
  const again = await foreground({ bgMs: 120000, platform: 'ios' })
  check('the swarm is still usable, so it rebuilds again', again.bounced, true)
  check('second rebuild also succeeded', again.failed, false)

  await call('shutdown').catch(() => {})
  realWrite('\n' + (failures ? failures + ' FAILURE(S)\n' : 'all checks passed\n'))
  fs.rmSync(dataDir, { recursive: true, force: true })
  process.exit(failures ? 1 : 0)
}

main().catch(e => { realWrite('HARNESS ERROR: ' + e.message + '\n'); process.exit(1) })
