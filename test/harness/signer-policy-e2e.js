// Does the signer policy (TODO #159 release N+1) work in the REAL engine?
//
// Four copies of src/bare.js, each in its own process (BareKit is a
// singleton), on a private local DHT so nothing depends on NAT or the internet
// (TODO #133). Production code throughout; the one thing faked is the passage
// of time, by backdating timestamps in a stopped peer's real database the way
// sync-health-e2e.js does.
//
// Run it from the repo root:
//
//   node test/harness/signer-policy-e2e.js
//   STOP_AFTER_4B=1 node test/harness/signer-policy-e2e.js   (skips step 5)
//
// Checks:
//   1. Three members join an owner's calendar as PLAIN writers: one signer.
//   2. Once they have been around past the stability window, the owner
//      promotes two in one batch: three signers, and every peer agrees.
//   3. Reconnecting does not undo it (no re-grant on announce).
//   4. The calendar still signs new entries with three signers.
//   4b. With one promoted signer stopped, the other two still sign.
//   5. The owner disappears for two weeks. A member who signs stands in and
//      swaps the owner's device for the member who did not sign, and the
//      calendar keeps signing without the owner.

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
  // Test data goes on disk, not os.tmpdir(): /tmp is a RAM disk on Tim's machine
  // and one run of this script writes hundreds of MB. PEARCAL_TEST_TMP overrides.
  const testTmp = process.env.PEARCAL_TEST_TMP || path.join(os.homedir(), '.cache', 'pearcal-tests')
  fs.mkdirSync(testTmp, { recursive: true })
  const root = fs.mkdtempSync(path.join(testTmp, 'signer-e2e-'))
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
  const info = async (name, gid) => (await peers[name].call('listGroups')).find(g => g.id === gid)?.indexers
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


  await Promise.all(['owner', 'ana', 'ben', 'cal'].map(launch))
  console.log('four engines up\n')

  const group = await peers.owner.call('createGroup', 'SignerTest', {})
  const gid = group.id
  // One at a time: joining both at once left the second one's every
  // connection timing out on this host.
  await peers.ana.call('joinGroup', group)
  await until(async () => ((await peers.owner.call('listGroups')).find(x => x.id === gid)?.members?.length ?? 0) >= 2, 120000)
  await until(async () => ((await peers.owner.call('listGroups')).find(x => x.id === gid)?.members?.length ?? 0) >= 2, 120000)
  await peers.ben.call('joinGroup', group)
  await until(async () => ((await peers.owner.call('listGroups')).find(x => x.id === gid)?.members?.length ?? 0) >= 3, 120000)
  await peers.cal.call('joinGroup', group)

  let seen = {}
  const joined = await until(async () => {
    for (const name of Object.keys(peers)) {
      const g = (await peers[name].call('listGroups')).find(x => x.id === gid)
      seen[name] = g ? (g.members?.length ?? 0) + (g.writable === false ? ' read-only' : '') : 'none'
    }
    const g = (await peers.owner.call('listGroups')).find(x => x.id === gid)
    return (g?.members?.length ?? 0) >= 4 ? g : null
  }, 180000)
  check('all three members joined', !!joined, 'members seen ' + JSON.stringify(seen))
  if (!joined) return finish(1)
  // Give the grants time to apply everywhere.
  await new Promise(r => setTimeout(r, 15000))

  const before = await info('owner', gid)
  check('1. new members join as plain writers', before?.count === 1, 'signers=' + before?.count + ' policy=' + before?.policy)

  await stop('owner')
  const n = await backdate('owner', gid, (k, v) => ({ ...v, firstSeen: Date.now() - 2 * DAY }))
  await launch('owner')
  console.log('      backdated firstSeen on', n, 'device records, owner restarted')

  const grown = await until(async () => {
    const i = await info('owner', gid)
    return i?.count === 3 ? i : null
  }, 300000, 5000)
  const last = grown || await info('owner', gid)
  check('2. owner promotes two: three signers', !!grown, 'signers=' + last?.count + ' policy=' + last?.policy)

  const agree = await until(async () => {
    const all = await Promise.all(['ana', 'ben', 'cal'].map(n => info(n, gid)))
    return all.every(i => i?.count === 3)
  }, 120000)
  check('   every peer agrees on three', !!agree)

  // Restart a member: its reconnect re-announces to everyone.
  await stop('ana')
  await launch('ana')
  await new Promise(r => setTimeout(r, 30000))
  const after = await info('owner', gid)
  check('3. a reconnect does not change the signers', after?.count === 3, 'signers=' + after?.count)

  const today = new Date().toISOString().slice(0, 10)
  // A shared event goes through putEvent:sync, as the UI does; putEvent alone
  // only writes this device's local copy.
  async function shareEvents (name, tag) {
    for (let i = 0; i < 3; i++) {
      const ev = { id: tag + '-' + i, title: tag + ' ' + i, date: today, groups: [gid] }
      await peers[name].call('putEvent', ev)
      await peers[name].call('putEvent:sync', gid, ev)
    }
  }
  // Signers keep appending acknowledgements of their own, so "nothing
  // unsigned" never holds with three of them. The test is that the history up
  // to and including the new events gets signed.
  async function signedPast (name, written) {
    let mark = 0
    await until(async () => { mark = (await info(name, gid))?.total ?? 0; return mark >= written }, 60000)
    return until(async () => {
      const i = await info(name, gid)
      return i && i.signed >= mark ? i : null
    }, 180000)
  }
  const atTotal = (await info('owner', gid))?.total ?? 0
  await shareEvents('ben', 'e2e')
  const signed = await signedPast('owner', atTotal + 3)
  const s = signed || await info('owner', gid)
  const everyone = async names => (await Promise.all(names.map(async n => { const i = await info(n, gid); return n + ' ' + i?.signed + '/' + i?.total + ' (' + i?.count + ')' }))).join(', ')
  check('4. new entries get signed', !!signed, signed ? 'signed=' + s.signed + '/' + s.total : await everyone(['owner', 'ana', 'ben', 'cal']))
  if (!signed) {
    for (const n of ['owner', 'ana', 'ben', 'cal']) console.log('      ' + n + ' ' + JSON.stringify(await peers[n].call('debugGroup', gid).then(d => ({ me: d.me, signed: d.signed, total: d.total, self: d.self, writers: d.writers }))))
  }

  // 4b. One promoted signer goes away. Three signers exist so that losing one
  // does not stop the calendar; the owner and the other promoted one must
  // carry on alone.
  const dbg = {}
  for (const n of ['ana', 'ben', 'cal']) dbg[n] = await peers[n].call('debugGroup', gid)
  const promoted = ['ana', 'ben', 'cal'].filter(n => (dbg[n].writers || []).some(w => w.k === dbg[n].me && w.signer))
  const plain = ['ana', 'ben', 'cal'].find(n => !promoted.includes(n))
  const gone = promoted[0]
  const left = ['owner', ...promoted.slice(1), plain]
  await stop(gone)
  console.log('      stopped promoted signer', gone, '- left:', left.join(', '))
  const at4b = (await info('owner', gid))?.total ?? 0
  await shareEvents(plain, 'one-signer-gone')
  const signed4b = await signedPast('owner', at4b + 3)
  check('4b. one signer gone: the other two still sign', !!signed4b,
    signed4b ? 'signed=' + signed4b.signed + '/' + signed4b.total : await everyone(left))
  if (!signed4b) {
    for (const n of left) console.log('      ' + n + ' ' + JSON.stringify(await peers[n].call('debugGroup', gid).then(d => ({ me: d.me, signed: d.signed, total: d.total, self: d.self, writers: d.writers }))))
    // Does a hand-triggered ack get it moving? Tells a stuck ack path apart
    // from one that correctly decides there is nothing to ack.
    for (const n of left) await peers[n].call('debugGroupAck', gid).catch(e => console.log('      ack error on', n, e.message))
    await new Promise(r => setTimeout(r, 20000))
    console.log('      after a forced ack: ' + await everyone(left))
  }
  await launch(gone)
  if (process.env.STOP_AFTER_4B) return finish(failures ? 1 : 0)

  // 5. The owner goes away for good. Each member's database is told the
  // owner was last seen 15 days ago and everyone has been around for 2 days.
  const ownerGroup = (await peers.owner.call('listGroups')).find(x => x.id === gid)
  const ownerKeys = new Set((ownerGroup.members ?? []).filter(m => m.id === ownerGroup.ownerId).map(m => m.writerKey).filter(Boolean))
  await stop('owner')
  for (const name of ['ana', 'ben', 'cal']) {
    await stop(name)
    await backdate(name, gid, (k, v) => ({
      ...v,
      firstSeen: Date.now() - 2 * DAY,
      ...(ownerKeys.has(k) ? { ts: Date.now() - 15 * DAY } : {}),
    }))
  }
  await Promise.all(['ana', 'ben', 'cal'].map(launch))
  console.log('      owner gone, members told it was last seen 15 days ago')
  const replaced = await until(async () => {
    for (const name of ['ana', 'ben', 'cal']) {
      const i = await info(name, gid)
      if (i?.policy && i.policy.startsWith('replace')) return { name, i }
    }
    return null
  }, 400000, 5000)
  check('5. a member stands in and replaces the owner\'s signer', !!replaced,
    replaced ? replaced.name + ': ' + replaced.i.policy : JSON.stringify(await Promise.all(['ana', 'ben', 'cal'].map(n => info(n, gid).then(i => i?.policy)))))
  const settled = await until(async () => {
    const all = await Promise.all(['ana', 'ben', 'cal'].map(n => info(n, gid)))
    return all.every(i => i?.count === 3)
  }, 120000)
  check('   still three signers, every member agrees', !!settled)
  const before5 = (await info('ana', gid))?.total ?? 0
  await shareEvents('cal', 'after-owner')
  const signed5 = await signedPast('ana', before5 + 3)
  const s5 = signed5 || await info('ana', gid)
  check('   the calendar signs without the owner', !!signed5, 'signed=' + s5?.signed + '/' + s5?.total)

  finish(failures ? 1 : 0)
}
