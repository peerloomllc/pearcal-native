// Renderer-facing intercepts. These are bare-call methods that mobile's RN
// shell (app/index.tsx:446-481) handles before they reach the bare worklet.
// On Electron we intercept them in bare-bridge.js's ipcMain handler before
// calling into bare, and provide a desktop-appropriate implementation using
// standard Electron APIs.

const fs = require('fs')
const path = require('path')
const { shell, clipboard, dialog, app, session, Notification } = require('electron')

// Notifications — mirrors the renderer-side scheduling we did under Pear.
// Lives in main now so setTimeout survives a window-hide-to-tray.
const _reminders = new Map() // eventId → setTimeout handle[]

// setTimeout's max delay is 2^31-1 ms (~24.8 days). Anything longer
// overflows to 0 and fires immediately — a notorious JS gotcha that
// would flood the user with pseudo-instant "reminder" notifications
// for any event scheduled past that boundary. Skip rather than cap;
// the cold-launch rehydration loop in main/index.js re-runs daily and
// will pick the event up once it's within the safe window.
const MAX_TIMEOUT_DELAY = 0x7FFFFFFF

function _formatTime12h (t) {
  if (!t) return ''
  const [hStr, mStr] = String(t).split(':')
  const h = parseInt(hStr, 10)
  if (isNaN(h)) return t
  const ampm = h >= 12 ? 'pm' : 'am'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return h12 + ':' + (mStr ?? '00') + ampm
}

function _calcReminderFireTime (ev, reminder) {
  const [y, mo, d] = ev.date.split('-').map(Number)
  if (reminder === -1) return new Date(y, mo - 1, d, 9, 0, 0, 0).getTime()
  if (reminder === -2) return new Date(y, mo - 1, d - 1, 9, 0, 0, 0).getTime()
  let h = 9, m = 0
  if (!ev.allDay && ev.start) {
    const parts = ev.start.split(':').map(Number)
    h = parts[0]; m = parts[1]
  }
  const eventStartMs = new Date(y, mo - 1, d, h, m, 0, 0).getTime()
  return eventStartMs - reminder * 60 * 1000
}

const REMINDER_LABELS = {
  '5': '5 min', '10': '10 min', '15': '15 min', '30': '30 min',
  '60': '1 hr', '120': '2 hrs', '1440': '1 day',
  '-1': 'Morning of', '-2': 'Day before'
}

function _fireNotification (title, body, eventId, getMainWindow) {
  // The warn-on-unsupported path matters: when isSupported() returns false
  // it's almost always a signing-chain or first-run-registration issue, and
  // the only diagnostic the user has is a terminal launch.
  if (!Notification.isSupported()) {
    console.warn('[shell] Notification.isSupported() returned false — OS-level notifications unavailable')
    return
  }
  try {
    const n = new Notification({ title, body, tag: eventId })
    n.on('click', () => {
      const w = getMainWindow()
      if (w && !w.isDestroyed()) {
        w.show()
        w.focus()
      }
    })
    n.on('failed', (_e, error) => {
      console.error('[shell] notification "failed" event:', error)
    })
    n.show()
  } catch (e) {
    console.error('[shell] notification fire failed:', e?.message ?? e)
  }
}

function _cancelForEvent (eventId) {
  const handles = _reminders.get(eventId)
  if (handles) {
    for (const h of handles) clearTimeout(h)
    _reminders.delete(eventId)
  }
}

function _scheduleForEvent (ev, reminders, getMainWindow) {
  if (!ev || !ev.id) return
  _cancelForEvent(ev.id)
  const handles = []
  const list = Array.isArray(reminders) ? reminders : []
  const now = Date.now()
  for (let i = 0; i < Math.min(list.length, 3); i++) {
    const reminder = list[i]
    const fireAt = _calcReminderFireTime(ev, reminder)
    if (!fireAt || fireAt <= now) continue
    const delay = fireAt - now
    if (delay > MAX_TIMEOUT_DELAY) continue
    const label = REMINDER_LABELS[String(reminder)] ?? (reminder > 0 ? reminder + 'min' : '')
    const body = ev.allDay
      ? 'All day · ' + label
      : label + ' · ' + _formatTime12h(ev.start) + '–' + _formatTime12h(ev.end)
    handles.push(setTimeout(() => _fireNotification(ev.title, body, ev.id, getMainWindow), delay))
  }
  if (!ev.allDay && ev.start) {
    const [y, mo, d] = ev.date.split('-').map(Number)
    const [h, m] = ev.start.split(':').map(Number)
    const startFireAt = new Date(y, mo - 1, d, h, m, 0, 0).getTime()
    const delay = startFireAt - now
    if (startFireAt > now && delay <= MAX_TIMEOUT_DELAY) {
      const body = _formatTime12h(ev.start) + ' to ' + _formatTime12h(ev.end)
      handles.push(setTimeout(() => _fireNotification(ev.title + ' is starting now', body, ev.id, getMainWindow), delay))
    }
  }
  if (handles.length) _reminders.set(ev.id, handles)
}

// ── Top-K reconcile scheduling (the live path the shared UI actually uses) ────
// The UI calls `computeUpcomingReminders(K)` then `reconcileSchedule(triples)` on
// every save/edit/foreground (src/ui/main.jsx). Mobile services it natively
// (app/index.tsx:376); desktop was missing it, so live-scheduled reminders never
// armed until the daily rehydration. Triples arrive sorted ascending by fireAt.
// This is a single global batch (not per-event), so cancel is just clearing the
// array — which keeps the UI's frequent reconciles AND the main-process daily
// rehydration idempotent (each pass replaces the batch, never duplicates).
let _reconcileTimers = []
function _reconcileSchedule (triples, getMainWindow) {
  for (const h of _reconcileTimers) clearTimeout(h)
  _reconcileTimers = []
  const list = Array.isArray(triples) ? triples : []
  const now = Date.now()
  for (const t of list) {
    if (!t || !t.fireAt || t.fireAt <= now) continue
    const delay = t.fireAt - now
    if (delay > MAX_TIMEOUT_DELAY) continue // a later reconcile arms it as it nears
    _reconcileTimers.push(setTimeout(
      () => _fireNotification(t.title ?? '', t.body ?? '', t.eventId ?? '', getMainWindow),
      delay
    ))
  }
}

// ── Morning digest (bare emits scheduleMorningDigest/cancelMorningDigest) ─────
// items: [{ slot, fireAt, title, body }]. Mobile schedules these in
// app/index.tsx:834; desktop had no consumer so the digest never fired.
let _digestTimers = []
function _cancelMorningDigest () {
  for (const h of _digestTimers) clearTimeout(h)
  _digestTimers = []
}
function _scheduleMorningDigest (items, getMainWindow) {
  _cancelMorningDigest()
  const list = Array.isArray(items) ? items : []
  const now = Date.now()
  for (const it of list) {
    if (!it || !it.fireAt || it.fireAt <= now) continue
    const delay = it.fireAt - now
    if (delay > MAX_TIMEOUT_DELAY) continue
    _digestTimers.push(setTimeout(
      () => _fireNotification(it.title ?? 'Good morning', it.body ?? '', 'morning-digest', getMainWindow),
      delay
    ))
  }
}

// ── Sync-change notifications (bare emits syncNotify on remote calendar edits) ─
// Mobile coalesces a burst of remote ops into one notification (app/index.tsx:245);
// desktop had no consumer at all. Buffer + flush so a sync that applies many ops
// fires a single "Calendar updated" instead of a stack.
const SYNC_NOTIFY_COALESCE_MS = 2000
let _syncBuffer = []
let _syncTimer = null
function _handleSyncNotify (data, getMainWindow) {
  const title = data?.title ?? 'Calendar updated'
  const body = data?.body ?? ''
  // Immediate (rejoin requests, etc.) — fire it now with its OWN text, don't
  // fold it into a coalesced burst where its message would be lost.
  if (data?.immediate) {
    _fireNotification(title, body, 'sync', getMainWindow)
    return
  }
  // Ordinary remote edits — coalesce a burst so a sync that applies many ops
  // fires a single notification instead of a stack.
  _syncBuffer.push({ title, body })
  if (!_syncTimer) {
    _syncTimer = setTimeout(() => {
      _syncTimer = null
      const items = _syncBuffer; _syncBuffer = []
      if (!items.length) return
      if (items.length === 1) _fireNotification(items[0].title, items[0].body, 'sync', getMainWindow)
      else _fireNotification('Calendar updated', items.length + ' updates', 'sync', getMainWindow)
    }, SYNC_NOTIFY_COALESCE_MS)
  }
}

// Bare→main events the mobile RN shell consumes NATIVELY (not the WebView).
// Returns true when consumed, so bare-bridge doesn't also forward to the renderer
// (which has no listener for them — same as mobile).
function handleBareEvent (event, data, getMainWindow) {
  switch (event) {
    case 'scheduleMorningDigest': _scheduleMorningDigest(data, getMainWindow); return true
    case 'cancelMorningDigest': _cancelMorningDigest(); return true
    case 'syncNotify': _handleSyncNotify(data, getMainWindow); return true
    case 'appDataReset': _handleAppDataReset(data); return true
  }
  return false
}

// Finish a reset (TODO #118). The worklet has already wiped its data and
// re-init'd, but two things live outside it on desktop:
//
//   - Electron session storage (cookies, localStorage, IndexedDB) holds the
//     renderer's own state. Left behind, the previous user's UI state renders
//     over an empty database.
//   - In-memory reminder timers (_reminders) are setTimeout handles that fire
//     regardless of what the database now says. Relaunching drops them with
//     the process, which is exactly what we want.
//
// A relaunch, rather than a reload, because it is the one action that
// guarantees every one of those is gone - and unlike mobile there is no OS
// alarm to survive it.
function _handleAppDataReset (data) {
  const keepIdentity = !!(data && data.keepIdentity)
  console.log('[reset] wiping session storage and relaunching (keepIdentity=' + keepIdentity + ')')
  const finish = () => {
    app.relaunch()
    app.exit(0)
  }
  try {
    session.defaultSession.clearStorageData()
      .then(finish)
      // Relaunch even if the clear fails: coming back up on a wiped database
      // with stale cookies beats staying up on a half-reset app with no way
      // out but the process manager.
      .catch(e => { console.warn('[reset] clearStorageData failed:', e && e.message); finish() })
  } catch (e) {
    console.warn('[reset] clearStorageData threw:', e && e.message)
    finish()
  }
}

// Returns true if `method` was handled here (and the optional result), false
// if it should fall through to bare. The boolean lets bare-bridge keep its
// fast-path for everything we don't intercept.
async function tryHandle (method, args, { getMainWindow, sendToast, requestQuit, fireRendererEvent }) {
  switch (method) {
    case 'openURL':
    case 'openLightning':
      try { await shell.openExternal(args?.[0] ?? '') } catch (e) {}
      return { handled: true, result: null }

    case 'canOpenLightning':
      // Mobile uses an event back to the UI, not a return value. Mirror that.
      fireRendererEvent('canOpenLightning', true)
      return { handled: true, result: null }

    case 'nativeShare': {
      const [title, text] = args ?? []
      try {
        clipboard.writeText(String(text ?? ''))
        sendToast((title ? title + ' — c' : 'C') + 'opied to clipboard')
      } catch (e) {
        sendToast('Could not copy: ' + (e?.message ?? e))
      }
      return { handled: true, result: null }
    }

    case 'exportIcs':
      await _saveBlob(getMainWindow(), 'pearcal-events.ics', String(args?.[0] ?? ''))
      return { handled: true, result: null }

    case 'exportRecoveryPhrase':
      await _saveBlob(getMainWindow(), 'pearcal-recovery.txt', String(args?.[0] ?? ''))
      return { handled: true, result: null }

    case 'takePhoto': {
      // Mobile uses the device camera (PearCalCamera.capture); on desktop
      // there's no camera we want to wire up, so open the OS file picker
      // for an image and emit cameraResult with a data URL — same shape
      // app/index.tsx:745-754 produces, so the renderer's camera consumer
      // (App.jsx activeCameraConsumer) accepts it as-is.
      ;(async () => {
        try {
          const win = getMainWindow()
          const { canceled, filePaths } = await dialog.showOpenDialog(win, {
            properties: ['openFile'],
            filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }],
            buttonLabel: 'Choose Photo'
          })
          if (canceled || !filePaths?.[0]) return
          const filePath = filePaths[0]
          const buf = fs.readFileSync(filePath)
          const ext = path.extname(filePath).slice(1).toLowerCase()
          const mime = ext === 'jpg' ? 'image/jpeg' : 'image/' + ext
          const dataUrl = 'data:' + mime + ';base64,' + buf.toString('base64')
          fireRendererEvent('cameraResult', dataUrl)
        } catch (e) {
          console.error('[shell] takePhoto failed:', e?.message ?? e)
        }
      })()
      return { handled: true, result: null }
    }

    case 'haptic':
      return { handled: true, result: null }

    case 'exitApp':
      requestQuit()
      return { handled: true, result: null }

    case 'scheduleForEvent':
      _scheduleForEvent(args?.[0], args?.[1], getMainWindow)
      return { handled: true, result: null }

    case 'cancelForEvent':
      _cancelForEvent(args?.[0])
      return { handled: true, result: null }

    case 'reconcileSchedule':
      _reconcileSchedule(args?.[0], getMainWindow)
      return { handled: true, result: null }

    case 'restoreAll':
      // Phase E5 will walk bare's reminder list and re-schedule on cold
      // launch. For now this is a no-op — same as mobile (its native
      // AlarmManager state survives process restart on the OS side).
      return { handled: true, result: null }

    case 'desktopGetLaunchAtLogin':
      // Opt-in "Launch at startup" (TODO #103). Default off — desktop
      // reminders are in-memory setTimeout handles that die with the process,
      // so they only fire after reboot if the app is auto-started.
      try {
        return { handled: true, result: _getLaunchAtLogin() }
      } catch (e) {
        return { handled: true, result: false }
      }

    case 'desktopSetLaunchAtLogin':
      try {
        return { handled: true, result: _setLaunchAtLogin(!!args?.[0]) }
      } catch (e) {
        console.error('[shell] setLaunchAtLogin failed:', e?.message ?? e)
        return { handled: true, result: false }
      }
  }
  return { handled: false }
}

// ── Launch-at-startup ───────────────────────────────────────────────────────
// macOS/Windows have a working app.{get,set}LoginItemSettings (verified). On
// Linux those are no-ops (the API is macOS/Windows only), so we manage a
// freedesktop autostart .desktop file by hand. Both helpers return the actual
// post-write state so the renderer toggle reflects truth.

function _linuxAutostartFile () {
  const cfg = process.env.XDG_CONFIG_HOME || path.join(require('os').homedir(), '.config')
  return path.join(cfg, 'autostart', 'pearcal.desktop')
}

// Resolve the stable executable to relaunch at login. For an AppImage,
// process.execPath is an ephemeral /tmp/.mount_* path that won't exist next
// login — $APPIMAGE is the real .AppImage location. For .deb/.rpm installs
// (and on mac/win) execPath is already stable and $APPIMAGE is undefined.
function _autostartExec () {
  const exe = process.env.APPIMAGE || process.execPath
  return /\s/.test(exe) ? '"' + exe + '"' : exe
}

function _getLaunchAtLogin () {
  if (process.platform === 'linux') {
    try { fs.accessSync(_linuxAutostartFile()); return true } catch (_) { return false }
  }
  try { return !!app.getLoginItemSettings().openAtLogin } catch (_) { return false }
}

function _setLaunchAtLogin (enable) {
  if (process.platform === 'linux') {
    const file = _linuxAutostartFile()
    if (!enable) {
      try { fs.rmSync(file, { force: true }) } catch (_) {}
      return false
    }
    const entry = [
      '[Desktop Entry]',
      'Type=Application',
      'Name=PearCal',
      'Exec=' + _autostartExec(),
      'Icon=pearcal',
      'Terminal=false',
      'X-GNOME-Autostart-enabled=true',
      ''
    ].join('\n')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, entry)
    return true
  }
  // macOS / Windows: openAsHidden starts minimized to the tray on login
  // (macOS), matching the existing close-to-tray behavior.
  app.setLoginItemSettings({
    openAtLogin: enable,
    openAsHidden: enable,
    path: process.env.APPIMAGE || process.execPath
  })
  try { return !!app.getLoginItemSettings().openAtLogin } catch (_) { return enable }
}

async function _saveBlob (parentWindow, defaultName, content) {
  try {
    const { canceled, filePath } = await dialog.showSaveDialog(parentWindow, {
      defaultPath: defaultName,
      buttonLabel: 'Save'
    })
    if (canceled || !filePath) return
    fs.writeFileSync(filePath, content)
  } catch (e) {
    console.error('[shell] save blob failed:', e?.message ?? e)
  }
}

// Cold-launch rehydration entry point. main/index.js walks the bare DB after
// init and calls this per event with persisted reminders — without it, the
// in-memory _reminders Map starts empty on every restart and previously
// scheduled reminders silently never fire. (Mobile's AlarmManager /
// UNNotificationCenter live in OS state and survive process restart for
// free; setTimeout in the Electron main process does not.)
function scheduleForEvent (ev, reminders, getMainWindow) {
  _scheduleForEvent(ev, reminders, getMainWindow)
}

// Cold-launch / daily rehydration entry point (main/index.js). Feeds the same
// `computeUpcomingReminders(K)` triples the UI sends through the top-K reconcile,
// so a device that has run hidden in the tray for days still arms far-future
// firings as they cross into the setTimeout window — without duplicating the
// live UI reconcile (both drive the one _reconcileTimers batch).
function reconcileSchedule (triples, getMainWindow) {
  _reconcileSchedule(triples, getMainWindow)
}

module.exports = { tryHandle, scheduleForEvent, reconcileSchedule, handleBareEvent }
