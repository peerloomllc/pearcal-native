// Repro harness for the "File descriptor could not be locked" failure.
//
// Runs the REAL src/bare.js under plain Node via the Electron BareKit shim
// (see feedback_headless_bare_two_peer_harness). No device, no GUI, no swarm
// peer needed: the whole question is what _doShutdown leaves open.
//
// Run it after `cd electron && node scripts/prepack.js`, which vendors your
// current src/bare.js (including uncommitted edits):
//
//   node test/harness/shutdown-fd-lock.js control  -> clean shutdown, re-init
//   node test/harness/shutdown-fd-lock.js fault    -> a close ahead of
//                                                     store.close() throws
//   node test/harness/shutdown-fd-lock.js hang     -> that close never settles
//
// All three must print `re-init SUCCEEDED`.
//
// The regression this guards: _doShutdown used to close everything in ONE try
// block with a catch that only logged, so a throw in any earlier step skipped
// store.close() and db.close() while still resolving. Those two hold an
// exclusive CORESTORE lock that is per OPEN FILE DESCRIPTION (F_OFD_SETLK on
// Linux/Android, flock on Apple), so the stranded handle locked out the NEXT
// open from this same process and init()'s 20 retries could never win.
//
//   throw -> "Failed to start PearCal / File descriptor could not be locked"
//   hang  -> shutdown() never settles, init() awaits forever, blank screen
//
// Both were reported on a 1.0.38 release build on 2026-08-05.
// The fault is injected into Hyperswarm.destroy(), which sits directly above
// the two closes that matter.

const os = require('os')
const path = require('path')
const fs = require('fs')

const MODE = ['fault', 'hang'].includes(process.argv[2]) ? process.argv[2] : 'control'

const BARE_ENTRY = require.resolve('../../electron/vendor/src/bare.js')

if (MODE === 'fault' || MODE === 'hang') {
  // Resolve hyperswarm THE WAY THE WORKLET DOES. A plain require('hyperswarm')
  // from this directory picks up the root node_modules, while the vendored
  // bare.js picks up electron/node_modules, a different instance, so the
  // patch below would land on a copy nothing under test ever calls, and every
  // mode would quietly "pass".
  const Hyperswarm = require(require.resolve('hyperswarm', { paths: [path.dirname(BARE_ENTRY)] }))
  const realDestroy = Hyperswarm.prototype.destroy
  Hyperswarm.prototype.destroy = async function () {
    // Do the real teardown so we are not leaking sockets, then fail the way a
    // stuck/erroring close does from _doShutdown's point of view.
    try { await realDestroy.call(this) } catch (e) {}
    if (MODE === 'hang') return new Promise(() => {})   // never settles
    throw new Error('injected: swarm.destroy failed')
  }
  console.log('[harness] ' + MODE + ' injected into Hyperswarm.destroy')
}

const { createBareKitShim } = require('../../electron/src/main/barekit-shim.js')
const { tmpDir } = require('../helpers/tmpdir')
const shim = createBareKitShim()

const dataDir = tmpDir('pc-leak-')
const mnemonicFile = path.join(dataDir, 'mnemonic.txt')

let buf = ''
const waiters = []          // { match(msg): bool, resolve }
const backlog = []          // bare.js emits bareReady during require(), before
                            // any waiter exists, so waiters scan history first.

function onMessage (msg) {
  backlog.push(msg)
  for (let i = waiters.length - 1; i >= 0; i--) {
    if (waiters[i].match(msg)) { waiters.splice(i, 1)[0].resolve(msg) }
  }
  if (msg.type === 'nativeRequest') return answerNative(msg)
}

function waitFor (match, ms, label, fromIndex = 0) {
  return new Promise((resolve, reject) => {
    for (let i = fromIndex; i < backlog.length; i++) {
      if (match(backlog[i])) return resolve(backlog[i])
    }
    const w = { match, resolve }
    waiters.push(w)
    setTimeout(() => {
      const i = waiters.indexOf(w)
      if (i >= 0) { waiters.splice(i, 1); reject(new Error('timeout waiting for ' + label)) }
    }, ms)
  })
}

function send (obj) {
  shim.sendToBare(Buffer.from(JSON.stringify(obj) + '\n'))
}

// Minimum native surface bare.js touches during ensureIdentity(), or init hangs.
function answerNative (msg) {
  const { nativeId, method } = msg
  let result = null
  try {
    if (method === 'hasMnemonic') result = fs.existsSync(mnemonicFile)
    else if (method === 'getMnemonic') result = fs.existsSync(mnemonicFile) ? fs.readFileSync(mnemonicFile, 'utf8') : null
    else if (method === 'setMnemonic') { fs.writeFileSync(mnemonicFile, msg.args[0]); result = true }
    else if (method === 'getBackupStatus') result = { enabled: false }
  } catch (e) {}
  send({ type: 'nativeResponse', nativeId, result })
}

shim.onBareOut(chunk => {
  buf += chunk.toString()
  const lines = buf.split('\n')
  buf = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.trim()) continue
    try { onMessage(JSON.parse(line)) } catch (e) {}
  }
})

require(BARE_ENTRY)

const ready = from => waitFor(m => m.type === 'event' && m.event === 'ready', 90000, 'ready', from)
const failed = from => waitFor(m => m.type === 'event' && m.event === 'error', 90000, 'error', from)

async function main () {
  console.log('[harness] mode=' + MODE + ' dataDir=' + dataDir)

  await waitFor(m => m.type === 'event' && m.event === 'bareReady', 30000, 'bareReady')

  send({ method: 'init', dataDir, platform: 'desktop' })
  await ready(0)
  console.log('[harness] first init: ready')

  // Exactly what the RN shell does on an Activity teardown.
  send({ method: 'shutdown', args: [], id: -1 })
  await new Promise(r => setTimeout(r, 4000))
  console.log('[harness] shutdown sent')

  // Only messages from here on count as the re-init's answer.
  const mark = backlog.length

  // Exactly what the shell's warm reopen does (app/index.tsx:730).
  send({ method: 'init', dataDir, platform: 'desktop' })

  const outcome = await Promise.race([
    ready(mark).then(() => ({ ok: true })),
    failed(mark).then(m => ({ ok: false, error: m.data }))
  ]).catch(e => ({ ok: false, error: 'harness ' + e.message }))

  if (outcome.ok) console.log('\nRESULT[' + MODE + ']: re-init SUCCEEDED')
  else console.log('\nRESULT[' + MODE + ']: re-init FAILED -> ' + outcome.error)

  fs.rmSync(dataDir, { recursive: true, force: true })
  process.exit(0)
}

main().catch(e => { console.error('[harness] error:', e); process.exit(1) })
