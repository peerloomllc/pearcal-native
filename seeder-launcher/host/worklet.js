const { spawn } = require('node:child_process')
const { EventEmitter } = require('node:events')

// Spawn the PearCal seed worklet and bridge JSON-newline IPC over the
// subprocess's stdin/stdout. Adapted from PearCircle's seeder-launcher (proven
// in production); the worklet contract is identical (src/seed.js speaks the same
// envelope over bare-process/node stdio).
//
// Lifecycle:
//   new Worklet({ barePath, bundleEntry, dataDir })
//   await wl.start()                       // spawns subprocess, sends init
//   await wl.call('seeder:status', {})     // round-trips an IPC
//   wl.on('event', ({ name, data }) => …)  // worklet-emitted events
//   wl.on('exit', ({code}) => …)           // subprocess died
//   wl.stop()
class Worklet extends EventEmitter {
  constructor ({ barePath, bundleEntry, dataDir, version = null, args = ['--seed'], onLog }) {
    super()
    this._barePath = barePath
    this._bundleEntry = bundleEntry
    this._dataDir = dataDir
    this._version = version
    this._args = args
    this._onLog = onLog || (() => {})
    this._proc = null
    this._buf = ''
    this._nextId = 1
    this._pending = new Map()
    this._ready = false
    this._readyP = null
  }

  start () {
    if (this._proc) return this._readyP
    const args = [this._bundleEntry, ...this._args]
    this._proc = spawn(this._barePath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    })
    this._proc.stdout.on('data', (chunk) => this._onStdout(chunk))
    this._proc.stderr.on('data', (chunk) => this._onLog('stderr', chunk.toString()))
    this._proc.on('exit', (code, signal) => {
      this._ready = false
      this._failPending(new Error(`worklet exited (code=${code} signal=${signal})`))
      this.emit('exit', { code, signal })
    })
    this._proc.on('error', (err) => { this._failPending(err); this.emit('error', err) })

    this._readyP = this.call('init', { mode: 'seed', dataDir: this._dataDir, version: this._version })
      .then((result) => { this._ready = true; this.emit('ready', result); return result })
    return this._readyP
  }

  call (method, args = {}, { timeoutMs = 15000 } = {}) {
    if (!this._proc) return Promise.reject(new Error('worklet not started'))
    const id = this._nextId++
    const line = JSON.stringify({ id, method, args }) + '\n'
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id)
        reject(new Error(`worklet ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this._pending.set(id, { resolve, reject, timer })
      this._proc.stdin.write(line)
    })
  }

  _onStdout (chunk) {
    this._buf += chunk.toString('utf8')
    let nl
    while ((nl = this._buf.indexOf('\n')) !== -1) {
      const line = this._buf.slice(0, nl)
      this._buf = this._buf.slice(nl + 1)
      if (!line.trim()) continue
      let msg
      try { msg = JSON.parse(line) } catch { this._onLog('worklet', line); continue }
      if (msg.event) { this.emit('event', { name: msg.event, data: msg.data }); continue }
      if (msg.id == null) { this._onLog('worklet', line); continue }
      const pending = this._pending.get(msg.id)
      if (!pending) continue
      this._pending.delete(msg.id)
      clearTimeout(pending.timer)
      if (msg.error) pending.reject(new Error(msg.error))
      else pending.resolve(msg.result)
    }
  }

  _failPending (err) {
    for (const { reject, timer } of this._pending.values()) { clearTimeout(timer); reject(err) }
    this._pending.clear()
  }

  isReady () { return this._ready }

  async stop () {
    if (!this._proc) return
    this._proc.stdin.end()
    return new Promise((resolve) => {
      const p = this._proc
      this._proc = null
      const t = setTimeout(() => { try { p.kill('SIGKILL') } catch {} resolve() }, 3000)
      p.once('exit', () => { clearTimeout(t); resolve() })
      try { p.kill('SIGTERM') } catch {}
    })
  }

  async restart () { await this.stop(); this._ready = false; return this.start() }
}

module.exports = { Worklet }
