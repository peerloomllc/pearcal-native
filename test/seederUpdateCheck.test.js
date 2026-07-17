// Pure version-compare + release-asset selection for the seeder update check
// (proposal 2026-07-17-macos-seeder-and-autoupdate phase B). Ported from
// PearCircle's jest suite to node:test, plus PearCal's require-an-asset rule for
// updateAvailable (an app-only release must never flag a seeder update).
const test = require('node:test')
const assert = require('node:assert/strict')
const {
  parseVersion, compareVersions, isNewer, selectAsset, selectSha256For, evaluateRelease,
} = require('../src/lib/seederUpdateCheck')

test('parseVersion: v-prefixed, plain, partial, suffixed, junk', () => {
  assert.deepEqual(parseVersion('v1.2.3'), [1, 2, 3])
  assert.deepEqual(parseVersion('1.2.3'), [1, 2, 3])
  assert.deepEqual(parseVersion('1.2'), [1, 2, 0])
  assert.deepEqual(parseVersion('0.0.0-dev'), [0, 0, 0])
  assert.deepEqual(parseVersion('1.0.4-rc1'), [1, 0, 4])
  assert.equal(parseVersion('nope'), null)
  assert.equal(parseVersion(null), null)
})

test('compareVersions: numeric, not lexical', () => {
  assert.equal(compareVersions('1.0.9', '1.0.10'), -1)
  assert.equal(compareVersions('1.2.0', '1.10.0'), -1)
  assert.equal(compareVersions('2.0.0', '1.9.9'), 1)
  assert.equal(compareVersions('1.0.0', 'v1.0.0'), 0)
})

test('isNewer: strictly newer only, errs toward false', () => {
  assert.equal(isNewer('1.0.11', '1.0.10'), true)
  assert.equal(isNewer('1.0.10', '1.0.10'), false)
  assert.equal(isNewer('1.0.9', '1.0.10'), false)
  assert.equal(isNewer('garbage', '1.0.0'), false)
  assert.equal(isNewer('1.0.1', undefined), false)
  assert.equal(isNewer('1.0.1', '0.0.0-dev'), true)
})

// Real GitHub release asset naming (arch-specific on Linux). Includes a mobile
// APK that must never be selected as a seeder installer.
const ASSETS = [
  { name: 'pearcal-seeder_1.0.10_amd64.deb', browser_download_url: 'u/deb-amd64' },
  { name: 'pearcal-seeder_1.0.10_amd64.deb.sha256', browser_download_url: 'u/deb-amd64.sha' },
  { name: 'pearcal-seeder_1.0.10_arm64.deb', browser_download_url: 'u/deb-arm64' },
  { name: 'PearCalSeeder-1.0.10.pkg', browser_download_url: 'u/pkg' },
  { name: 'PearCalSeeder-1.0.10.pkg.sha256', browser_download_url: 'u/pkg.sha' },
  { name: 'PearCalSeeder-aarch64.AppImage', browser_download_url: 'u/app-arm64' },
  { name: 'PearCalSeeder-x86_64.AppImage', browser_download_url: 'u/app-x64' },
  { name: 'PearCalSeeder-Setup-1.0.10.exe', browser_download_url: 'u/exe' },
  { name: 'pearcal-v1.0.10.apk', browser_download_url: 'u/apk' }, // mobile, never picked
]

test('selectAsset: macOS pkg + Windows exe are arch-universal', () => {
  assert.equal(selectAsset(ASSETS, 'darwin', 'x64').browser_download_url, 'u/pkg')
  assert.equal(selectAsset(ASSETS, 'darwin', 'arm64').browser_download_url, 'u/pkg')
  assert.equal(selectAsset(ASSETS, 'win32', 'x64').browser_download_url, 'u/exe')
})

test('selectAsset: linux prefers the ARCH-matching AppImage, then deb', () => {
  assert.equal(selectAsset(ASSETS, 'linux', 'x64').browser_download_url, 'u/app-x64')
  assert.equal(selectAsset(ASSETS, 'linux', 'arm64').browser_download_url, 'u/app-arm64')
  const noApp = ASSETS.filter((a) => !a.name.endsWith('.AppImage'))
  assert.equal(selectAsset(noApp, 'linux', 'x64').browser_download_url, 'u/deb-amd64')
  assert.equal(selectAsset(noApp, 'linux', 'arm64').browser_download_url, 'u/deb-arm64')
})

test('selectAsset: installKind=deb prefers the .deb; appimage keeps AppImage', () => {
  assert.equal(selectAsset(ASSETS, 'linux', 'x64', 'deb').browser_download_url, 'u/deb-amd64')
  assert.equal(selectAsset(ASSETS, 'linux', 'arm64', 'deb').browser_download_url, 'u/deb-arm64')
  assert.equal(selectAsset(ASSETS, 'linux', 'x64', 'appimage').browser_download_url, 'u/app-x64')
  const noDeb = ASSETS.filter((a) => !a.name.endsWith('.deb'))
  assert.equal(selectAsset(noDeb, 'linux', 'x64', 'deb').browser_download_url, 'u/app-x64')
})

test('selectAsset: never a wrong-arch binary; null on unknown/empty', () => {
  const onlyArm = ASSETS.filter((a) => /aarch64|arm64/.test(a.name))
  assert.equal(selectAsset(onlyArm, 'linux', 'x64'), null)
  assert.equal(selectAsset(ASSETS, 'sunos', 'x64'), null)
  assert.equal(selectAsset([], 'darwin', 'x64'), null)
  assert.equal(selectAsset(null, 'darwin', 'x64'), null)
})

test('selectSha256For: finds the matching sidecar', () => {
  assert.equal(selectSha256For(ASSETS, 'PearCalSeeder-1.0.10.pkg').browser_download_url, 'u/pkg.sha')
  assert.equal(selectSha256For(ASSETS, 'no-such'), null)
})

test('evaluateRelease: update available needs a newer tag AND a matching asset', () => {
  const release = {
    tag_name: 'v1.0.11',
    html_url: 'https://github.com/peerloomllc/pearcal-native/releases/tag/v1.0.11',
    assets: [
      { name: 'PearCalSeeder-1.0.11.pkg', browser_download_url: 'u/pkg' },
      { name: 'PearCalSeeder-1.0.11.pkg.sha256', browser_download_url: 'u/pkg.sha' },
    ],
  }
  const r = evaluateRelease(release, { currentVersion: '1.0.10', platform: 'darwin' })
  assert.equal(r.updateAvailable, true)
  assert.equal(r.latestVersion, '1.0.11')
  assert.equal(r.assetUrl, 'u/pkg')
  assert.equal(r.sha256Url, 'u/pkg.sha')
  assert.match(r.releaseUrl, /v1\.0\.11/)
  // same tag → no update
  assert.equal(evaluateRelease(release, { currentVersion: '1.0.11', platform: 'darwin' }).updateAvailable, false)
})

test('evaluateRelease: PearCal rule — a newer APP-only release (no seeder asset) is NOT an update', () => {
  // The exact false-positive we must avoid: the live seeder polling the app's
  // GitHub releases, which carry only an APK — no .pkg for darwin.
  const appOnly = {
    tag_name: 'v1.0.33',
    html_url: 'https://github.com/peerloomllc/pearcal-native/releases/tag/v1.0.33',
    assets: [{ name: 'pearcal-v1.0.33.apk', browser_download_url: 'u/apk' }],
  }
  const r = evaluateRelease(appOnly, { currentVersion: '1.0.10', platform: 'darwin' })
  assert.equal(r.latestVersion, '1.0.33')  // still reports the tag
  assert.equal(r.updateAvailable, false)   // but no darwin installer → no banner
  assert.equal(r.assetUrl, null)
})

test('evaluateRelease: malformed release is safe', () => {
  const r = evaluateRelease({}, { currentVersion: '1.0.10', platform: 'darwin' })
  assert.equal(r.updateAvailable, false)
  assert.equal(r.latestVersion, null)
  assert.equal(r.assetUrl, null)
})
