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
const { startDashboard } = require('./dashboard')
const { loadOrCreateToken } = require('./auth')
const { UpdateChecker } = require('./updateCheck')
const { UpdateApplier } = require('./updateApply')
const { execFile } = require('node:child_process')

// Run one argv as a promise (injected into UpdateApplier for the self-apply
// platforms; the macOS macpkg path writes a request file and never execs).
function execArgv (argv) {
  return new Promise((resolve, reject) => {
    execFile(argv[0], argv.slice(1), (err, stdout, stderr) => err ? reject(err) : resolve({ stdout, stderr }))
  })
}
// The root updater's watched request dir (macOS). apply() drops apply.json here
// for the privileged LaunchDaemon; absent (old build) -> needs-helper fallback.
const MAC_UPDATE_REQUEST_DIR = '/Library/Application Support/PearCal Seeder/updates/requests'

function parseArgs (argv) {
  const out = { dev: false, dataDir: null, barePath: null, bundleEntry: null, enroll: null, statusEveryMs: 30000, port: null, host: '0.0.0.0' }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dev') out.dev = true
    else if (a === '--pair') out.pair = true
    else if (a === '--port') out.port = parseInt(argv[++i], 10)
    else if (a === '--host') out.host = argv[++i]
    else if (a === '--no-auth') out.noAuth = true
    else if (a === '--data') out.dataDir = argv[++i]
    else if (a === '--bare') out.barePath = argv[++i]
    else if (a === '--bundle') out.bundleEntry = argv[++i]
    else if (a === '--enroll') out.enroll = argv[++i]
    else if (a === '--status-interval') out.statusEveryMs = parseInt(argv[++i], 10) || 30000
    else if (a === '--no-update-check') out.noUpdateCheck = true
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

  // Seeder build version: stamped by the packager (PEARCAL_SEEDER_VERSION, phase
  // C), else the launcher package.json. Drives the version pill + the update check.
  let version = process.env.PEARCAL_SEEDER_VERSION || null
  if (!version) { try { version = require('../package.json').version } catch {} }

  // Update checker (proposal phase B). Gated OFF for store-managed deploys —
  // Umbrel / Start9 / any container update through their store, not our updater
  // (Tim, 2026-07-17). Disabled by --no-update-check, SEEDER_NO_UPDATE_CHECK, or
  // a /.dockerenv marker. Notify-only for now (banner + download link).
  const updateGated = opts.noUpdateCheck || !!process.env.SEEDER_NO_UPDATE_CHECK || fs.existsSync('/.dockerenv')
  let updateChecker = null
  let updateApplier = null
  if (!updateGated) {
    updateChecker = new UpdateChecker({ currentVersion: version, log }).start()
    // One-click apply (phase C2). macOS hands the verified .pkg to the root
    // updater daemon (requestDir); Linux self-applies an AppImage ($APPIMAGE) or
    // pkexecs a .deb helper. The seeder itself stays unprivileged.
    // A .deb install runs from /opt/pearcal-seeder (installRoot = ../ from host/),
    // where the postinst placed the root-owned updater-helper.sh + polkit rule;
    // the deb applier pkexecs it. An AppImage instead self-applies via $APPIMAGE
    // (target). Both are wired; the applier chosen follows the release asset type.
    const installRoot = path.resolve(__dirname, '..')
    updateApplier = new UpdateApplier({
      getUpdate: () => updateChecker.get(),
      requestDir: process.platform === 'darwin' ? MAC_UPDATE_REQUEST_DIR : null,
      target: process.platform === 'linux' ? (process.env.APPIMAGE || null) : null,
      helperPath: process.platform === 'linux' && !process.env.APPIMAGE ? path.join(installRoot, 'updater-helper.sh') : null,
      user: os.userInfo().username,
      exec: execArgv,
      log,
    })
    log('host', `update check on (v${version || '?'}); source: ${process.env.PEARCAL_UPDATE_LATEST_URL || 'github/peerloomllc/pearcal-native'}`)
  } else {
    log('host', 'update check off (store-managed / --no-update-check)')
  }

  // Monitoring + pairing dashboard. Enable with --port <n> or SEEDER_PORT.
  const dashPort = opts.port || (process.env.SEEDER_PORT ? Number(process.env.SEEDER_PORT) : null)
  if (dashPort) {
    // Token auth on by default (persisted in the data dir); --no-auth disables.
    const token = opts.noAuth ? null : loadOrCreateToken(dataDir).token
    startDashboard({ worklet: wl, port: dashPort, host: opts.host, token, version, updateChecker, updateApplier, log })
    if (token) log('host', `dashboard token: ${token}`)
  }

  // Dev QR pairing: open a rendezvous and render the QR in the terminal so a
  // phone can scan it (proposal 2026-07-15 QR-pairing model). The real launcher
  // dashboard renders the same link as an on-screen QR; this is the headless
  // stand-in for testing before that lands.
  if (opts.pair) {
    let renewTimer = null
    const openPair = async () => {
      if (renewTimer) { clearTimeout(renewTimer); renewTimer = null }
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
        process.stdout.write(`(a fresh QR appears after each pairing and whenever this one expires)\n\n`)
        // Keep the on-screen QR live: renew shortly after the rendezvous TTL so a
        // spent/expired QR is never the one showing.
        renewTimer = setTimeout(() => openPair(), (r.ttlMs || 300000) + 3000)
        if (typeof renewTimer.unref === 'function') renewTimer.unref()
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
