// Pure version-compare + release-asset selection for the seeder update check
// (proposal 2026-07-17-macos-seeder-and-autoupdate phase B). Ported from
// PearCircle's jest suite to node:test, plus PearCal's require-an-asset rule for
// updateAvailable (an app-only release must never flag a seeder update).
const test = require('node:test')
const assert = require('node:assert/strict')
const {
  parseVersion, compareVersions, isNewer, selectAsset, selectSha256For,
  versionFromAssetName, evaluateRelease,
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

test('selectAsset: an arch-universal macOS pkg + Windows exe serve any arch', () => {
  // An un-suffixed .pkg (a single fat build) is offered to both Mac arches.
  assert.equal(selectAsset(ASSETS, 'darwin', 'x64').browser_download_url, 'u/pkg')
  assert.equal(selectAsset(ASSETS, 'darwin', 'arm64').browser_download_url, 'u/pkg')
  assert.equal(selectAsset(ASSETS, 'win32', 'x64').browser_download_url, 'u/exe')
})

test('selectAsset: arch-suffixed macOS pkgs match the running arch, never cross', () => {
  // The real build (build-macos-remote.sh) emits BOTH -arm64.pkg and -x64.pkg.
  // Each Mac must get its own arch; a wrong-arch .pkg is worse than none.
  const pkgs = [
    { name: 'PearCalSeeder-1.0.34-arm64.pkg', browser_download_url: 'u/pkg-arm64' },
    { name: 'PearCalSeeder-1.0.34-arm64.pkg.sha256', browser_download_url: 'u/pkg-arm64.sha' },
    { name: 'PearCalSeeder-1.0.34-x64.pkg', browser_download_url: 'u/pkg-x64' },
    { name: 'PearCalSeeder-1.0.34-x64.pkg.sha256', browser_download_url: 'u/pkg-x64.sha' },
  ]
  assert.equal(selectAsset(pkgs, 'darwin', 'arm64').browser_download_url, 'u/pkg-arm64')
  assert.equal(selectAsset(pkgs, 'darwin', 'x64').browser_download_url, 'u/pkg-x64')
  // Only the arm64 pkg present → an x64 Mac gets nothing, not the arm64 build.
  const armOnly = pkgs.filter((a) => a.name.includes('arm64'))
  assert.equal(selectAsset(armOnly, 'darwin', 'x64'), null)
  // sha256 sidecar resolves for the arch-matched pkg.
  const chosen = selectAsset(pkgs, 'darwin', 'x64')
  assert.equal(selectSha256For(pkgs, chosen.name).browser_download_url, 'u/pkg-x64.sha')
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

test('selectAsset: desktop-app .deb/.AppImage/.exe/.dmg are NOT seeder installers', () => {
  // The exact Linux/Windows false-positive: PearCal's GitHub release ALSO carries
  // the DESKTOP Electron app, whose .deb/.AppImage/.exe share the seeder suffixes
  // but are named without "seeder". None must be selected for any platform.
  const appAssets = [
    { name: 'pearcal-v1.0.33-amd64.deb', browser_download_url: 'u/app-deb' },
    { name: 'pearcal-v1.0.33-x86_64.AppImage', browser_download_url: 'u/app-appimage' },
    { name: 'pearcal-Setup-v1.0.33.exe', browser_download_url: 'u/app-exe' },
    { name: 'pearcal-v1.0.33-mac-arm64.dmg', browser_download_url: 'u/app-dmg' },
    { name: 'pearcal-v1.0.33.apk', browser_download_url: 'u/apk' },
  ]
  assert.equal(selectAsset(appAssets, 'linux', 'x64'), null)
  assert.equal(selectAsset(appAssets, 'linux', 'arm64'), null)
  assert.equal(selectAsset(appAssets, 'win32', 'x64'), null)
  assert.equal(selectAsset(appAssets, 'darwin', 'x64'), null)
})

test('evaluateRelease: a desktop-app Linux release does not flag a seeder update', () => {
  // Regression for the bug the Linux install surface exposed: the seeder polling
  // the app's releases, which carry the desktop app's own .deb + .AppImage.
  const desktop = {
    tag_name: 'v1.0.33',
    assets: [
      { name: 'pearcal-v1.0.33-amd64.deb', browser_download_url: 'u/app-deb' },
      { name: 'pearcal-v1.0.33-x86_64.AppImage', browser_download_url: 'u/app-appimage' },
    ],
  }
  const r = evaluateRelease(desktop, { currentVersion: '0.1.0', platform: 'linux', arch: 'x64' })
  assert.equal(r.latestVersion, '1.0.33') // still reports the tag
  assert.equal(r.updateAvailable, false)  // but no seeder asset → no banner
  assert.equal(r.assetUrl, null)
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

// ---- copy-forward: a release may carry a seeder OLDER than its own tag -------
// When nothing under the seeder changed, release.sh re-attaches the previous
// release's installers rather than rebuilding them. The version that matters is
// then the one in the asset's filename, not the release tag.

test('versionFromAssetName: every installer family, and the non-versions', () => {
  assert.equal(versionFromAssetName('pearcal-seeder_1.0.37_amd64.deb'), '1.0.37')
  assert.equal(versionFromAssetName('PearCalSeeder-1.0.37-arm64.pkg'), '1.0.37')
  assert.equal(versionFromAssetName('PearCalSeeder-1.0.37-x64.pkg'), '1.0.37')
  assert.equal(versionFromAssetName('PearCalSeeder-Setup-1.0.37.exe'), '1.0.37')
  assert.equal(versionFromAssetName('PearCalSeeder-1.0.37-x86_64.AppImage'), '1.0.37')
  // Arch tokens carry digits but no dotted triple, so they can't be mistaken
  // for a version - this is what makes filename parsing safe here.
  assert.equal(versionFromAssetName('PearCalSeeder-x86_64.AppImage'), null)
  assert.equal(versionFromAssetName('pearcal-seeder_amd64.deb'), null)
  assert.equal(versionFromAssetName(null), null)
})

test('evaluateRelease: a re-attached older seeder does NOT flag an update', () => {
  // The bug this guards: tag v1.0.40 carrying the unchanged 1.0.37 installers.
  // Comparing against the TAG would tell a 1.0.37 seeder that 1.0.40 is out,
  // hand it back the same 1.0.37 build, and repeat forever.
  const release = {
    tag_name: 'v1.0.40',
    html_url: 'https://example/r/v1.0.40',
    assets: [
      { name: 'pearcal-seeder_1.0.37_amd64.deb', browser_download_url: 'u/deb' },
      { name: 'pearcal-seeder_1.0.37_amd64.deb.sha256', browser_download_url: 'u/deb.sha' },
    ],
  }
  const r = evaluateRelease(release, { currentVersion: '1.0.37', platform: 'linux', arch: 'x64', installKind: 'deb' })
  assert.equal(r.latestVersion, '1.0.37', 'reports the installable version, not the tag')
  assert.equal(r.releaseVersion, '1.0.40', 'the tag stays available separately')
  assert.equal(r.updateAvailable, false)
})

test('evaluateRelease: a re-attached seeder still updates a genuinely older one', () => {
  const release = {
    tag_name: 'v1.0.40',
    assets: [
      { name: 'pearcal-seeder_1.0.37_amd64.deb', browser_download_url: 'u/deb' },
      { name: 'pearcal-seeder_1.0.37_amd64.deb.sha256', browser_download_url: 'u/deb.sha' },
    ],
  }
  const r = evaluateRelease(release, { currentVersion: '1.0.35', platform: 'linux', arch: 'x64', installKind: 'deb' })
  assert.equal(r.latestVersion, '1.0.37')
  assert.equal(r.updateAvailable, true)
  assert.equal(r.sha256Url, 'u/deb.sha', 'sidecar still resolves for the reused asset')
})

test('evaluateRelease: a freshly built seeder matching its tag is unaffected', () => {
  const release = {
    tag_name: 'v1.0.40',
    assets: [
      { name: 'PearCalSeeder-1.0.40-x86_64.AppImage', browser_download_url: 'u/app' },
      { name: 'PearCalSeeder-1.0.40-x86_64.AppImage.sha256', browser_download_url: 'u/app.sha' },
    ],
  }
  const r = evaluateRelease(release, { currentVersion: '1.0.37', platform: 'linux', arch: 'x64' })
  assert.equal(r.latestVersion, '1.0.40')
  assert.equal(r.releaseVersion, '1.0.40')
  assert.equal(r.updateAvailable, true)
})

test('evaluateRelease: an unversioned asset name still falls back to the tag', () => {
  // Pre-1.0.38 AppImages carried no version. They must keep behaving as before
  // rather than losing their version entirely.
  const release = {
    tag_name: 'v1.0.40',
    assets: [{ name: 'PearCalSeeder-x86_64.AppImage', browser_download_url: 'u/app' }],
  }
  const r = evaluateRelease(release, { currentVersion: '1.0.37', platform: 'linux', arch: 'x64' })
  assert.equal(r.latestVersion, '1.0.40')
  assert.equal(r.updateAvailable, true)
})

test('selectAsset: the versioned AppImage name still matches arch', () => {
  const assets = [
    { name: 'PearCalSeeder-1.0.38-x86_64.AppImage', browser_download_url: 'u/x64' },
    { name: 'PearCalSeeder-1.0.38-aarch64.AppImage', browser_download_url: 'u/arm' },
  ]
  assert.equal(selectAsset(assets, 'linux', 'x64').browser_download_url, 'u/x64')
  assert.equal(selectAsset(assets, 'linux', 'arm64').browser_download_url, 'u/arm')
})
