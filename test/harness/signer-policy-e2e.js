// Does the signer policy (TODO #159 release N+1) work in the REAL engine?
//
// Three copies of src/bare.js, each in its own process (BareKit is a
// singleton), on a private local DHT so nothing depends on NAT or the internet
// (TODO #133). Production code throughout; the one thing faked is the passage
// of time, by backdating `firstSeen` in the stopped owner's real database the
// way sync-health-e2e.js backdates its timestamps.
//
// Run it from the repo root:
//
//   node test/harness/signer-policy-e2e.js
//
// Checks:
//   1. Two members join an owner's calendar as PLAIN writers: one signer.
//   2. Once they have been around past the stability window, the owner
//      promotes both in one batch: three signers, and every peer agrees.
//   3. Reconnecting does not undo it (no re-grant on announce).
//   4. The calendar still signs new entries with three signers.

const path = require('path')
const fs = require('fs')
const os = require('os')
const { spawn } = require('child_process')

// The mobile engine and its own node_modules, which is what ships to phones.
const BARE_ENTRY = require.resolve('../../src/bare.js')
const DAY = 24 * 60 * 60 * 1000

if (process.argv[2] === 'peer') peer()
else main().catch(e => { console.error('harness error:', e.stack); process.exit(1) })

// ---------------------------------------------------------------- peer process

function peer () {
  const dataDir = process.env.DATA_DIR
  const bootstrap = JSON.parse(process.env.BOOTSTRAP)
  const mnemonicFile = path.join(dataDir, 'mnemonic.txt')
  const fromBare = p => require.resolve(p, { paths: [path.dirname(BARE_ENTRY)] })

  // Point Hyperswarm at the local testnet. Everything else is untouched.
  const hsPath = fromBare('hyperswarm')
  const Hyperswarm = require(hsPath)
  class LocalSwarm extends Hyperswarm {
    constructor (opts = {}) { super({ ...opts, bootstrap }) }
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
      if (m.ctl === 'start') {
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

async function main () {
  const createTestnet = require(require.resolve('hyperdht/testnet', { paths: [path.dirname(BARE_ENTRY)] }))
  // Three bootstrap nodes left one of three peers unreachable on this host;
  // ten gets every member through to the owner.
  const testnet = await createTestnet(10)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'signer-e2e-'))
  console.log('data + logs in', root)

  const peers = {}
  // A restart is a new PROCESS on the same data, the way a phone restarts the
  // app. Re-initialising inside one process never reconnected on this host.
  function launch (name) {
    const dir = path.join(root, name)
    fs.mkdirSync(dir, { recursive: true })
    const log = fs.createWriteStream(path.join(root, name + '.log'), { flags: 'a' })
    const proc = spawn(process.execPath, [__filename, 'peer'], {
      env: { ...process.env, DATA_DIR: dir, BOOTSTRAP: JSON.stringify(testnet.bootstrap) },
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
  // The one thing faked: time. Written into the stopped owner's real database.
  async function backdateFirstSeen (name, gid, ms) {
    const fromBare = p => require(require.resolve(p, { paths: [path.dirname(BARE_ENTRY)] }))
    const Hypercore = fromBare('hypercore')
    const Hyperbee = fromBare('hyperbee')
    const core = new Hypercore(peers[name].dir + '/core', { valueEncoding: 'json' })
    await core.ready()
    const db = new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'json' })
    await db.ready()
    let n = 0
    for await (const { key, value } of db.createReadStream({ gt: 'deviceVersion:' + gid + ':', lt: 'deviceVersion:' + gid + ':\xff' })) {
      await db.put(key, { ...value, firstSeen: Date.now() - ms }); n++
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
  const info = async (name, gid) => (await peers[name].call('listGroups')).find(g => g.id === gid)?.indexers
  const finish = code => {
    for (const p of Object.values(peers)) p.proc.kill('SIGKILL')
    testnet.destroy().catch(() => {})
    console.log('\n' + (failures ? failures + ' FAILED' : 'ALL CHECKS PASSED') + ' (logs in ' + root + ')')
    process.exit(code)
  }

  await Promise.all(['owner', 'ana', 'ben'].map(launch))
  console.log('three engines up\n')

  const group = await peers.owner.call('createGroup', 'SignerTest', {})
  const gid = group.id
  // One at a time: joining both at once left the second one's every
  // connection timing out on this host.
  await peers.ana.call('joinGroup', group)
  await until(async () => ((await peers.owner.call('listGroups')).find(x => x.id === gid)?.members?.length ?? 0) >= 2, 120000)
  await peers.ben.call('joinGroup', group)

  let seen = {}
  const joined = await until(async () => {
    for (const name of Object.keys(peers)) {
      const g = (await peers[name].call('listGroups')).find(x => x.id === gid)
      seen[name] = g ? (g.members?.length ?? 0) + (g.writable === false ? ' read-only' : '') : 'none'
    }
    const g = (await peers.owner.call('listGroups')).find(x => x.id === gid)
    return (g?.members?.length ?? 0) >= 3 ? g : null
  }, 180000)
  check('both members joined', !!joined, 'members seen ' + JSON.stringify(seen))
  if (!joined) return finish(1)
  // Give the grants time to apply everywhere.
  await new Promise(r => setTimeout(r, 15000))

  const before = await info('owner', gid)
  check('1. new members join as plain writers', before?.count === 1, 'signers=' + before?.count + ' policy=' + before?.policy)

  await stop('owner')
  const n = await backdateFirstSeen('owner', gid, 2 * DAY)
  await launch('owner')
  console.log('      backdated firstSeen on', n, 'device records, owner restarted')

  const grown = await until(async () => {
    const i = await info('owner', gid)
    return i?.count === 3 ? i : null
  }, 300000, 5000)
  const last = grown || await info('owner', gid)
  check('2. owner promotes both: three signers', !!grown, 'signers=' + last?.count + ' policy=' + last?.policy)

  const agree = await until(async () => {
    const [a, b] = [await info('ana', gid), await info('ben', gid)]
    return a?.count === 3 && b?.count === 3
  }, 120000)
  check('   every peer agrees on three', !!agree)

  // Restart a member: its reconnect re-announces to everyone.
  await stop('ana')
  await launch('ana')
  await new Promise(r => setTimeout(r, 30000))
  const after = await info('owner', gid)
  check('3. a reconnect does not change the signers', after?.count === 3, 'signers=' + after?.count)

  const today = new Date().toISOString().slice(0, 10)
  for (let i = 0; i < 3; i++) {
    await peers.ben.call('putEvent', { id: 'e2e-' + i, title: 'signed ' + i, date: today, groupId: gid })
  }
  const signed = await until(async () => {
    const i = await info('owner', gid)
    return i && i.total > 0 && i.behind <= 2 ? i : null
  }, 120000)
  const s = signed || await info('owner', gid)
  check('4. new entries get signed', !!signed, 'signed=' + s?.signed + '/' + s?.total)

  finish(failures ? 1 : 0)
}
