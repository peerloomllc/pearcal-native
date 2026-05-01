// PearCal desktop — Electron main entry. Phase E3 adds tray + close-to-tray,
// deep-link receive (pearcal://), and lifecycle hooks for graceful quit.
// Renderer ↔ main IPC contract is unchanged from E2; the new behavior lives
// behind ipcMain handlers and Electron app events.

// AppImage / desktop-launcher launches give us stdio wired to pipes whose
// other end can close (e.g. the launcher exits a few seconds after spawn).
// The next write to stderr then throws EPIPE asynchronously with no listener,
// surfacing as Electron's "A JavaScript error occurred in the main process"
// dialog. bare.js logs freely via console.warn/error from peer-connection
// error handlers, so install listeners that swallow EPIPE on both stdio
// streams. Other write errors still throw.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err) => {
    if (err && (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED')) return
    throw err
  })
}

if (process.platform === 'linux') {
  process.env.ELECTRON_DISABLE_SANDBOX = '1'
}

const path = require('path')
const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage } = require('electron')
const { createBareKitShim } = require('./barekit-shim')
const { installBridge } = require('./bare-bridge')
const { scheduleForEvent: scheduleForEventOnBoot } = require('./shell-handlers')

// Single instance — the second invocation should focus the existing window
// (and forward any pearcal:// URL it was launched with) instead of opening
// a new one. requestSingleInstanceLock returns false in the second process,
// which immediately quits.
if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

// Register pearcal:// for cold-launch on macOS (open-url) and Win/Linux
// (second-instance argv). Mac also needs the app's Info.plist to declare
// the scheme — handled by electron-builder.protocols in Phase E4.
app.setAsDefaultProtocolClient('pearcal')

// AppUserModelID: Win10/11 looks up the app's display name + icon for
// toast notifications and Start menu grouping by this id. Without it,
// notifications show the executable-derived id (e.g. "app.electron.
// pearcal-electron") instead of "PearCal" and use a generic icon.
// Must match electron-builder's `appId` in package.json so the installer's
// Start-menu shortcut, the notification bridge, and the main process all
// reference the same identity. No-op on macOS/Linux but harmless.
app.setAppUserModelId('com.pearcal.desktop')

let mainWindow = null
let tray = null
let isQuitting = false
let pendingDeepLink = null  // arrived before window was ready

const shim = createBareKitShim()
const bridge = installBridge({
  shim,
  getMainWindow: () => mainWindow,
  requestQuit: () => { isQuitting = true; app.quit() }
})

// vendor/src/bare.js is a copy of ../../../src/bare.js placed there by
// scripts/prepack.js (postinstall + before each build) so the electron/
// subproject is self-contained for electron-builder packaging. Mobile
// continues to use ../../../src/bare.js directly via its own bundler.
require('../../vendor/src/bare.js')

app.whenReady().then(() => {
  const dataDir = path.join(app.getPath('userData'), 'pearcal')
  bridge.sendToBare({ method: 'init', dataDir, platform: 'desktop' })
  createWindow()
  createTray()

  // If we were cold-launched with a pearcal:// URL on Win/Linux, it lives
  // in process.argv. Capture it here so it gets delivered once the renderer
  // installs window.__pearHandleInvite.
  const cliUrl = process.argv.find(a => /^(pearcal:\/\/(join|pair)|pear:\/\/pearcal\/(join|pair))/.test(a))
  if (cliUrl) deliverDeepLink(cliUrl)

  // Reminders are stored as setTimeout handles in shell-handlers' in-memory
  // Map (see _reminders) and die with the process. Mobile's OS-managed
  // alarms survive restart; we have to walk the bare DB on cold launch and
  // re-schedule. callBare queues until bare init resolves, so this is safe
  // to fire-and-forget here.
  rehydrateReminders().catch(e => console.warn('[main] reminder rehydration failed:', e?.message ?? e))
  scheduleNextRehydration()
})

// Rehydration window. setTimeout's max delay is 2^31-1 ms (~24.8 days);
// any longer delay overflows to 0 and fires immediately. Recurring
// events with occurrences months out would all schedule into the past,
// flooding the user with notifications at cold launch. Capping at 7
// days keeps every scheduled timer well under the overflow boundary,
// and the daily re-rehydration loop pulls events into the window as
// they get closer.
const REHYDRATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const REHYDRATE_INTERVAL_MS = 24 * 60 * 60 * 1000

function _eventStartMs (ev) {
  if (!ev?.date) return null
  const [y, mo, d] = ev.date.split('-').map(Number)
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null
  let h = 9, m = 0
  if (!ev.allDay && ev.start) {
    const parts = ev.start.split(':').map(Number)
    if (Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
      h = parts[0]; m = parts[1]
    }
  }
  const ms = new Date(y, mo - 1, d, h, m, 0, 0).getTime()
  return Number.isFinite(ms) ? ms : null
}

async function rehydrateReminders () {
  const events = await bridge.callBare('listEvents', [])
  if (!Array.isArray(events) || events.length === 0) return
  const now = Date.now()
  const cutoff = now + REHYDRATE_WINDOW_MS
  let scheduled = 0
  let outOfWindow = 0
  for (const ev of events) {
    if (!ev || !ev.id) continue
    const startMs = _eventStartMs(ev)
    // Skip events outside the rehydration window. Events more than 7
    // days out get scheduled by a future re-rehydration tick. Events
    // more than 1 hour past would be filtered by the schedule logic
    // anyway, but bailing here saves the bare-call round-trip.
    if (startMs == null || startMs < now - 60 * 60 * 1000 || startMs > cutoff) {
      outOfWindow++
      continue
    }
    const reminders = await bridge.callBare('getReminders', [ev.id]).catch(() => null)
    if (!Array.isArray(reminders) || reminders.length === 0) continue
    scheduleForEventOnBoot(ev, reminders, () => mainWindow)
    scheduled++
  }
  if (scheduled > 0 || outOfWindow > 0) {
    console.log('[main] rehydrated reminders: scheduled=' + scheduled + ' outOfWindow=' + outOfWindow)
  }
}

// Daily rolling rehydration so events sitting just past the 7-day
// window get picked up as they get closer, without requiring the user
// to restart the app. _scheduleForEvent's per-event _cancelForEvent
// makes the re-call idempotent — already-scheduled timers in the same
// window get replaced rather than duplicated.
let _rehydrateTimer = null
function scheduleNextRehydration () {
  if (_rehydrateTimer) clearTimeout(_rehydrateTimer)
  _rehydrateTimer = setTimeout(() => {
    rehydrateReminders().catch(e => console.warn('[main] reminder rehydration failed:', e?.message ?? e))
    scheduleNextRehydration()
  }, REHYDRATE_INTERVAL_MS)
}

function createWindow () {
  mainWindow = new BrowserWindow({
    width: 1536,
    height: 1080,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#0f172a',
    title: 'PearCal',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'renderer', 'preload.js'),
      contextIsolation: false,
      nodeIntegration: false
    }
  })

  if (process.platform !== 'darwin') Menu.setApplicationMenu(null)
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))

  mainWindow.webContents.once('did-finish-load', () => {
    bridge.flushBufferedEvents()
    if (pendingDeepLink) {
      const url = pendingDeepLink
      pendingDeepLink = null
      injectDeepLink(url)
    }
  })

  mainWindow.webContents.on('console-message', (_e, _level, message) => {
    console.log('[renderer]', message)
  })

  // Close-to-tray. The flag is set true by app.on('before-quit') and by the
  // tray's Quit menu item via requestQuit(); only then does the window
  // actually destroy itself. Otherwise close hides — same UX as mobile
  // pressing the home button.
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      mainWindow.hide()
    }
  })
}

function createTray () {
  try {
    // Note for KDE Plasma Wayland devs: the tray (and BrowserWindow) icon
    // will show as a generic placeholder in `electron .` dev mode, regardless
    // of the file passed here. KDE resolves app icons via the system icon
    // theme + .desktop file, not the path Electron supplies at runtime —
    // packaging via electron-builder (Phase E4) installs a .desktop file
    // pointing at the properly registered icon, which fixes both.
    //
    // macOS menu-bar icons are conventionally white-on-transparent (template
    // images) so they auto-theme between light and dark menu bars. Use the
    // monochrome Android status-bar drawable (ic_stat_name) as the source on
    // Mac, downsized to 22×22 (the canonical menu-bar size), and flagged as
    // a template — Cocoa renders it black on light bg, white on dark bg.
    //
    // Linux/Windows trays expect a colored full-bleed icon and use the
    // standard build/icon.png (resized once to keep the source tiny — Mac
    // doesn't auto-resize at all; Linux/Windows do but starting from 32×32
    // avoids any "1024×1024 source got blurred down" surprise).
    let trayIcon
    if (process.platform === 'darwin') {
      const trayPath = path.join(__dirname, '..', '..', 'build', 'tray-icon.png')
      trayIcon = nativeImage.createFromPath(trayPath).resize({ width: 22, height: 22 })
      trayIcon.setTemplateImage(true)
    } else {
      const iconPath = path.join(__dirname, '..', '..', 'build', 'icon.png')
      trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 32, height: 32 })
    }
    tray = new Tray(trayIcon)
    tray.setToolTip('PearCal')
    tray.setContextMenu(Menu.buildFromTemplate([
      {
        label: 'Show PearCal',
        click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus() } }
      },
      { type: 'separator' },
      {
        label: 'Quit PearCal',
        click: () => { isQuitting = true; app.quit() }
      }
    ]))
    tray.on('click', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus() } })
  } catch (e) {
    console.error('[main] tray setup failed:', e?.message ?? e)
  }
}

// Deep link routing. Mobile injects pearcal:// URLs into
// window.__pearHandleInvite, which is set up by src/ui/main.jsx with a
// pre-mount buffer. We do the same here.
function deliverDeepLink (url) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.webContents.isLoading()) {
      pendingDeepLink = url
    } else {
      injectDeepLink(url)
    }
  } else {
    pendingDeepLink = url
  }
}

function injectDeepLink (url) {
  const safe = JSON.stringify(url)
  // Pair URLs must bypass the join-sheet flow and go straight to
  // consumePairLink — mobile splits these in app/index.tsx:434-439, the
  // electron path needs the same split or the OnboardingModal pair handshake
  // never runs. Browser-clicked pearcal://pair URLs hit only this code path
  // (the OnboardingModal paste flow calls db.consumePairLink directly and
  // is unaffected).
  const isPair = /^(pearcal:\/\/pair|pear:\/\/pearcal\/pair)/.test(url)
  const fn = isPair ? '__pearHandlePair' : '__pearHandleInvite'
  mainWindow.webContents.executeJavaScript(
    `if (window.${fn}) window.${fn}(${safe}); true;`
  ).catch(() => {})
}

// macOS: cold launch from a pearcal:// URL fires open-url synchronously
// before app.whenReady; warm receipt fires whenever a URL is opened.
app.on('open-url', (event, url) => {
  event.preventDefault()
  deliverDeepLink(url)
  if (mainWindow) { mainWindow.show(); mainWindow.focus() }
})

// Win/Linux: second-instance fires when a second invocation is blocked by
// requestSingleInstanceLock. The URL lives in argv.
app.on('second-instance', (_event, argv) => {
  const url = argv.find(a => /^(pearcal:\/\/(join|pair)|pear:\/\/pearcal\/(join|pair))/.test(a))
  if (url) deliverDeepLink(url)
  if (mainWindow) { mainWindow.show(); mainWindow.focus() }
})

app.on('before-quit', () => { isQuitting = true })

app.on('window-all-closed', () => {
  // With close-to-tray, this only fires when isQuitting is true (the
  // window was explicitly destroyed). Quit so the process actually exits.
  app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
  else if (mainWindow) mainWindow.show()
})
