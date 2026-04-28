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

// Toast channel — main sends short feedback strings (e.g. after nativeShare
// copies to clipboard). Render a transient bottom-center pill so the user
// gets the same feedback they'd get from a mobile share sheet pop.
ipcRenderer.on('toast', (_event, text) => {
  if (typeof text !== 'string') return
  const el = document.createElement('div')
  el.textContent = text
  el.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1e293b;color:#e2e8f0;padding:10px 18px;border-radius:10px;font:13px -apple-system,system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,0.4);z-index:99999;opacity:0;transition:opacity 180ms;pointer-events:none;'
  document.body.appendChild(el)
  requestAnimationFrame(() => { el.style.opacity = '1' })
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 220) }, 2200)
})
