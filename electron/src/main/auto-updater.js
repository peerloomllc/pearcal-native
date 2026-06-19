// In-place auto-update for targets that support it (NSIS on Windows, AppImage
// on Linux). electron-updater reads the latest.yml / latest-linux.yml that
// electron-builder uploads alongside each GitHub release (see build.publish in
// package.json) and downloads the new build, then we prompt the user to
// restart into it. .deb and the unsigned/un-notarized Mac .dmg can't self-
// update — those stay on the notify-and-link path in update-checker.js.
//
// autoUpdater is a no-op unless the app is packaged, so main/index.js only
// starts this on the supported, packaged targets.

const { app, ipcMain } = require('electron')
const { autoUpdater } = require('electron-updater')

const INITIAL_DELAY_MS = 30 * 1000
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000   // every 6h while running

let _timer = null
let _getMainWindow = null

function _send (channel, payload) {
  const win = _getMainWindow?.()
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function start ({ getMainWindow }) {
  _getMainWindow = getMainWindow

  // Ask before downloading: surface the available version and only fetch it
  // when the user clicks Download. Once downloaded, install on the next quit
  // if they don't restart right away.
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = { info: console.log, warn: console.warn, error: console.error, debug () {} }

  autoUpdater.on('update-available', (info) => _send('update-can-download', { version: info?.version }))
  autoUpdater.on('download-progress', (p) => _send('update-progress', { percent: Math.round(p?.percent ?? 0) }))
  autoUpdater.on('update-downloaded', (info) => _send('update-ready', { version: info?.version }))
  autoUpdater.on('error', (err) => console.warn('[autoupdate] error:', err?.message ?? err))

  // Renderer's "Download" button → start the download (progress + ready follow).
  ipcMain.handle('update:download', () => {
    autoUpdater.downloadUpdate().catch(e => console.warn('[autoupdate] download failed:', e?.message ?? e))
  })
  // Renderer's "Restart now" button.
  ipcMain.handle('update:install', () => {
    try { autoUpdater.quitAndInstall() } catch (e) { console.warn('[autoupdate] install failed:', e?.message ?? e) }
  })
  ipcMain.handle('update:check-now', () => _check())

  setTimeout(_check, INITIAL_DELAY_MS)
  _timer = setInterval(_check, CHECK_INTERVAL_MS)
}

function _check () {
  return autoUpdater.checkForUpdates().catch(e => console.warn('[autoupdate] check failed:', e?.message ?? e))
}

function stop () {
  if (_timer) { clearInterval(_timer); _timer = null }
}

module.exports = { start, stop }
