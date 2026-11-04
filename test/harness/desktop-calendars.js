// TODO #189: desktop sidebar + editor, driven in a hidden Electron window.
//
//   node test/harness/desktop-calendars.js
//
// Nothing appears on screen.

const { spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

if (process.env.DESKTOP_CAL_DRIVER) return driver()

const REPO = path.resolve(__dirname, '..', '..')
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-cal-'))
const esbuild = path.join(REPO, 'node_modules', '.bin', 'esbuild')
const r = spawnSync(esbuild, [
  path.join(__dirname, 'desktop-calendars.jsx'),
  '--bundle', '--format=iife', '--jsx=automatic',
  '--define:process.env.NODE_ENV="production"',
  '--define:process.env.PEARCAL_VERSION="0.0.0"',
  '--log-level=warning', '--outfile=' + path.join(OUT, 'page.js'),
], { stdio: 'inherit' })
if (r.status !== 0) process.exit(r.status ?? 1)
fs.writeFileSync(path.join(OUT, 'page.html'),
  '<!doctype html><meta charset="utf-8"><body style="margin:0;background:#111;color:#eee"><div id="root"></div><script src="page.js"></script></body>')
fs.writeFileSync(path.join(OUT, 'package.json'), JSON.stringify({ name: 'desktop-cal-harness', main: 'main.js' }))
fs.writeFileSync(path.join(OUT, 'main.js'),
  'process.env.DESKTOP_CAL_DRIVER = "1"\nrequire(' + JSON.stringify(__filename) + ')\n')
const electron = path.join(REPO, 'electron', 'node_modules', '.bin', 'electron')
const run = spawnSync(electron, [OUT], { stdio: 'inherit', env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1', DESKTOP_CAL_DIR: OUT } })
fs.rmSync(OUT, { recursive: true, force: true })
process.exit(run.status ?? 1)

function driver () {
  const { app, BrowserWindow } = require('electron')
  app.disableHardwareAcceleration()
  app.whenReady().then(async () => {
    const out = []
    let failed = false
    const ok = m => out.push('ok   ' + m)
    const fail = m => { failed = true; out.push('FAIL ' + m) }
    const check = (cond, m) => cond ? ok(m) : fail(m)
    const win = new BrowserWindow({ show: false, width: 1100, height: 900, webPreferences: { backgroundThrottling: false } })
    await win.loadFile(path.join(process.env.DESKTOP_CAL_DIR, 'page.html'))
    const js = s => win.webContents.executeJavaScript(s, true)
    const sleep = ms => new Promise(r => setTimeout(r, ms))
    const sidebarText = () => js(`document.querySelector('aside').innerText`)
    const vis = async () => JSON.parse(await js('JSON.stringify(window.__vis)'))
    const clickIn = (scope, label) => js(`(() => {
      const root = document.querySelector(${JSON.stringify(scope)})
      const b = [...root.querySelectorAll('button')].find(x => x.textContent.trim() === ${JSON.stringify(label)})
      if (!b) return false
      b.click(); return true
    })()`)
    await sleep(600)

    const t0 = await sidebarText()
    const iP = t0.indexOf('PERSONAL'), iG = t0.indexOf('GROUPS')
    check(iP >= 0 && iG > iP, 'Personal section sits above Groups')
    check(t0.includes('Health'), 'personal calendar listed in the sidebar')

    check(await clickIn('aside', 'Health'), 'clicked Health in the sidebar')
    await sleep(200)
    check((await vis()).hidden.includes('personal:health'), 'hiding a calendar is stored')
    await clickIn('aside', 'Health'); await sleep(200)
    check(!(await vis()).hidden.includes('personal:health'), 'showing it again is stored')

    await clickIn('aside', 'Work'); await sleep(200)
    check((await vis()).hidden.includes('group:work'), 'group switch uses the same stored list')

    check(await clickIn('aside', '▾ Groups'), 'Groups heading folds')
    await sleep(200)
    const t1 = await sidebarText()
    check(t1.includes('GROUPS (1)') && !/\nWork\n/.test('\n' + t1 + '\n'), 'folded Groups hides its rows')
    const folded = await js(`localStorage.getItem('pearcal.sidebar.groupsFolded')`)
    check(folded === '1', 'fold state remembered')

    const typed = await js(`(() => {
      const i = document.querySelector('#editor input[placeholder="Event title"]')
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      set.call(i, 'Physio'); i.dispatchEvent(new Event('input', { bubbles: true })); return true
    })()`)
    check(typed, 'typed a title')
    const edText = await js(`document.querySelector('#editor').innerText`)
    check(/CALENDAR/.test(edText), 'editor shows a Calendar picker for a personal event')
    check(await clickIn('#editor', 'Health'), 'picked Health in the editor')
    await sleep(100)
    check(await clickIn('#editor', 'Create'), 'clicked Create')
    await sleep(200)
    const saved = JSON.parse(await js('JSON.stringify(window.__saved)'))
    check(saved?.calendarId === 'health', 'saved event carries its calendar')
    check(saved?.color === '#5DBF8A', 'saved event takes the calendar color')

    // Phase 2: web calendars in the sidebar.
    check((await sidebarText()).includes('WEB CALENDARS'), 'Web calendars section shown')
    await js(`window.__web.addSubscription({ url: 'webcal://example.org/fr.ics' })`)
    await sleep(400)
    const t2 = await sidebarText()
    check(t2.includes('Jours feries'), 'web calendar named from the file')
    const n = await js('window.__web.events.length')
    check(n === 1, 'its events are built from the download', String(n))
    const id = await js('window.__web.subscriptions[0]?.id')
    check(await clickIn('aside', 'Jours feries'), 'clicked the web calendar row')
    await sleep(200)
    check((await vis()).hidden.includes('sub:' + id), 'web calendar switch stored')

    console.log(out.join('\n'))
    app.exit(failed ? 1 : 0)
  }).catch(e => { console.error(e); app.exit(1) })
}
