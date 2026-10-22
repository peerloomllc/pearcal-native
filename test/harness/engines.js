// Running real PearCal engines side by side for the harnesses: each a copy of
// src/bare.js in its own process (BareKit is a singleton), on a private local
// DHT so nothing depends on NAT or the internet (TODO #133). Shared by
// signer-policy-e2e.js and keyring-e2e.js.
//
// The mobile engine and its own node_modules, which is what ships to phones.
// PEARCAL_E2E_ENGINE=desktop runs the desktop's copy (electron/vendor, after
// `cd electron && node scripts/prepack.js`) with electron/node_modules instead.
//
// Test data goes on disk, not os.tmpdir(): /tmp is a RAM disk on Tim's machine
// and one run writes hundreds of MB. PEARCAL_TEST_TMP overrides. A run that
// passes deletes its data; a failing one keeps it with the logs.

const path = require('path')
const fs = require('fs')
const os = require('os')
const { spawn } = require('child_process')

const BARE_ENTRY = process.env.PEARCAL_E2E_ENGINE === 'desktop'
  ? require.resolve('../../electron/vendor/src/bare.js')
  : require.resolve('../../src/bare.js')

if (require.main === module && process.argv[2] === 'peer') peer()

// ---------------------------------------------------------------- peer process

function peer () {
  const dataDir = process.env.DATA_DIR
  const bootstrap = JSON.parse(process.env.BOOTSTRAP)
  const mnemonicFile = path.join(dataDir, 'mnemonic.txt')
  const fromBare = p => require.resolve(p, { paths: [path.dirname(BARE_ENTRY)] })

  // Point Hyperswarm at the local testnet. Everything else is untouched.
  const hsPath = fromBare('hyperswarm')
  const Hyperswarm = require(hsPath)
  // `block` is a test-only firewall: swarm public keys this peer refuses to
  // connect to in either direction, so two peers can be made to reach each
  // other only through a third (step 1b).
  const blocked = new Set((process.env.BLOCK || '').split(',').filter(Boolean))
  let theSwarm = null
  class LocalSwarm extends Hyperswarm {
    constructor (opts = {}) {
      super({ ...opts, bootstrap, firewall: (key) => blocked.has(key.toString('hex')) })
      theSwarm = this
    }
  }
  require.cache[hsPath].exports = LocalSwarm

  const { createBareKitShim } = require('../../electron/src/main/barekit-shim.js')
  const shim = createBareKitShim()
  const out = o => process.stdout.write('@@' + JSON.stringify(o) + '\n')
  const toBare = o => shim.sendToBare(Buffer.from(JSON.stringify(o) + '\n'))
  const events = []
  let buf = ''
  shim.onBareOut(chunk => {
    buf += chunk.toString()
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      let m; try { m = JSON.parse(line) } catch (e) { continue }
      if (m.type === 'response') out(m)
      if (m.type === 'event') events.push(m.event)
      if (m.type === 'nativeRequest') {
        let result = null
        if (m.method === 'hasMnemonic') result = fs.existsSync(mnemonicFile)
        else if (m.method === 'getMnemonic') result = fs.existsSync(mnemonicFile) ? fs.readFileSync(mnemonicFile, 'utf8') : null
        else if (m.method === 'setMnemonic') { fs.writeFileSync(mnemonicFile, m.args[0]); result = true }
        else if (m.method === 'getBackupStatus') result = { enabled: false }
        toBare({ type: 'nativeResponse', nativeId: m.nativeId, result })
      }
    }
  })
  require(BARE_ENTRY)

  const waitEvent = (name, ms = 90000) => new Promise((resolve, reject) => {
    const start = Date.now()
    const iv = setInterval(() => {
      if (events.includes(name)) { clearInterval(iv); resolve() }
      else if (Date.now() - start > ms) { clearInterval(iv); reject(new Error('no ' + name)) }
    }, 100)
  })
  let inBuf = ''
  process.stdin.on('data', async chunk => {
    inBuf += chunk.toString()
    const lines = inBuf.split('\n')
    inBuf = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      const m = JSON.parse(line)
      if (m.ctl === 'swarmKey') {
        out({ type: 'response', id: m.id, result: theSwarm ? theSwarm.keyPair.publicKey.toString('hex') : null })
      } else if (m.ctl === 'block') {
        blocked.add(m.key)
        for (const c of theSwarm ? theSwarm.connections : []) if (c.remotePublicKey && c.remotePublicKey.toString('hex') === m.key) c.destroy()
        out({ type: 'response', id: m.id, result: true })
      } else if (m.ctl === 'start') {
        await waitEvent('bareReady', 30000)
        toBare({ method: 'init', dataDir, platform: 'desktop' })
        await waitEvent('ready')
        out({ type: 'response', id: m.id, result: true })
      } else {
        toBare(m)
      }
    }
  })
}

// ---------------------------------------------------------------- orchestrator

async function createEngines ({ prefix }) {
  const createTestnet = require(require.resolve('hyperdht/testnet', { paths: [path.dirname(BARE_ENTRY)] }))
  // Three bootstrap nodes left one of three peers unreachable on this host;
  // ten gets every member through to the owner.
  const testnet = await createTestnet(10)
  // Test data goes on disk, not os.tmpdir(): /tmp is a RAM disk on Tim's machine
  // and one run of this script writes hundreds of MB. PEARCAL_TEST_TMP overrides.
  const testTmp = process.env.PEARCAL_TEST_TMP || path.join(os.homedir(), '.cache', 'pearcal-tests')
  fs.mkdirSync(testTmp, { recursive: true })
  const root = fs.mkdtempSync(path.join(testTmp, prefix + '-'))
  console.log('data + logs in', root)

  const peers = {}
  // A restart is a new PROCESS on the same data, the way a phone restarts the
  // app. Re-initialising inside one process never reconnected on this host.
  function launch (name, env = {}) {
    const dir = path.join(root, name)
    fs.mkdirSync(dir, { recursive: true })
    const log = fs.createWriteStream(path.join(root, name + '.log'), { flags: 'a' })
    const proc = spawn(process.execPath, [__filename, 'peer'], {
      env: { ...process.env, DATA_DIR: dir, BOOTSTRAP: JSON.stringify(testnet.bootstrap), ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const pending = new Map()
    let buf = ''
    proc.stdout.on('data', chunk => {
      buf += chunk.toString()
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('@@')) { log.write(line + '\n'); continue }
        const m = JSON.parse(line.slice(2))
        const p = pending.get(m.id)
        if (p) { pending.delete(m.id); m.error ? p.reject(new Error(m.error)) : p.resolve(m.result) }
      }
    })
    proc.stderr.on('data', c => log.write(c))
    let next = 1
    const send = (o, ms = 120000) => new Promise((resolve, reject) => {
      const id = next++
      pending.set(id, { resolve, reject })
      proc.stdin.write(JSON.stringify({ ...o, id }) + '\n')
      setTimeout(() => { if (pending.delete(id)) reject(new Error(name + ' timeout: ' + (o.method || o.ctl))) }, ms)
    })
    peers[name] = {
      dir,
      proc,
      call: (method, ...args) => send({ method, args }),
      ctl: (ctl, extra = {}, ms) => send({ ctl, ...extra }, ms),
    }
    return peers[name].ctl('start')
  }
  async function stop (name) {
    await peers[name].call('shutdown').catch(() => {})
    const exited = new Promise(r => peers[name].proc.once('exit', r))
    peers[name].proc.kill('SIGKILL')
    await exited
  }
  // The one thing faked: time. Written into a stopped peer's real database.
  async function backdate (name, gid, edit) {
    const fromBare = p => require(require.resolve(p, { paths: [path.dirname(BARE_ENTRY)] }))
    const Hypercore = fromBare('hypercore')
    const Hyperbee = fromBare('hyperbee')
    const core = new Hypercore(peers[name].dir + '/core', { valueEncoding: 'json' })
    await core.ready()
    const db = new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'json' })
    await db.ready()
    let n = 0
    for await (const { key, value } of db.createReadStream({ gt: 'deviceVersion:' + gid + ':', lt: 'deviceVersion:' + gid + ':\xff' })) {
      await db.put(key, edit(key.split(':').pop(), value)); n++
    }
    await db.close(); await core.close()
    return n
  }

  let failures = 0
  const check = (label, ok, detail = '') => {
    if (!ok) failures++
    console.log((ok ? 'PASS  ' : 'FAIL  ') + label.padEnd(58) + detail)
  }
  const until = async (fn, ms, every = 2000) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      const v = await fn().catch(() => null)
      if (v) return v
      await new Promise(r => setTimeout(r, every))
    }
    return null
  }
  const finish = async code => {
    // Wait for every engine to be gone before deleting its data: removing a
    // folder a dying process is still writing to fails and left 450 MB behind.
    await Promise.all(Object.values(peers).map(p => new Promise(resolve => {
      if (p.proc.exitCode !== null || p.proc.signalCode !== null) return resolve()
      p.proc.once('exit', resolve)
      p.proc.kill('SIGKILL')
    })))
    await testnet.destroy().catch(() => {})
    // Keep the data and logs only when something failed; a pass leaves nothing.
    if (failures) console.log('\n' + failures + ' FAILED (logs in ' + root + ')')
    else {
      console.log('\nALL CHECKS PASSED')
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
    }
    process.exit(code)
  }

  return { testnet, root, peers, launch, stop, backdate, check, until, finish, failures: () => failures, BARE_ENTRY }
}

module.exports = { createEngines, BARE_ENTRY }
