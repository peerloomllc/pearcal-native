// Drives test/harness/ics-import-sheet.jsx in a hidden Electron window and
// asserts the destination picker actually routes what it says it routes.
//
//   node test/harness/ics-import-sheet.js
//
// Nothing appears on screen. The window is never shown, so this is safe to run
// while Tim is using the machine.
const { spawnSync, spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const REPO = path.resolve(__dirname, '..', '..')
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'ics-sheet-'))

const esbuild = path.join(REPO, 'node_modules', '.bin', 'esbuild')
const bundle = spawnSync(esbuild, [
  path.join(__dirname, 'ics-import-sheet.jsx'),
  '--bundle', '--format=iife', '--jsx=automatic',
  '--define:process.env.NODE_ENV="production"',
  '--outfile=' + path.join(OUT, 'sheet.js'),
], { stdio: 'inherit' })
if (bundle.status !== 0) process.exit(bundle.status ?? 1)

fs.writeFileSync(path.join(OUT, 'index.html'),
  '<!doctype html><meta charset="utf-8"><body style="margin:0"><div id="root"></div><script src="sheet.js"></script></body>')

fs.writeFileSync(path.join(OUT, 'package.json'), JSON.stringify({ name: 'ics-sheet-harness', main: 'main.js' }))

fs.writeFileSync(path.join(OUT, 'main.js'), `
const { app, BrowserWindow } = require('electron')
const path = require('path')
app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  // offscreen:true forces the compositor to keep painting a window that is
  // never shown, which is what makes ICS_SHEET_SHOT produce a real image
  // instead of a flat background colour.
  const win = new BrowserWindow({ show: false, width: 420, height: 900,
    webPreferences: { offscreen: !!process.env.ICS_SHEET_SHOT, backgroundThrottling: false } })
  let lastFrame = null
  if (process.env.ICS_SHEET_SHOT) {
    win.webContents.setFrameRate(30)
    win.webContents.on('paint', (_e, _dirty, image) => { lastFrame = image })
  }
  await win.loadFile(path.join(__dirname, 'index.html'))
  const run = (js) => win.webContents.executeJavaScript(js, true)
  const out = []
  const fail = (m) => { out.push('FAIL ' + m); }
  const ok = (m) => { out.push('ok   ' + m) }

  // Pill buttons carry their label as text; find one by exact label.
  const clickPill = (label) => run(\`(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === \${JSON.stringify(label)})
    if (!b) return false
    b.click(); return true
  })()\`)
  const text = () => run('document.body.innerText')
  const importNow = () => run(\`(() => {
    const b = [...document.querySelectorAll('button')].find(x => /^Import \\\\d+ Event/.test(x.textContent.trim()))
    if (!b) return false
    b.click(); return true
  })()\`)
  const imported = () => run('JSON.stringify(window.__imported ?? null)')
  const reset = () => run('window.__imported = null')

  const body0 = await text()
  ;(body0.includes('IMPORT INTO') ? ok : fail)('destination picker rendered')
  ;(body0.includes('Keep from file') ? ok : fail)('keep-from-file offered for a PearCal .ics')
  ;(body0.includes('Each event keeps the groups it was exported with') ? ok : fail)('defaults to keeping the file groups')
  ;(body0.includes('Import 2 Events') ? ok : fail)('duplicate excluded from the count')
  ;(body0.includes('already exist') ? ok : fail)('skip notice shown')

  await clickPill('Personal')
  const bodyP = await text()
  ;(bodyP.includes('Only you will see these events.') ? ok : fail)('personal explains privacy')
  await reset(); await importNow()
  const impP = JSON.parse(await imported())
  ;(JSON.stringify(impP) === JSON.stringify([
    { title: 'Standup', groups: [] }, { title: 'Dentist', groups: [] },
  ]) ? ok : fail)('personal imports strip the file groups: ' + JSON.stringify(impP))

  await clickPill('\\u{1F3E1}Family')
  const bodyF = await text()
  ;(bodyF.includes('Everyone in Family will see these events.') ? ok : fail)('group choice warns it is shared')
  await reset(); await importNow()
  const impF = JSON.parse(await imported())
  ;(JSON.stringify(impF) === JSON.stringify([
    { title: 'Standup', groups: ['family'] }, { title: 'Dentist', groups: ['family'] },
  ]) ? ok : fail)('group import assigns every event: ' + JSON.stringify(impF))

  await clickPill('Keep from file')
  await reset(); await importNow()
  const impK = JSON.parse(await imported())
  ;(JSON.stringify(impK) === JSON.stringify([
    { title: 'Standup', groups: ['work'] }, { title: 'Dentist', groups: [] },
  ]) ? ok : fail)('keep-from-file preserves per-event groups: ' + JSON.stringify(impK))

  // ICS_SHEET_SHOT=/path/to.png captures the sheet for a visual check.
  if (process.env.ICS_SHEET_SHOT) {
    await clickPill('Personal')
    await new Promise(r => setTimeout(r, 800))  // let the sheet finish sliding up
    if (lastFrame) require('fs').writeFileSync(process.env.ICS_SHEET_SHOT, lastFrame.toPNG())
    else out.push('FAIL no frame painted for ICS_SHEET_SHOT')
  }
  console.log(out.join('\\n'))
  app.exit(out.some(l => l.startsWith('FAIL')) ? 1 : 0)
}).catch(e => { console.error(e); app.exit(1) })
`)

const electron = path.join(REPO, 'electron', 'node_modules', '.bin', 'electron')
const child = spawn(electron, [OUT], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' },
})
child.on('exit', (code) => process.exit(code ?? 1))
