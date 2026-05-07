// Notify-only update checker. Polls GitHub Releases for a newer version than
// app.getVersion() and sends 'update-available' to the renderer; the preload
// renders a banner with Download / Skip / Later. Download opens the release
// page in the user's default browser — no in-place upgrade until builds are
// signed (Mac is hardenedRuntime:false + unnotarized, Windows is unsigned).
//
// Skipped versions persist in {userData}/pearcal/skipped-updates.json so a
// dismissed banner stays dismissed across restarts; "Later" just closes the
// banner and the next daily tick will resurface it.

const fs = require('fs')
const path = require('path')
const { app, ipcMain, net, shell } = require('electron')

const RELEASES_API = 'https://api.github.com/repos/peerloomllc/pearcal-native/releases/latest'
const INITIAL_DELAY_MS = 30 * 1000
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

let _timer = null
let _skipFile = null
let _getMainWindow = null

function _skippedPath () {
  return path.join(app.getPath('userData'), 'pearcal', 'skipped-updates.json')
}

function _readSkipped () {
  try { return JSON.parse(fs.readFileSync(_skipFile, 'utf8')) } catch { return [] }
}

function _writeSkipped (list) {
  try {
    fs.mkdirSync(path.dirname(_skipFile), { recursive: true })
    fs.writeFileSync(_skipFile, JSON.stringify(list))
  } catch (e) {
    console.warn('[update] write skip list failed:', e?.message ?? e)
  }
}

// "v1.0.25" → [1, 0, 25]; null on garbage so callers bail safely.
function _parseVersion (s) {
  const m = String(s ?? '').replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

function _isNewer (a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true
    if (a[i] < b[i]) return false
  }
  return false
}

function _fetchLatest () {
  return new Promise((resolve, reject) => {
    const req = net.request({
      url: RELEASES_API,
      headers: {
        'User-Agent': 'PearCal-Updater',
        'Accept': 'application/vnd.github+json'
      }
    })
    let body = ''
    req.on('response', (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error('github status ' + res.statusCode))
      }
      res.on('data', (chunk) => { body += chunk.toString() })
      res.on('end', () => {
        try { resolve(JSON.parse(body)) } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.end()
  })
}

async function _checkOnce () {
  try {
    const release = await _fetchLatest()
    const latest = _parseVersion(release?.tag_name)
    const current = _parseVersion(app.getVersion())
    if (!latest || !current) return
    if (!_isNewer(latest, current)) return
    const tag = release.tag_name
    if (_readSkipped().includes(tag)) return
    const win = _getMainWindow?.()
    if (!win || win.isDestroyed()) return
    win.webContents.send('update-available', {
      version: tag,
      htmlUrl: release.html_url,
      publishedAt: release.published_at,
      // GitHub release notes can be many KB of markdown; we only show the
      // first few lines in the banner, so trim before crossing IPC.
      notes: typeof release.body === 'string' ? release.body.slice(0, 1000) : ''
    })
  } catch (e) {
    console.warn('[update] check failed:', e?.message ?? e)
  }
}

function start ({ getMainWindow }) {
  _getMainWindow = getMainWindow
  _skipFile = _skippedPath()

  ipcMain.handle('update:open', (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url)
  })
  ipcMain.handle('update:skip', (_e, tag) => {
    if (typeof tag !== 'string' || !tag) return
    const list = _readSkipped()
    if (!list.includes(tag)) { list.push(tag); _writeSkipped(list) }
  })
  ipcMain.handle('update:check-now', () => _checkOnce())

  setTimeout(_checkOnce, INITIAL_DELAY_MS)
  _timer = setInterval(_checkOnce, CHECK_INTERVAL_MS)
}

function stop () {
  if (_timer) { clearInterval(_timer); _timer = null }
}

module.exports = { start, stop }
