// Seeder-launcher one-click update apply (proposal 2026-07-17 phase C2). Downloads
// the platform asset chosen by the update check, verifies it against the
// release's .sha256 sidecar (the integrity boundary — a tampered or wrong asset
// is rejected and nothing is installed), then dispatches to a per-platform
// applier. Ported from PearCircle host/updateApply.js.
//
// macOS (PearCal's target): the host is unprivileged, so it can't run
// `installer -pkg` itself. It hands the verified .pkg to a root LaunchDaemon by
// dropping a request into a watched dir; the daemon RE-verifies (sha256 +
// Developer-ID team + notarization) before installing. The team+notarization
// check is the real trust anchor — a local attacker can't forge an Apple
// signature — which is why the seeder .pkg MUST be signed + notarized for the
// silent auto-apply to be safe. If the daemon dir is absent (old build) the
// applier throws NeedsHelperError and the route falls back to a verified download.
// The Linux .deb (pkexec helper) + AppImage/Windows self-apply paths are kept
// from the port for completeness though PearCal ships only the macpkg path today.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

// The Apple Developer Team that signs + notarizes PearCal (shared across the
// suite). The root updater only installs a .pkg signed by this team + notarized.
const APPLE_TEAM_ID = 'G79ALD29NA'

// Pull the signing Team Identifier out of `pkgutil --check-signature <pkg>`
// output. Returns the id or null. Pure.
function parsePkgutilTeam (output) {
  if (typeof output !== 'string') return null
  const explicit = output.match(/Team identifier:\s*([A-Z0-9]{10})/i)
  if (explicit) return explicit[1].toUpperCase()
  const paren = output.match(/Developer ID Installer:[^\n(]*\(([A-Z0-9]{10})\)/i)
  return paren ? paren[1].toUpperCase() : null
}

class NeedsHelperError extends Error {
  constructor (platform) { super(`apply on ${platform} needs the privileged helper`); this.code = 'NEEDS_HELPER' }
}
class VerifyError extends Error {
  constructor (msg) { super(msg); this.code = 'VERIFY_FAILED' }
}

// Pull the 64-hex digest out of a `<hex>  <filename>` shasum sidecar.
function parseSha256Sidecar (text) {
  if (typeof text !== 'string') return null
  const m = text.trim().match(/\b([0-9a-f]{64})\b/i)
  return m ? m[1].toLowerCase() : null
}

// SHA-256 of a file on disk, lowercase hex.
function sha256File (filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const s = fs.createReadStream(filePath)
    s.on('error', reject)
    s.on('data', (d) => hash.update(d))
    s.on('end', () => resolve(hash.digest('hex')))
  })
}

// Decide what to do for a platform from an evaluated update. Pure. Throws when
// there's nothing to apply.
function planApply (update, platform) {
  if (!update || !update.updateAvailable) throw new Error('no update available to apply')
  if (!update.assetUrl || !update.sha256Url) throw new Error('release has no verifiable asset for this platform')
  const applier = platform === 'darwin' ? 'macpkg'
    : platform === 'win32' ? 'windows'
      : platform === 'linux' ? (update.assetName && /\.appimage$/i.test(update.assetName) ? 'appimage' : 'deb')
        : null
  if (!applier) throw new Error('unsupported platform: ' + platform)
  const requiresHelper = applier === 'macpkg' || applier === 'deb'
  const requiresTarget = applier === 'appimage'
  return { applier, requiresHelper, requiresTarget, assetUrl: update.assetUrl, sha256Url: update.sha256Url, assetName: update.assetName }
}

// Download `url` to `destPath` (streamed via fetch). Returns destPath.
async function downloadTo (url, destPath, { fetchImpl } = {}) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null)
  if (!doFetch) throw new Error('no fetch available')
  const res = await doFetch(url, { redirect: 'follow', headers: { 'user-agent': 'pearcal-seeder' } })
  if (!res.ok) throw new Error('download http ' + res.status)
  const buf = Buffer.from(await res.arrayBuffer())
  await fs.promises.writeFile(destPath, buf)
  return destPath
}

// Download the asset + its sidecar, verify the hash. Throws VerifyError on
// mismatch (the asset file is removed). Returns the verified file path + digest.
async function downloadAndVerify (plan, { workDir, fetchImpl } = {}) {
  const dir = workDir || fs.mkdtempSync(path.join(os.tmpdir(), 'pcal-update-'))
  const file = path.join(dir, plan.assetName || 'asset.download')
  await downloadTo(plan.assetUrl, file, { fetchImpl })
  const doFetch = fetchImpl || fetch
  const shaRes = await doFetch(plan.sha256Url, { redirect: 'follow', headers: { 'user-agent': 'pearcal-seeder' } })
  if (!shaRes.ok) throw new VerifyError('sha256 sidecar http ' + shaRes.status)
  const expected = parseSha256Sidecar(await shaRes.text())
  if (!expected) throw new VerifyError('unparseable sha256 sidecar')
  const actual = await sha256File(file)
  if (actual !== expected) {
    try { await fs.promises.unlink(file) } catch {}
    throw new VerifyError(`sha256 mismatch (expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`)
  }
  return { file, digest: actual, dir }
}

// Per-platform apply command plans. exec(argv) runs one command (injectable).
const APPLIERS = {
  appimage: async ({ file, target, exec }) => {
    if (!target) throw new Error('appimage applier needs a target path')
    await exec(['install', '-m', '0755', file, target])
    // --no-block: a plain restart tears down our cgroup and kills systemctl (and
    // us) before it returns 0, which surfaced as a bogus error on a good update.
    await exec(['systemctl', '--user', 'restart', '--no-block', 'pearcal-seeder'])
    return { restarted: true }
  },
  windows: async ({ file, exec }) => {
    const cmdLine = `\"${file}\" /S`
    const ps = `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='${cmdLine}'} | Out-Null`
    await exec(['powershell', '-NoProfile', '-NonInteractive', '-Command', ps])
    return { restarted: true }
  },
  // macOS: hand the verified .pkg to the root updater LaunchDaemon by dropping a
  // request into its watched dir. The daemon re-verifies (sha256 + team +
  // notarization) and installs; the .pkg's own postinstall reloads the agent.
  macpkg: async ({ file, digest, version, platform, requestDir, fsImpl }) => {
    const f = fsImpl || fs
    if (!requestDir || !f.existsSync(requestDir)) throw new NeedsHelperError(platform || 'darwin')
    const req = { pkgPath: file, sha256: digest, version: version || null, teamId: APPLE_TEAM_ID, ts: Date.now() }
    // temp-then-rename so the daemon's WatchPaths never sees a half-written request.
    const tmp = path.join(requestDir, '.apply.json.tmp')
    const dst = path.join(requestDir, 'apply.json')
    f.writeFileSync(tmp, JSON.stringify(req))
    f.renameSync(tmp, dst)
    return { handedToHelper: true }
  },
  deb: async ({ file, digest, version, platform, helperPath, user, exec, fsImpl }) => {
    const f = fsImpl || fs
    if (!helperPath || !f.existsSync(helperPath)) throw new NeedsHelperError(platform || 'linux')
    await exec(['pkexec', helperPath, file, digest, user || '', version || ''])
    return { restarted: true }
  },
}

// Full orchestration: plan -> download+verify -> apply. Injectable exec/fetch/fs.
async function applyUpdate (update, { platform = process.platform, target, requestDir, helperPath, user, workDir, fetchImpl, exec, fsImpl, log = () => {} } = {}) {
  const plan = planApply(update, platform)
  log('update', `applying v${update.latestVersion} via ${plan.applier}`)
  const { file, digest } = await downloadAndVerify(plan, { workDir, fetchImpl })
  log('update', `verified ${plan.assetName} (${digest.slice(0, 12)}…)`)
  const applier = APPLIERS[plan.applier]
  if (!applier) throw new Error('no applier for ' + plan.applier)
  const result = await applier({ file, digest, version: update.latestVersion, target, platform, requestDir, helperPath, user, exec, fsImpl })
  return { ...result, applier: plan.applier, version: update.latestVersion, file, digest }
}

// Stateful one-click apply driver. Tracks a single in-flight apply and exposes
// its state for /api/update/apply + the dashboard snapshot.
class UpdateApplier {
  constructor ({ getUpdate, platform = process.platform, target = null, requestDir = null, helperPath = null, user = null, exec, fetchImpl, log = () => {} } = {}) {
    this._getUpdate = getUpdate
    this._platform = platform
    this._target = target
    this._requestDir = requestDir
    this._helperPath = helperPath
    this._user = user
    this._exec = exec
    this._fetchImpl = fetchImpl
    this._log = log
    this._state = { status: 'idle' }
  }

  getState () { return this._state }

  async apply () {
    const update = typeof this._getUpdate === 'function' ? this._getUpdate() : null
    if (!update || !update.updateAvailable) { this._state = { status: 'no-update' }; return this._state }
    if (this._state.status === 'running') return this._state
    this._state = { status: 'running', version: update.latestVersion }
    const downloadFallback = { status: 'needs-helper', version: update.latestVersion, assetUrl: update.assetUrl, releaseUrl: update.releaseUrl }
    try {
      const plan = planApply(update, this._platform)
      if (plan.requiresTarget && !this._target) {
        this._state = { ...downloadFallback, reason: 'no-install-target' }; return this._state
      }
      const result = await applyUpdate(update, {
        platform: this._platform, target: this._target, requestDir: this._requestDir,
        helperPath: this._helperPath, user: this._user,
        exec: this._exec, fetchImpl: this._fetchImpl, log: this._log,
      })
      this._state = result.handedToHelper
        ? { status: 'applying-via-helper', version: update.latestVersion }
        : { status: 'restarting', version: update.latestVersion }
    } catch (e) {
      this._state = e.code === 'NEEDS_HELPER'
        ? { ...downloadFallback, reason: 'privileged-installer' }
        : { status: 'error', version: update.latestVersion, error: e.message }
      this._log('update', `apply failed: ${e.message}`)
    }
    return this._state
  }
}

module.exports = {
  NeedsHelperError, VerifyError, UpdateApplier, APPLE_TEAM_ID, parsePkgutilTeam,
  parseSha256Sidecar, sha256File, planApply, downloadTo, downloadAndVerify, applyUpdate, APPLIERS,
}
