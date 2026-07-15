// PearCal blind-seeder launcher (host).
//
// Spawns the seed worklet (src/seed.js) and keeps it alive on an always-on
// machine. Adapted from PearCircle's proven seeder-launcher.
//
//   Dev:  node seeder-launcher/host/index.js --dev [--data <dir>] [--enroll <bundle-file>]
//         -> spawns `node <repo>/src/seed.js --seed`
//   Prod: node host/index.js [--data <dir>] [--enroll <bundle-file>]
//         -> spawns `<install>/bare <install>/seed.bundle --seed`
//
// Phase 5a: process supervision + status polling + enroll-from-bundle. The
// monitoring HTTP/WS dashboard and auto-update (PearCircle host/server.js,
// updateCheck.js) are follow-ups.

const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const { Worklet } = require('./worklet')

function parseArgs (argv) {
  const out = { dev: false, dataDir: null, barePath: null, bundleEntry: null, enroll: null, statusEveryMs: 30000 }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dev') out.dev = true
    else if (a === '--pair') out.pair = true
    else if (a === '--data') out.dataDir = argv[++i]
    else if (a === '--bare') out.barePath = argv[++i]
    else if (a === '--bundle') out.bundleEntry = argv[++i]
    else if (a === '--enroll') out.enroll = argv[++i]
    else if (a === '--status-interval') out.statusEveryMs = parseInt(argv[++i], 10) || 30000
  }
  return out
}

// Resolve the native bare-runtime binary for prod installs. Mirrors PearCircle:
// node_modules/bare-runtime-<platform>-<arch>/bin/bare.
function nativeBareBinary (root) {
  const platform = process.platform
  const arch = process.arch
  const ext = platform === 'win32' ? '.exe' : ''
  return path.join(root, 'node_modules', `bare-runtime-${platform}-${arch}`, 'bin', `bare${ext}`)
}

function resolvePaths (opts) {
  const repoRoot = path.resolve(__dirname, '..', '..') // pearcal-native/
  if (opts.dev) {
    return {
      barePath: opts.barePath || process.execPath, // node
      bundleEntry: opts.bundleEntry || path.join(repoRoot, 'src', 'seed.js'),
    }
  }
  const installRoot = path.resolve(__dirname, '..')  // seeder-launcher/
  return {
    barePath: opts.barePath || nativeBareBinary(installRoot),
    bundleEntry: opts.bundleEntry || path.join(installRoot, 'seed.bundle'),
  }
}

function log (tag, msg) {
  process.stdout.write(`[launcher:${tag}] ${msg}\n`)
}

async function main () {
  const opts = parseArgs(process.argv)
  const dataDir = opts.dataDir || path.join(os.homedir(), '.pearcal-seed')
  fs.mkdirSync(dataDir, { recursive: true })
  const paths = resolvePaths(opts)
  log('host', `bare=${paths.barePath}`)
  log('host', `bundle=${paths.bundleEntry}`)
  log('host', `data=${dataDir}`)

  const wl = new Worklet({
    barePath: paths.barePath,
    bundleEntry: paths.bundleEntry,
    dataDir,
    onLog: (src, line) => process.stdout.write(`[worklet:${src}] ${String(line).trimEnd()}\n`),
  })
  wl.on('exit', ({ code, signal }) => {
    log('host', `worklet exited code=${code} signal=${signal} — respawning in 2s`)
    setTimeout(() => { wl.start().catch((e) => log('host', 'respawn failed: ' + e.message)) }, 2000)
  })
  wl.on('error', (e) => log('host', 'worklet error: ' + e.message))

  const initResult = await wl.start()
  log('host', 'seeder ready: ' + JSON.stringify(initResult))

  // Dev QR pairing: open a rendezvous and render the QR in the terminal so a
  // phone can scan it (proposal 2026-07-15 QR-pairing model). The real launcher
  // dashboard renders the same link as an on-screen QR; this is the headless
  // stand-in for testing before that lands.
  if (opts.pair) {
    const openPair = async () => {
      try {
        const r = await wl.call('seeder:pair:open', {})
        if (r?.error || !r?.link) { log('pair', 'open failed: ' + (r?.error || 'no link')); return }
        const QRCode = require('qrcode')
        const qr = await QRCode.toString(r.link, { type: 'terminal', small: true })
        const pngPath = path.join(dataDir, 'pair-qr.png')
        await QRCode.toFile(pngPath, r.link, { width: 512, margin: 2 }).catch(() => {})
        process.stdout.write('\n=== Scan this QR in PearCal → Profile → Advanced → Blind peer ===\n')
        process.stdout.write(qr + '\n')
        process.stdout.write(r.link + '\n')
        process.stdout.write(`QR image: ${pngPath}  (open it fullscreen if the terminal QR is hard to scan)\n`)
        process.stdout.write(`(valid ${Math.round((r.ttlMs || 0) / 60000)} min — a fresh QR appears after each pairing)\n\n`)
      } catch (e) { log('pair', 'error: ' + e.message) }
    }
    // Each QR is single-use (the seeder closes the rendezvous once a device
    // pairs). Mint a fresh one after every pairing so the on-screen QR is always
    // live — scanning a spent QR would otherwise just time out on the phone.
    wl.on('event', ({ name, data }) => {
      if (name !== 'seeder:pair:result') return
      const n = data?.enrolled ?? 0
      log('pair', `✓ paired — enrolled ${n} group(s)` + (data?.names?.length ? ': ' + data.names.join(', ') : ''))
      setTimeout(() => openPair(), 500) // refresh QR for the next device
    })
    await openPair()
  }

  // Enroll an all-groups bundle if provided (a file of newline-joined /seed URLs).
  if (opts.enroll) {
    try {
      const bundle = fs.readFileSync(opts.enroll, 'utf8')
      const r = await wl.call('seeder:enroll', { invite: bundle })
      log('host', 'enroll result: ' + JSON.stringify(r))
    } catch (e) { log('host', 'enroll failed: ' + e.message) }
  }

  // Periodic status heartbeat.
  const poll = async () => {
    try { log('status', JSON.stringify(await wl.call('seeder:status', {}))) }
    catch (e) { log('status', 'error: ' + e.message) }
  }
  await poll()
  const timer = setInterval(poll, opts.statusEveryMs)

  const shutdown = async () => { clearInterval(timer); await wl.stop().catch(() => {}); process.exit(0) }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((e) => { process.stderr.write('[launcher] fatal: ' + (e?.stack || e) + '\n'); process.exit(1) })
