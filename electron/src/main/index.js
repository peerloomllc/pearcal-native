// PearCal desktop — Electron main entry. Phase E3 adds tray + close-to-tray,
// deep-link receive (pearcal://), and lifecycle hooks for graceful quit.
// Renderer ↔ main IPC contract is unchanged from E2; the new behavior lives
// behind ipcMain handlers and Electron app events.

if (process.platform === 'linux') {
  process.env.ELECTRON_DISABLE_SANDBOX = '1'
}

const path = require('path')
const { app, BrowserWindow, Menu, Tray, ipcMain } = require('electron')
const { createBareKitShim } = require('./barekit-shim')
const { installBridge } = require('./bare-bridge')

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
})

function createWindow () {
  mainWindow = new BrowserWindow({
    width: 1024,
    height: 720,
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
    const iconPath = path.join(__dirname, '..', '..', 'build', 'icon.png')
    tray = new Tray(iconPath)
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
  mainWindow.webContents.executeJavaScript(
    `if (window.__pearHandleInvite) window.__pearHandleInvite(${safe}); true;`
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
