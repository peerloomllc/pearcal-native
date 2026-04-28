// Preload — wires the React UI's mobile WebView IPC contract to Electron's
// ipcRenderer. The same src/ui/main.jsx that the mobile shell uses runs
// unchanged here: it sees window.ReactNativeWebView (its postMessage path)
// pre-installed, takes that branch, and never knows it's on Electron.
//
// nodeIntegration is OFF and contextIsolation is OFF (see main/index.js).
// That combo lets us set window.* directly from the preload — the renderer
// inherits them — while keeping require() out of the UI bundle.

const { ipcRenderer } = require('electron')

window.ReactNativeWebView = {
  postMessage (jsonStr) {
    let msg
    try { msg = JSON.parse(jsonStr) } catch (e) { return }
    const { id, method, args } = msg
    ipcRenderer.invoke('bare-call', { method, args }).then(
      (result) => {
        if (typeof window.__pearResponse === 'function') {
          window.__pearResponse({ id, result })
        }
      },
      (err) => {
        if (typeof window.__pearResponse === 'function') {
          window.__pearResponse({ id, error: err?.message ?? String(err) })
        }
      }
    )
  }
}

// Forward bare-emitted events to the UI. main.jsx wraps __pearEvent to
// re-dispatch as CustomEvents on window, so App.jsx's pear:* listeners fire
// the same way they do on mobile.
ipcRenderer.on('bare-event', (_event, msg) => {
  if (msg && msg.event && typeof window.__pearEvent === 'function') {
    window.__pearEvent(msg.event, msg.data)
  }
})
