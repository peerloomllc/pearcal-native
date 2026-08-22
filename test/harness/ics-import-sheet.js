// Drives the .ics import destination picker for real, on both platforms, in a
// hidden Electron window:
//
//   node test/harness/ics-import-sheet.js
//   ICS_SHEET_SHOT=/tmp/shot.png node test/harness/ics-import-sheet.js   # + capture
//
// ics-import-sheet.jsx mounts mobile's ImportIcsSheet, ics-import-modal.jsx
// mounts desktop's ImportIcsModal, and ics-import-driver.js runs the SAME
// assertions against both - they are meant to answer the same question the same
// way, so drift between them fails here rather than surprising someone later.
//
// Nothing appears on screen. The window is never shown, so this is safe to run
// while Tim is using the machine.
const { spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const REPO = path.resolve(__dirname, '..', '..')
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'ics-import-'))

const TARGETS = [
  { name: 'mobile',  entry: 'ics-import-sheet.jsx' },
  { name: 'desktop', entry: 'ics-import-modal.jsx' },
]

const esbuild = path.join(REPO, 'node_modules', '.bin', 'esbuild')
for (const t of TARGETS) {
  const r = spawnSync(esbuild, [
    path.join(__dirname, t.entry),
    '--bundle', '--format=iife', '--jsx=automatic',
    '--define:process.env.NODE_ENV="production"',
    '--define:process.env.PEARCAL_VERSION="0.0.0"',
    '--log-level=warning',
    '--outfile=' + path.join(OUT, t.name + '.js'),
  ], { stdio: 'inherit' })
  if (r.status !== 0) process.exit(r.status ?? 1)
  fs.writeFileSync(path.join(OUT, t.name + '.html'),
    '<!doctype html><meta charset="utf-8"><body style="margin:0"><div id="root"></div>'
    + '<script src="' + t.name + '.js"></script></body>')
}

// Electron needs an app directory with a package.json; the real driver stays a
// readable file in this folder and is only required from there.
fs.writeFileSync(path.join(OUT, 'package.json'),
  JSON.stringify({ name: 'ics-import-harness', main: 'main.js' }))
fs.writeFileSync(path.join(OUT, 'main.js'),
  'require(' + JSON.stringify(path.join(__dirname, 'ics-import-driver.js')) + ')\n')

// One Electron process per target. Two windows in a single process worked for
// the first target and then failed ERR_FAILED on the second one's loadFile, and
// a fresh process per target is both cheap and immune to whatever that is.
const electron = path.join(REPO, 'electron', 'node_modules', '.bin', 'electron')
let failed = false
for (const t of TARGETS) {
  const r = spawnSync(electron, [OUT], {
    stdio: 'inherit',
    env: {
      ...process.env,
      ELECTRON_DISABLE_SANDBOX: '1',
      ICS_HARNESS_DIR: OUT,
      ICS_TARGETS: t.name,
    },
  })
  if (r.status !== 0) failed = true
}
process.exit(failed ? 1 : 0)
