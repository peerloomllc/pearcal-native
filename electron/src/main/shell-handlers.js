// Renderer-facing intercepts. These are bare-call methods that mobile's RN
// shell (app/index.tsx:446-481) handles before they reach the bare worklet.
// On Electron we intercept them in bare-bridge.js's ipcMain handler before
// calling into bare, and provide a desktop-appropriate implementation using
// standard Electron APIs.

const fs = require('fs')
const path = require('path')
const { shell, clipboard, dialog, app, Notification } = require('electron')

// Notifications — mirrors the renderer-side scheduling we did under Pear.
// Lives in main now so setTimeout survives a window-hide-to-tray.
const _reminders = new Map() // eventId → setTimeout handle[]

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
  if (!Notification.isSupported()) return
  try {
    const n = new Notification({ title, body, tag: eventId })
    n.on('click', () => {
      const w = getMainWindow()
      if (w && !w.isDestroyed()) {
        w.show()
        w.focus()
      }
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
  for (let i = 0; i < Math.min(list.length, 3); i++) {
    const reminder = list[i]
    const fireAt = _calcReminderFireTime(ev, reminder)
    if (!fireAt || fireAt <= Date.now()) continue
    const label = REMINDER_LABELS[String(reminder)] ?? (reminder > 0 ? reminder + 'min' : '')
    const body = ev.allDay
      ? 'All day · ' + label
      : label + ' · ' + _formatTime12h(ev.start) + '–' + _formatTime12h(ev.end)
    handles.push(setTimeout(() => _fireNotification(ev.title, body, ev.id, getMainWindow), fireAt - Date.now()))
  }
  if (!ev.allDay && ev.start) {
    const [y, mo, d] = ev.date.split('-').map(Number)
    const [h, m] = ev.start.split(':').map(Number)
    const startFireAt = new Date(y, mo - 1, d, h, m, 0, 0).getTime()
    if (startFireAt > Date.now()) {
      const body = _formatTime12h(ev.start) + ' to ' + _formatTime12h(ev.end)
      handles.push(setTimeout(() => _fireNotification(ev.title + ' is starting now', body, ev.id, getMainWindow), startFireAt - Date.now()))
    }
  }
  if (handles.length) _reminders.set(ev.id, handles)
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

    case 'restoreAll':
      // Phase E5 will walk bare's reminder list and re-schedule on cold
      // launch. For now this is a no-op — same as mobile (its native
      // AlarmManager state survives process restart on the OS side).
      return { handled: true, result: null }
  }
  return { handled: false }
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

module.exports = { tryHandle }
