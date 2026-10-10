// TODO #143 - does PearCal ever use hypercore's DefaultEncryption, the class
// with the broken `_reload`?
//
// The bug: `DefaultEncryption.deriveKeys` returns `{ blinding, block }` while
// `_reload` reads `keys.blockKey` / `keys.blindingKey`, so both land `undefined`
// and the core's cipher is destroyed from then on; it also never updates
// `this.compat`, so it re-fires on every subsequent block. Present in 11.26.0
// (the version we ship) through 11.35.0 at least. PearCircle hit it for real -
// three of five members' cores decrypted to noise permanently.
//
// PearCal turns out not to be exposed, because Autobase supplies its OWN
// encryption (`autobase/lib/encryption.js`: ViewEncryption / WriterEncryption,
// whose compat path reads the same property names deriveKeys actually returns)
// and PearCal never hands an `encryptionKey` to a Hypercore or to
// `store.get()` directly - the key only ever goes to the Autobase constructor.
// The blind seeder opens cores with no key at all, and the personal base is
// constructed without one.
//
// That is a property of how we wire things up, not a guarantee from upstream, so
// it can be lost by an innocent change - encrypting the local DB, or the
// personal base, or passing a key to a core directly would all make the broken
// class live again, silently. Hence this probe: run it after any hypercore or
// autobase bump, or after touching how cores are opened.
//
// It instruments the class's PROTOTYPE (which every instance shares, whichever
// module reference constructed it), then drives a real encrypted group through a
// real worklet and reports whether the class did any work.
//
// Usage:  node tools/encryption-usage-probe.js
//   Requires electron/vendor to be current: node electron/scripts/prepack.js

const fs = require('fs')
const os = require('os')
const path = require('path')

const REPO = path.join(__dirname, '..')
const Hypercore = require(path.join(REPO, 'node_modules/hypercore'))

// ── instrument before anything opens a core ──────────────────────────────
const Enc = Hypercore.DefaultEncryption
const stats = { reloads: 0, encrypts: 0, decrypts: 0 }
const origReload = Enc.prototype._reload
const origEncrypt = Enc.prototype.encrypt
const origDecrypt = Enc.prototype.decrypt
Enc.prototype._reload = function (core) {
  stats.reloads++
  console.log('!! DefaultEncryption._reload fired - this is the bug, the cipher is now broken')
  return origReload.call(this, core)
}
Enc.prototype.encrypt = function (...a) { stats.encrypts++; return origEncrypt.apply(this, a) }
Enc.prototype.decrypt = function (...a) { stats.decrypts++; return origDecrypt.apply(this, a) }

// Also record the contract mismatch itself, so the probe reports whether the
// upstream bug is still present in the installed version rather than assuming.
function reloadIsBroken () {
  const b4a = require(path.join(REPO, 'node_modules/b4a'))
  const keys = Enc.deriveKeys(b4a.alloc(32, 1), b4a.alloc(32, 2), { block: false, compat: false })
  return keys.blockKey === undefined || keys.blindingKey === undefined
}

// ── drive a real worklet ─────────────────────────────────────────────────
const { createBareKitShim } = require(path.join(REPO, 'electron/src/main/barekit-shim.js'))
const { tmpDir } = require('../test/helpers/tmpdir')
const shim = createBareKitShim()
const dataDir = tmpDir('pearcal-encprobe-')
const mnemonicFile = path.join(dataDir, 'mnemonic.txt')

function native (method, args) {
  switch (method) {
    case 'hasMnemonic': return fs.existsSync(mnemonicFile)
    case 'getMnemonic': return fs.existsSync(mnemonicFile) ? fs.readFileSync(mnemonicFile, 'utf8') : null
    case 'setMnemonic': fs.writeFileSync(mnemonicFile, args[0]); return true
    case 'getBackupStatus': return { enabled: false }
    default: return null
  }
}

let buf = '', nextId = 1, ready = false
const pending = new Map()
const waiters = []
shim.onBareOut(chunk => {
  buf += chunk.toString()
  const lines = buf.split('\n'); buf = lines.pop()
  for (const line of lines) {
    if (!line.trim()) continue
    let m; try { m = JSON.parse(line) } catch { continue }
    if (m.type === 'nativeRequest') {
      shim.sendToBare(Buffer.from(JSON.stringify({
        type: 'nativeResponse', nativeId: m.nativeId, result: native(m.method, m.args || []),
      }) + '\n'))
    } else if (m.type === 'response') {
      const p = pending.get(m.id)
      if (p) { pending.delete(m.id); m.error ? p.reject(new Error(m.error)) : p.resolve(m.result) }
    } else if (m.type === 'event' && m.event === 'ready') {
      ready = true; waiters.splice(0).forEach(f => f())
    }
  }
})

require(path.join(REPO, 'electron/vendor/src/bare.js'))
shim.sendToBare(Buffer.from(JSON.stringify({ method: 'init', dataDir, platform: 'desktop' }) + '\n'))

const call = (method, ...args) => {
  const id = nextId++
  shim.sendToBare(Buffer.from(JSON.stringify({ id, method, args }) + '\n'))
  return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }))
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main () {
  console.log('installed hypercore: ' + require(path.join(REPO, 'node_modules/hypercore/package.json')).version)
  console.log('upstream _reload still broken: ' + reloadIsBroken())

  if (!ready) await new Promise(r => waiters.push(r))
  await call('updateProfile', { name: 'EncProbe' })
  const g = await call('createGroup', 'EncProbeGroup', {})
  if (!g?.encryptionKey) throw new Error('group came back with no encryption key - probe is meaningless')
  console.log('created encrypted group ' + g.id)

  // Write through the group so both the writer core and the view do real crypto,
  // then read back so the decrypt path runs too.
  for (let i = 0; i < 3; i++) {
    await call('putEvent:sync', g.id, {
      id: 'probe-' + i, date: '2026-08-0' + (i + 1), title: 'Probe ' + i, groups: [g.id],
    })
  }
  await sleep(3000)
  const events = await call('listEvents')
  console.log('events written and read back: ' + events.length)

  console.log('\nDefaultEncryption usage: ' + JSON.stringify(stats))
  const used = stats.encrypts > 0 || stats.decrypts > 0 || stats.reloads > 0
  console.log(used
    ? 'REACHABLE - hypercore DefaultEncryption is in use, so the broken _reload can fire. Port PearCircle\'s patch (pearcircle/src/lib/hypercoreEncryptionPatch.js).'
    : 'UNREACHABLE - no DefaultEncryption instance did any work; Autobase\'s own encryption handled everything.')
  process.exit(used ? 1 : 0)
}

main().catch(e => { console.error('PROBE ERROR:', e); process.exit(2) })
