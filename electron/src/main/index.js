// PearCal desktop — Electron main entry. Phase E2: BareKit shim + real
// src/bare.js. The renderer ↔ main IPC contract is identical to Phase E1
// (preload's window.ReactNativeWebView.postMessage → ipcMain 'bare-call');
// the only change is what handles 'bare-call' on the main side — now bare.js,
// not the canned stub.

if (process.platform === 'linux') {
  process.env.ELECTRON_DISABLE_SANDBOX = '1'
}

const path = require('path')
const { app, BrowserWindow, Menu } = require('electron')
const { createBareKitShim } = require('./barekit-shim')
const { installBridge } = require('./bare-bridge')

let mainWindow

// Install the BareKit shim BEFORE requiring bare.js — bare.js's module-top
// `BareKit.IPC.on('data', ...)` binds to our EventEmitter at require time.
const shim = createBareKitShim()
const bridge = installBridge({ shim, getMainWindow: () => mainWindow })

// Now load bare.js. It reads BareKit.IPC, sets up its own dispatch loop, and
// awaits the init message before processing other calls.
require('../../../src/bare.js')

// Tell bare.js where to put its data. Mobile sends this from the RN shell;
// the prior Pear desktop sent it from the renderer. On Electron we have a
// real per-platform user-data dir, so just use app.getPath('userData').
//
//   linux  : ~/.config/pearcal-electron/pearcal/
//   darwin : ~/Library/Application Support/pearcal-electron/pearcal/
//   win32  : %APPDATA%\pearcal-electron\pearcal\
app.whenReady().then(() => {
  const dataDir = path.join(app.getPath('userData'), 'pearcal')
  bridge.sendToBare({ method: 'init', dataDir, platform: 'desktop' })
  createWindow()
})

function createWindow () {
  mainWindow = new BrowserWindow({
    width: 1024,
    height: 720,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#0f172a',
    title: 'PearCal',
    webPreferences: {
      preload: path.join(__dirname, '..', 'renderer', 'preload.js'),
      contextIsolation: false,
      nodeIntegration: false
    }
  })

  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
  }

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))

  // Drain any events bare emitted before the window finished loading.
  mainWindow.webContents.once('did-finish-load', () => {
    bridge.flushBufferedEvents()
  })

  // Surface renderer console in main stdout — useful when iterating without
  // devtools open.
  mainWindow.webContents.on('console-message', (_e, _level, message) => {
    console.log('[renderer]', message)
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
