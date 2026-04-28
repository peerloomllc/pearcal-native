// Handlers for the bare-side `nativeRequest` IPC. On mobile these live in
// app/index.tsx and are backed by expo-secure-store + Google Drive / iCloud
// backup. On Electron we use safeStorage (OS keyring: libsecret on Linux,
// Keychain on Mac, DPAPI on Win) for the mnemonic and stub backup as
// "available: false" until we wire a desktop-equivalent backup story.

const fs = require('fs')
const path = require('path')
const { app, safeStorage } = require('electron')

function mnemonicPath () {
  return path.join(app.getPath('userData'), 'mnemonic.bin')
}

function readMnemonic () {
  const p = mnemonicPath()
  if (!fs.existsSync(p)) return null
  const enc = fs.readFileSync(p)
  if (!safeStorage.isEncryptionAvailable()) {
    // Plaintext fallback when no OS keyring is present (rare on dev Linux
    // boxes without libsecret installed). The file lives in userData,
    // permissions match the Electron app conventions.
    return enc.toString('utf8')
  }
  try {
    return safeStorage.decryptString(enc)
  } catch (e) {
    console.error('[native] mnemonic decrypt failed:', e?.message ?? e)
    return null
  }
}

function writeMnemonic (value) {
  const p = mnemonicPath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  if (!safeStorage.isEncryptionAvailable()) {
    fs.writeFileSync(p, String(value), { encoding: 'utf8', mode: 0o600 })
    return
  }
  fs.writeFileSync(p, safeStorage.encryptString(String(value)), { mode: 0o600 })
}

const handlers = {
  hasMnemonic () {
    return fs.existsSync(mnemonicPath())
  },
  getMnemonic () {
    return readMnemonic()
  },
  setMnemonic (args) {
    const value = args?.[0]
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error('setMnemonic: value must be a non-empty string')
    }
    writeMnemonic(value)
    return true
  },
  // No platform backup story yet on desktop — surfaces in the UI as
  // "Backup not available" which matches reality (no Google Drive / iCloud
  // hookup). Phase E5 (or later) can revisit if a desktop backup target
  // emerges (cross-device pairing already provides a recovery path).
  getBackupStatus () {
    return {
      local: fs.existsSync(mnemonicPath()),
      platform: null,
      platformSynced: false,
      enabled: false,
      error: null
    }
  },
  setBackupEnabled () {
    return true
  }
}

async function dispatchNativeRequest (method, args) {
  const handler = handlers[method]
  if (!handler) throw new Error('Unknown native request: ' + method)
  return handler(args)
}

module.exports = { dispatchNativeRequest }
