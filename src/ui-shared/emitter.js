// Singleton event emitter for P2P-sync → UI updates. The host's
// IPC bridge translates window CustomEvents into emit() calls, the
// renderer subscribes via on()/off(). Shared across mobile + desktop
// so both renderers consume the same event stream from the same
// dispatcher instance.
class Emitter {
  constructor () { this._h = {} }
  on  (e, fn) { (this._h[e] ??= []).push(fn) }
  off (e, fn) { this._h[e] = (this._h[e] ?? []).filter(f => f !== fn) }
  emit (e, ...a) { (this._h[e] ?? []).forEach(fn => fn(...a)) }
}
export const emitter = new Emitter()
