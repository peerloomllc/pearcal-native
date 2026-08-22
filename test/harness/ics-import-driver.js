// Electron main process for test/harness/ics-import-sheet.js. Kept as its own
// real file rather than a string the runner writes, so it stays readable and
// nothing has to be escaped twice.
//
// Reads two env vars the runner sets:
//   ICS_HARNESS_DIR  directory holding <target>.html / <target>.js
//   ICS_SHEET_SHOT   optional PNG path; a "-<target>" suffix is added per target
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const DIR = process.env.ICS_HARNESS_DIR
const SHOT = process.env.ICS_SHEET_SHOT || ''
const TARGETS = (process.env.ICS_TARGETS || 'mobile,desktop').split(',')

app.disableHardwareAcceleration()

// Fixtures live in the two .jsx entries; keep these in step with them.
const PERSONAL = [{ title: 'Standup', groups: [] }, { title: 'Dentist', groups: [] }]
const FAMILY   = [{ title: 'Standup', groups: ['family'] }, { title: 'Dentist', groups: ['family'] }]
const FROM_FILE = [{ title: 'Standup', groups: ['work'] }, { title: 'Dentist', groups: [] }]

const CLICK_PILL = (label) => `(() => {
  const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === ${JSON.stringify(label)})
  if (!b) return false
  b.click(); return true
})()`

const CLICK_IMPORT = `(() => {
  const b = [...document.querySelectorAll('button')].find(x => /^Import \\d+ Event/.test(x.textContent.trim()))
  if (!b) return false
  b.click(); return true
})()`

app.whenReady().then(async () => {
  const out = []
  let failed = false
  const ok   = (m) => out.push('ok   ' + m)
  const fail = (m) => { failed = true; out.push('FAIL ' + m) }

  for (const target of TARGETS) {
    // offscreen:true forces the compositor to keep painting a window that is
    // never shown, which is what makes ICS_SHEET_SHOT produce a real image
    // instead of a flat background colour.
    const win = new BrowserWindow({ show: false, width: 460, height: 940,
      webPreferences: { offscreen: !!SHOT, backgroundThrottling: false } })
    let lastFrame = null
    if (SHOT) {
      win.webContents.setFrameRate(30)
      win.webContents.on('paint', (_e, _dirty, image) => { lastFrame = image })
    }
    await win.loadFile(path.join(DIR, target + '.html'))

    const run = (js) => win.webContents.executeJavaScript(js, true)
    const t = (m) => target + ': ' + m
    const clickPill = async (label) => {
      const hit = await run(CLICK_PILL(label))
      if (!hit) fail(t('no pill labelled ' + JSON.stringify(label)))
      return hit
    }
    const text = () => run('document.body.innerText')
    const imported = async () => JSON.parse(await run('JSON.stringify(window.__imported ?? null)'))
    const importNow = async () => {
      await run('window.__imported = null')
      if (!(await run(CLICK_IMPORT))) fail(t('no import button'))
      return imported()
    }
    const eq = (got, want, msg) => {
      if (JSON.stringify(got) === JSON.stringify(want)) ok(t(msg))
      else fail(t(msg + ' - got ' + JSON.stringify(got)))
    }
    const has = (body, needle, msg) => {
      if (body.includes(needle)) ok(t(msg))
      else fail(t(msg + ' - missing ' + JSON.stringify(needle)))
    }

    const body0 = await text()
    has(body0, 'IMPORT INTO', 'destination picker rendered')
    has(body0, 'Keep from file', 'keep-from-file offered for a PearCal .ics')
    has(body0, 'Each event keeps the groups it was exported with', 'defaults to keeping the file groups')
    has(body0, 'Import 2 Events', 'duplicate excluded from the count')
    has(body0, '1 event already exists - will be skipped', 'skip notice reads as singular')

    await clickPill('Personal')
    has(await text(), 'Only you will see these events.', 'personal explains privacy')
    eq(await importNow(), PERSONAL, 'personal strips the file groups')

    await clickPill('\u{1F3E1}Family')
    has(await text(), 'Everyone in Family will see these events.', 'group choice warns it is shared')
    eq(await importNow(), FAMILY, 'group import assigns every event')

    await clickPill('Keep from file')
    eq(await importNow(), FROM_FILE, 'keep-from-file preserves per-event groups')

    if (SHOT) {
      await clickPill('Personal')
      await new Promise(r => setTimeout(r, 800))  // let the sheet finish sliding up
      if (lastFrame) {
        const ext = path.extname(SHOT)
        fs.writeFileSync(SHOT.slice(0, SHOT.length - ext.length) + '-' + target + ext, lastFrame.toPNG())
      } else fail(t('no frame painted for ICS_SHEET_SHOT'))
    }
    win.destroy()
  }

  console.log(out.join('\n'))
  app.exit(failed ? 1 : 0)
}).catch(e => { console.error(e); app.exit(1) })
