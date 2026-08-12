// The Mac-sync exclude list (scripts/mac-sync-excludes.txt), TODO #168.
//
// The bug this guards against is not a crash, it is silence: four call sites
// each kept their own exclude list, the repo grew electron/dist,
// seeder-launcher/dist and 4.4 GB of loose installers, and every sync then
// walked 18 GB to deliver 18 MB with --checksum hashing all of it on both ends.
// Nothing errored. A build just stopped finishing.
//
// So the load-bearing test is the last one: no directory in the REAL repo may
// grow past the heavy threshold without being excluded. That is what makes the
// rot loud next time instead of costing someone half an hour.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  EXCLUDES_FILE, HEAVY_DIR_BYTES, parseExcludes, loadExcludes,
  isExcluded, measureSyncSet, unexcludedHeavyDirs
} = require('../scripts/lib/syncExcludes.js')

const REPO_ROOT = path.join(__dirname, '..')
const patterns = loadExcludes()

test('comments and blank lines are not patterns', () => {
  const p = parseExcludes('# a comment\n\n  node_modules  \n\n# another\n/android\n')
  assert.deepEqual(p, ['node_modules', '/android'])
})

test('a trailing slash is accepted and means the same thing', () => {
  assert.deepEqual(parseExcludes('/electron/dist/\nnode_modules/'), ['/electron/dist', 'node_modules'])
})

test('rsync syntax we do not faithfully reproduce is rejected, not guessed at', () => {
  // Matching these differently here than rsync does would make the guard lie.
  for (const bad of ['src/**/dist', 'file[0-9].bin', '!keep.me']) {
    assert.throws(() => parseExcludes(bad), /unsupported rsync pattern/, bad)
  }
})

test('a bare name matches that segment at any depth', () => {
  assert.equal(isExcluded('node_modules', patterns), true)
  assert.equal(isExcluded('electron/node_modules/foo/index.js', patterns), true)
  assert.equal(isExcluded('deep/nested/node_modules', patterns), true)
})

test('an anchored pattern matches only at the root', () => {
  assert.equal(isExcluded('android/app/build.gradle', patterns), true)
  // A file that merely happens to sit under a same-named subdirectory is source.
  assert.equal(isExcluded('src/ui/android/helper.js', patterns), false)
})

test('a glob matches the basename at any depth', () => {
  assert.equal(isExcluded('pearcal-v1.0.44-x86_64.AppImage', patterns), true)
  assert.equal(isExcluded('electron/dist/PearCal-1.0.44.dmg', patterns), true)
  assert.equal(isExcluded('seeder-launcher/start9/pearcal-seeder.s9pk', patterns), true)
})

test('the things an iOS build actually needs are NOT excluded', () => {
  // The failure mode on the other side: over-excluding breaks the build in a way
  // that looks like a code bug rather than a sync bug.
  for (const keep of [
    'src/bare.js', 'src/lib/swarmBounce.js', 'src/ui/App.jsx',
    'app/index.tsx', 'assets/bare-ios.bundle', 'assets/app-ui.bundle',
    'ios/PearCal/Info.plist', 'ios/PearCal.xcodeproj/project.pbxproj',
    'ios/Podfile', 'package.json', 'app.json', 'babel.config.js',
    'scripts/ios-screenshots.sh', 'electron/src/main/index.js'
  ]) {
    assert.equal(isExcluded(keep, patterns), false, keep + ' must reach the Mac')
  }
})

test('the Mac generates its own Pods, so ours must not clobber them', () => {
  assert.equal(isExcluded('ios/Pods/Manifest.lock', patterns), true)
  assert.equal(isExcluded('ios/build/anything', patterns), true)
})

test('Podfile.lock is machine-specific and stays home; the Podfile travels', () => {
  // react-native-bare-kit's podspec version embeds a hash of the local
  // node_modules, so our lock can NEVER equal the one the Mac's own pod install
  // produces. Pushing it leaves Podfile.lock != Pods/Manifest.lock and every
  // build dies in "[CP] Check Pods Manifest.lock" with exit 65. Caught by
  // running the new script for real, not by reading the code.
  assert.equal(isExcluded('ios/Podfile.lock', patterns), true)
  // The Podfile must still travel, or a real dependency change never reaches
  // the Mac and --pods would regenerate the same lock it started with.
  assert.equal(isExcluded('ios/Podfile', patterns), false)
  assert.equal(isExcluded('ios/Podfile.properties.json', patterns), false)
})

test('secrets and keystores never leave this machine', () => {
  assert.equal(isExcluded('release.keystore', patterns), true)
  assert.equal(isExcluded('android/app/debug.jks', patterns), true)
  assert.equal(isExcluded('scripts/.env', patterns), true)
})

test('every historical offender is covered', () => {
  // The exact set that made a sync walk 18 GB on 2026-08-11.
  for (const gone of [
    'electron/dist/win-unpacked/resources/app.asar',
    'seeder-launcher/dist/macos/PearCalSeeder-1.0.44-arm64.pkg',
    'seeder-launcher/start9/docker-images/x86_64.tar',
    'pearcal-v1.0.44-amd64.deb',
    'pearcal-Setup-v1.0.44.exe',
    'pearcal-v1.0.44.aab',
    'PearCal Setup 1.0.44.exe.blockmap'
  ]) {
    assert.equal(isExcluded(gone, patterns), true, gone + ' must never be synced')
  }
})

test('measureSyncSet skips excluded subtrees instead of descending them', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-set-'))
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.mkdirSync(path.join(root, 'electron', 'dist'), { recursive: true })
  fs.mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true })
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'x'.repeat(1000))
  fs.writeFileSync(path.join(root, 'electron', 'dist', 'big.AppImage'), 'y'.repeat(50_000))
  fs.writeFileSync(path.join(root, 'node_modules', 'x', 'y.js'), 'z'.repeat(50_000))

  const { bytes, files } = measureSyncSet(root, patterns)
  assert.equal(files, 1)
  assert.equal(bytes, 1000)
  fs.rmSync(root, { recursive: true, force: true })
})

test('a heavy unexcluded directory is reported by name', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-heavy-'))
  fs.mkdirSync(path.join(root, 'newthing', 'inner'), { recursive: true })
  fs.writeFileSync(path.join(root, 'newthing', 'inner', 'blob.bin'), Buffer.alloc(2048))

  const heavy = unexcludedHeavyDirs(root, patterns, { heavyBytes: 1024 })
  assert.equal(heavy.length, 1, 'only the outermost offender, not every parent chain')
  assert.equal(heavy[0].name, 'newthing')
  fs.rmSync(root, { recursive: true, force: true })
})

// ── The one that actually prevents the regression ───────────────────────────
test('THE REAL REPO has no heavy directory that the exclude list misses', () => {
  const heavy = unexcludedHeavyDirs(REPO_ROOT, patterns)
  const named = heavy.map(d => d.name + ' (' + (d.bytes / 1048576).toFixed(0) + ' MB)').join(', ')
  assert.equal(heavy.length, 0,
    'these would be sent to the Mac on every build and eventually stall it: ' + named +
    '\nAdd them to ' + path.relative(REPO_ROOT, EXCLUDES_FILE) +
    ' (threshold ' + (HEAVY_DIR_BYTES / 1048576) + ' MB)')
})

test('the real sync set stays small enough for --checksum to be affordable', () => {
  const { bytes } = measureSyncSet(REPO_ROOT, patterns)
  const megabytes = bytes / 1048576
  assert.ok(megabytes < 250,
    'sync set is ' + megabytes.toFixed(1) + ' MB; --checksum hashes all of it on BOTH ends')
})
