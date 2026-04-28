// PearCal desktop — Electron main entry. Phase E1: scaffold + stub IPC, no
// bare.js yet. Phase E2 wires the BareKit shim and requires src/bare.js so
// the same code that runs in the mobile bare worklet runs here in main.

if (process.platform === 'linux') {
  // Electron's Linux sandbox needs a setuid chrome-sandbox helper that
  // some distros (Fedora Wayland, etc.) don't ship. Disable it before
  // requiring electron so the setting propagates to child processes.
  process.env.ELECTRON_DISABLE_SANDBOX = '1'
}

const path = require('path')
const { app, BrowserWindow, ipcMain, Menu } = require('electron')

let mainWindow

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

  // Hide the default menu bar on Linux/Windows. macOS keeps its app menu
  // because it's required for OS conventions (about, services, hide, quit).
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
  }

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
}

// Phase E1 stub: respond to bare-call IPC with canned data so the React UI
// has something to render against. Phase E2 replaces this whole handler with
// the BareKit shim → src/bare.js bridge. Mirrors the prior desktop/bare-worker.js
// stub down to the in-memory mutable profile (so updateProfile actually
// round-trips and the user lands past onboarding on every relaunch).
const _profile = {
  id: 'electron-stub',
  name: 'Desktop User',
  color: '#3b82f6',
  onboardingComplete: true
}

const STUB_RESPONSES = {
  listEvents: [],
  listGroups: [],
  listMembers: [],
  listRsvps: [],
  listMyRsvps: [],
  getReminders: [],
  listMyReminders: [],
  getRsvp: null,
  getPrivateNote: '',
  hasMnemonic: true,
  getBackupStatus: { provider: null, available: false, enabled: false, latestBackup: null },
  isBlockedFromGroup: false
}

ipcMain.handle('bare-call', async (_event, { method, args }) => {
  if (method === 'getProfile') return { ..._profile }
  if (method === 'updateProfile') {
    Object.assign(_profile, args?.[0] ?? {})
    return { ..._profile }
  }
  if (method in STUB_RESPONSES) return STUB_RESPONSES[method]
  return null
})

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  // Standard Electron pattern: macOS apps stay alive without windows;
  // others quit. Phase E3 will override this with close-to-tray.
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
