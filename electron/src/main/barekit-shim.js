// Shims global.BareKit so the unmodified src/bare.js can run inside Electron's
// main process. Only BareKit.IPC.write / BareKit.IPC.on('data') are used by
// bare.js; both are mapped to an EventEmitter-backed pseudo-duplex so the host
// (Electron main) can pump IPC lines in and read them back out.
//
// Verbatim copy of pearguard/windows/src/backend/barekit-shim.js. Don't drift.

const { EventEmitter } = require('events')

function createBareKitShim () {
  const fromBare = new EventEmitter()
  const toBare = new EventEmitter()

  const ipc = {
    write (buf) { fromBare.emit('line', buf) },
    on (event, handler) {
      if (event !== 'data') return
      toBare.on('data', handler)
    }
  }

  global.BareKit = { IPC: ipc }
  global.Buffer = global.Buffer || require('buffer').Buffer

  return {
    ipc,
    onBareOut (handler) { fromBare.on('line', handler) },
    sendToBare (buf) { toBare.emit('data', buf) }
  }
}

module.exports = { createBareKitShim }
