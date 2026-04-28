// JSON-newline framing between Electron's ipcMain and the BareKit shim.
//
// Renderer → bare:
//   ipcRenderer.invoke('bare-call', { method, args })  (preload)
//     → ipcMain.handle('bare-call', …)                  (here)
//     → callBare(method, args)                          (here)
//     → sendToBare({id, method, args})                  (line into shim)
//     → bare.js processes, eventually emits {type:'response', id, result|error}
//
// Bare → renderer (events only):
//   bare.js emits {type:'event', event, data}
//     → shim.onBareOut line handler                     (here)
//     → mainWindow.webContents.send('bare-event', msg)  (renderer's preload listens)

const { ipcMain } = require('electron')
const { dispatchNativeRequest } = require('./native-handlers')

function installBridge ({ shim, getMainWindow }) {
  const pendingCalls = new Map()  // id → { resolve, reject }
  let nextId = 1
  const bufferedEvents = []       // events emitted before renderer has loaded

  function sendToBare (msg) {
    shim.sendToBare(Buffer.from(JSON.stringify(msg) + '\n'))
  }

  function callBare (method, args) {
    return new Promise((resolve, reject) => {
      const id = nextId++
      pendingCalls.set(id, { resolve, reject })
      sendToBare({ id, method, args: args || [] })
    })
  }

  function flushBufferedEvents () {
    const win = getMainWindow()
    if (!win || win.isDestroyed()) return
    while (bufferedEvents.length) {
      win.webContents.send('bare-event', bufferedEvents.shift())
    }
  }

  shim.onBareOut((buf) => {
    const text = buf.toString()
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let msg
      try { msg = JSON.parse(line) } catch (e) { continue }

      if (msg.type === 'response' && msg.id != null) {
        const pending = pendingCalls.get(msg.id)
        if (pending) {
          pendingCalls.delete(msg.id)
          if (msg.error) pending.reject(new Error(msg.error))
          else pending.resolve(msg.result)
        }
        continue
      }

      if (msg.type === 'event') {
        const win = getMainWindow()
        if (win && !win.isDestroyed()) {
          win.webContents.send('bare-event', msg)
        } else {
          bufferedEvents.push(msg)
        }
        continue
      }

      if (msg.type === 'nativeRequest' && msg.nativeId != null) {
        // bare→shell calls (mnemonic storage, backup status, etc.). Bare
        // calls these from ensureIdentity() during init, so this MUST work
        // before _dbReady flips, or the renderer's getProfile() never
        // resolves and the UI sticks at "Loading PearCal…".
        dispatchNativeRequest(msg.method, msg.args).then(
          (result) => sendToBare({ type: 'nativeResponse', nativeId: msg.nativeId, result }),
          (err) => sendToBare({ type: 'nativeResponse', nativeId: msg.nativeId, error: err?.message ?? String(err) })
        )
        continue
      }
    }
  })

  ipcMain.handle('bare-call', async (_event, { method, args }) => {
    return callBare(method, args)
  })

  return { sendToBare, callBare, flushBufferedEvents }
}

module.exports = { installBridge }
