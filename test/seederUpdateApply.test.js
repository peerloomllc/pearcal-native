// One-click update apply core (proposal 2026-07-17 phase C2). Ported from
// PearCircle's jest suite to node:test. Focuses on the integrity boundary
// (sha256 verify) + the macOS privileged-helper handoff — PearCal's active path.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const {
  NeedsHelperError, VerifyError, UpdateApplier, APPLE_TEAM_ID, parsePkgutilTeam,
  parseSha256Sidecar, sha256File, planApply, downloadAndVerify, applyUpdate,
} = require('../seeder-launcher/host/updateApply')

function tmp () { return fs.mkdtempSync(path.join(os.tmpdir(), 'pcal-apply-test-')) }
function sha256 (buf) { return crypto.createHash('sha256').update(buf).digest('hex') }
function stubFetch ({ assetUrl, bytes, shaUrl, shaText, assetStatus = 200, shaStatus = 200 }) {
  return async (url) => {
    if (url === assetUrl) return { ok: assetStatus === 200, status: assetStatus, arrayBuffer: async () => bytes }
    if (url === shaUrl) return { ok: shaStatus === 200, status: shaStatus, text: async () => shaText }
    throw new Error('unexpected url ' + url)
  }
}

test('parseSha256Sidecar: parses the shasum line; rejects junk', () => {
  assert.equal(parseSha256Sidecar('54ea7843cbc9296c3fe74828ae32fad9c4e8ae47e869d36ee15b1988059d1d24  X.pkg'),
    '54ea7843cbc9296c3fe74828ae32fad9c4e8ae47e869d36ee15b1988059d1d24')
  assert.equal(parseSha256Sidecar('not a hash'), null)
  assert.equal(parseSha256Sidecar(null), null)
})

test('sha256File matches node crypto', async () => {
  const f = path.join(tmp(), 'x'); fs.writeFileSync(f, 'hello seeder')
  assert.equal(await sha256File(f), sha256(Buffer.from('hello seeder')))
})

test('planApply: darwin → macpkg needs helper; linux appimage/deb; throws when nothing to apply', () => {
  const base = { updateAvailable: true, assetUrl: 'u/a', sha256Url: 'u/a.sha', latestVersion: '1.0.11' }
  assert.equal(planApply({ ...base, assetName: 'X.pkg' }, 'darwin').requiresHelper, true)
  const app = planApply({ ...base, assetName: 'PearCalSeeder-x86_64.AppImage' }, 'linux')
  assert.equal(app.applier, 'appimage'); assert.equal(app.requiresTarget, true); assert.equal(app.requiresHelper, false)
  const deb = planApply({ ...base, assetName: 'pearcal-seeder_1.0.11_amd64.deb' }, 'linux')
  assert.equal(deb.applier, 'deb'); assert.equal(deb.requiresHelper, true)
  assert.throws(() => planApply({ updateAvailable: false }, 'darwin'))
  assert.throws(() => planApply({ updateAvailable: true, assetUrl: 'u' }, 'darwin')) // no sha
})

// The integrity boundary — the security-critical test.
test('downloadAndVerify: passes on match; REJECTS a tampered asset + removes the file', async () => {
  const bytes = Buffer.from('the new seeder build')
  const good = sha256(bytes)
  const plan = { assetUrl: 'u/asset', sha256Url: 'u/asset.sha', assetName: 'asset.pkg' }
  const okDir = tmp()
  const r = await downloadAndVerify(plan, { workDir: okDir, fetchImpl: stubFetch({ assetUrl: 'u/asset', bytes, shaUrl: 'u/asset.sha', shaText: `${good}  asset.pkg` }) })
  assert.equal(r.digest, good); assert.ok(fs.existsSync(r.file))

  const badDir = tmp()
  const wrong = sha256(Buffer.from('a different (malicious) payload'))
  await assert.rejects(
    downloadAndVerify(plan, { workDir: badDir, fetchImpl: stubFetch({ assetUrl: 'u/asset', bytes, shaUrl: 'u/asset.sha', shaText: `${wrong}  asset.pkg` }) }),
    (e) => e instanceof VerifyError)
  assert.equal(fs.existsSync(path.join(badDir, 'asset.pkg')), false) // not left on disk
})

test('applyUpdate: macOS pkg → NeedsHelperError when no request dir; hash mismatch aborts before applying', async () => {
  const bytes = Buffer.from('seeder v1.0.11 pkg'); const good = sha256(bytes)
  const update = { updateAvailable: true, latestVersion: '1.0.11', assetUrl: 'u/pkg', sha256Url: 'u/pkg.sha', assetName: 'X.pkg' }
  await assert.rejects(
    applyUpdate(update, { platform: 'darwin', workDir: tmp(), fetchImpl: stubFetch({ assetUrl: 'u/pkg', bytes, shaUrl: 'u/pkg.sha', shaText: `${good}  X.pkg` }), exec: async () => {} }),
    (e) => e instanceof NeedsHelperError)
  const cmds = []
  const badFetch = stubFetch({ assetUrl: 'u/pkg', bytes, shaUrl: 'u/pkg.sha', shaText: `${sha256(Buffer.from('evil'))}  X.pkg` })
  await assert.rejects(
    applyUpdate(update, { platform: 'darwin', requestDir: tmp(), workDir: tmp(), fetchImpl: badFetch, exec: async (c) => cmds.push(c) }),
    (e) => e instanceof VerifyError)
  assert.deepEqual(cmds, []) // nothing applied
})

test('UpdateApplier: no update → no-update; darwin without request dir → needs-helper', async () => {
  const bytes = Buffer.from('x'); const good = sha256(bytes)
  const update = { updateAvailable: true, latestVersion: '1.0.11', releaseUrl: 'rel', assetUrl: 'u/pkg', sha256Url: 'u/pkg.sha', assetName: 'X.pkg' }
  const fetchImpl = stubFetch({ assetUrl: 'u/pkg', bytes, shaUrl: 'u/pkg.sha', shaText: `${good}  X.pkg` })
  const none = new UpdateApplier({ getUpdate: () => ({ updateAvailable: false }) })
  assert.equal((await none.apply()).status, 'no-update')
  const noDir = new UpdateApplier({ getUpdate: () => update, platform: 'darwin', requestDir: '/no/such/dir', fetchImpl, exec: async () => {} })
  const s = await noDir.apply()
  assert.equal(s.status, 'needs-helper'); assert.equal(s.reason, 'privileged-installer'); assert.equal(s.assetUrl, 'u/pkg')
})

test('macOS handoff: drops a verified apply.json for the daemon when the request dir exists', async () => {
  const bytes = Buffer.from('seeder v1.0.11 pkg'); const good = sha256(bytes)
  const update = { updateAvailable: true, latestVersion: '1.0.11', releaseUrl: 'rel', assetUrl: 'u/pkg', sha256Url: 'u/pkg.sha', assetName: 'PearCalSeeder-1.0.11.pkg' }
  const fetchImpl = stubFetch({ assetUrl: 'u/pkg', bytes, shaUrl: 'u/pkg.sha', shaText: `${good}  PearCalSeeder-1.0.11.pkg` })
  const reqDir = tmp()
  const a = new UpdateApplier({ getUpdate: () => update, platform: 'darwin', requestDir: reqDir, fetchImpl, exec: async () => {} })
  const s = await a.apply()
  assert.equal(s.status, 'applying-via-helper')
  const req = JSON.parse(fs.readFileSync(path.join(reqDir, 'apply.json'), 'utf8'))
  assert.equal(req.sha256, good)
  assert.equal(req.version, '1.0.11')
  assert.equal(req.teamId, APPLE_TEAM_ID)
  assert.ok(fs.existsSync(req.pkgPath))
  // no half-written temp left behind
  assert.equal(fs.existsSync(path.join(reqDir, '.apply.json.tmp')), false)
})

test('parsePkgutilTeam: both output shapes; null when absent', () => {
  assert.equal(parsePkgutilTeam('   1. Developer ID Installer: Timothy Hudgins (G79ALD29NA)\n'), 'G79ALD29NA')
  assert.equal(parsePkgutilTeam('Status: signed\n   Team identifier: G79ALD29NA\n'), 'G79ALD29NA')
  assert.equal(parsePkgutilTeam('Status: no signature'), null)
  assert.equal(parsePkgutilTeam(null), null)
})
