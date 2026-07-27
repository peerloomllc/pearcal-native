// Handlers for the bare-side `nativeRequest` IPC. On mobile these live in
// app/index.tsx, backed by expo-secure-store. On Electron we use safeStorage
// (OS keyring: libsecret on Linux, Keychain on Mac, DPAPI on Win).
//
// Seed storage only. The seed is an internal identity seed - profile.id,
// group.ownerId, writer proofs and device pairing all derive from it - and is
// never shown, exported or backed up to any cloud (removed 2026-07-27).

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
  deleteMnemonic () {
    // Full reset (TODO #118). There is no platform backup on desktop, so the
    // single encrypted file IS the identity - unlink it and the next boot mints
    // a new one. `force` so an already-absent file is a success, matching the
    // mobile handler and keeping a repeat reset idempotent.
    fs.rmSync(mnemonicPath(), { force: true })
    if (fs.existsSync(mnemonicPath())) {
      throw new Error('the recovery phrase file could not be removed')
    }
    return true
  }
}

async function dispatchNativeRequest (method, args) {
  const handler = handlers[method]
  if (!handler) throw new Error('Unknown native request: ' + method)
  return handler(args)
}

module.exports = { dispatchNativeRequest }
