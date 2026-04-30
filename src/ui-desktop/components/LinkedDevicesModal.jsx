// Linked-devices modal — manage same-user multi-device identity.
//
// Two pairing roles, both reachable from this modal:
//   - host:   `db.startPairing()` → generates a pearcal://pair URL we
//             show with Copy. Bare swarms on the topic and waits for a
//             secondary; emits pairingCompleted when done.
//   - guest:  `db.consumePairLink(url)` redeems a pasted link. Bare
//             completes the handshake, installs the primary's mnemonic,
//             and opens the personal base. Resolves on completion or
//             rejects with reason.
//
// The Pair UX is inline in this modal rather than a sub-modal because
// it's a continuous flow (start → copy → wait → complete) and modals
// stacking modals feels heavy on desktop.

import { useEffect, useState } from 'react'
import { emitter } from '../../ui-shared/index.js'
import { QRCodeCanvas } from './QRCode.jsx'

function formatDate (ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function LinkedDevicesModal ({ tokens, db, profile, onClose }) {
  const [devices,    setDevices]    = useState([])
  const [loading,    setLoading]    = useState(true)
  const [myNickname, setMyNickname] = useState('')
  const [nickSaved,  setNickSaved]  = useState(false)
  const [nickSaving, setNickSaving] = useState(false)
  // Personal sync is required before host-pair, nickname write, and
  // remove-device. We call enablePersonalSync() per-action rather than
  // on mount because guest-pair (consumePairLink) MUST NOT have a
  // pre-existing in-memory personalBase — _handlePairGranted's
  // ensurePersonalBase short-circuits if it's already set, leaving the
  // pair adopting the primary's bootstrap-key in persistence but the
  // wrong base in memory. See OnboardingScreen for the matching note.
  const [personalErr, setPersonalErr] = useState('')
  async function ensurePersonal () {
    if (!db) throw new Error('db not ready')
    await db.enablePersonalSync()
  }

  // Pairing state — exactly one role active at a time
  const [pairMode,   setPairMode]   = useState(null)    // null | 'host' | 'guest'
  const [pairUrl,    setPairUrl]    = useState('')
  const [pairExpiry, setPairExpiry] = useState(0)
  const [pairCopied, setPairCopied] = useState(false)
  const [pairBusy,   setPairBusy]   = useState(false)
  const [pairErr,    setPairErr]    = useState('')
  const [pairSuccess, setPairSuccess] = useState('')
  const [pasteUrl,   setPasteUrl]   = useState('')
  const [now,        setNow]        = useState(Date.now())

  // Tick once a second so the host-mode countdown stays live.
  useEffect(() => {
    if (pairMode !== 'host' || !pairExpiry) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [pairMode, pairExpiry])

  async function refresh () {
    if (!db) return
    setLoading(true)
    try {
      const list = await db.listLinkedDevices()
      setDevices(list ?? [])
      const me = (list ?? []).find(d => d.isThisDevice)
      setMyNickname(me?.nickname ?? '')
    } catch {
      setDevices([])
    }
    setLoading(false)
  }

  // listLinkedDevices reads from the local DB keyspace and tolerates a
  // missing personal base (returns just the "this device" synthetic row).
  // Don't call enablePersonalSync here — see the note above.
  useEffect(() => { refresh() }, [db])

  // Esc routes to onClose
  useEffect(() => {
    function onKey (e) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Pairing event subscriptions — fire from bare's _emitPair / IPC bridge.
  useEffect(() => {
    function onCompleted (data) {
      setPairBusy(false); setPairUrl(''); setPairExpiry(0); setPairMode(null); setPasteUrl('')
      const role = data?.role
      const groups = data?.groups
      const hint = role === 'secondary'
        ? (groups != null ? `${groups} group${groups === 1 ? '' : 's'} synced.` : 'Identity installed.')
        : 'New device joined.'
      setPairSuccess('✓ Pairing complete. ' + hint)
      setTimeout(() => setPairSuccess(''), 4000)
      // Refresh immediately, then again after a delay. personalBase
      // .activeWriters can populate late (autobase needs to confirm the
      // peer's hypercore has at least one block) so the immediate refresh
      // sometimes misses the new writer. The delayed second refresh picks
      // it up. Hand-tested: 3-5s is usually enough.
      refresh()
      setTimeout(refresh, 3000)
      setTimeout(refresh, 8000)
    }
    function onFailed (data) {
      setPairBusy(false)
      const reason = data?.reason ?? 'unknown'
      const message = data?.message ? ': ' + data.message : ''
      setPairErr('Pairing failed (' + reason + ')' + message)
    }
    function onExpired () {
      setPairBusy(false); setPairUrl(''); setPairExpiry(0); setPairMode(null)
      setPairErr('Pair link expired before the other device used it.')
    }
    function onLinkedDevicesChanged () { refresh() }
    emitter.on('pairingCompleted', onCompleted)
    emitter.on('pairingFailed',    onFailed)
    emitter.on('pairingExpired',   onExpired)
    emitter.on('linkedDevicesChanged', onLinkedDevicesChanged)
    return () => {
      emitter.off('pairingCompleted', onCompleted)
      emitter.off('pairingFailed',    onFailed)
      emitter.off('pairingExpired',   onExpired)
      emitter.off('linkedDevicesChanged', onLinkedDevicesChanged)
    }
  }, [])

  async function saveMyNickname () {
    setNickSaving(true)
    try {
      await ensurePersonal()
      await db.setDeviceNickname(myNickname.trim())
      setNickSaved(true)
      setTimeout(() => setNickSaved(false), 1500)
      refresh()
    } catch (e) {
      alert('Could not save nickname: ' + (e?.message ?? 'unknown error'))
    }
    setNickSaving(false)
  }

  async function removeDevice (writerKey) {
    // Bare's removeDeviceFromList only deletes the deviceMeta row — the
    // device's writer authorization on the personal autobase stays intact,
    // so it keeps syncing in the background. Be explicit about that.
    const ok = confirm('Hide this device from your linked-devices list on every paired device?\n\n'
      + 'This does not revoke its pairing — it will still sync in the background. '
      + 'To fully unpair it, also wipe PearCal\'s data on that device.')
    if (!ok) return
    try {
      await ensurePersonal()
      await db.removeDeviceFromList(writerKey)
      refresh()
    } catch (e) {
      alert('Could not hide device: ' + (e?.message ?? 'unknown error'))
    }
  }

  async function startHostPairing () {
    setPairMode('host'); setPairBusy(true); setPairErr(''); setPairSuccess('')
    try {
      await ensurePersonal()
      const session = await db.startPairing()
      if (!session?.url) throw new Error('startPairing returned no URL')
      setPairUrl(session.url)
      setPairExpiry(session.expiresAt ?? 0)
    } catch (e) {
      setPairMode(null); setPairBusy(false)
      setPairErr('Could not start pairing: ' + (e?.message ?? 'unknown error'))
    }
  }

  async function cancelPairing () {
    try { await db.cancelPairing() } catch {}
    setPairMode(null); setPairUrl(''); setPairExpiry(0)
    setPairBusy(false); setPairErr(''); setPasteUrl('')
  }

  async function copyPairUrl () {
    try { await navigator.clipboard?.writeText?.(pairUrl) } catch {}
    setPairCopied(true)
    setTimeout(() => setPairCopied(false), 1500)
  }

  async function startGuestPairing () {
    const url = pasteUrl.trim()
    if (!url) { setPairErr('Paste a pairing link first.'); return }
    setPairMode('guest'); setPairBusy(true); setPairErr(''); setPairSuccess('')
    try {
      // DO NOT enablePersonalSync first as a secondary. The pair flow's
      // _handlePairGranted overwrites personalMeta:bootstrap with the
      // primary's key and calls ensurePersonalBase(), but that short-
      // circuits if personalBase is already set, leaving the in-memory
      // base pointing at the wrong (local) bootstrap. See the matching
      // note in OnboardingScreen.handlePairConsume.
      await db.consumePairLink(url)
    } catch (e) {
      const msg = e?.message ?? 'unknown error'
      setPairMode(null); setPairBusy(false)
      setPairErr('Could not redeem pair link: ' + msg.replace(/^consumePairLink: /, ''))
    }
  }

  const inputBase = {
    width: '100%', padding: '7px 10px', borderRadius: 5,
    fontSize: 13, fontWeight: 400,
    border: `1px solid ${tokens.border}`, background: tokens.bg, color: tokens.text,
    fontFamily: tokens.font, boxSizing: 'border-box', outline: 'none',
  }
  const label = {
    fontSize: 11, fontWeight: 600, color: tokens.muted,
    textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 7,
  }
  const btnBase = {
    padding: '7px 14px', fontSize: 13, fontWeight: 500,
    borderRadius: 5, cursor: 'pointer',
    fontFamily: tokens.font, border: `1px solid ${tokens.border}`,
    background: tokens.bg, color: tokens.text,
  }

  const otherDevices = devices.filter(d => !d.isThisDevice)
  const expiresIn = pairExpiry ? Math.max(0, Math.ceil((pairExpiry - now) / 1000)) : 0

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: tokens.surface, border: `1px solid ${tokens.border}`,
        borderRadius: 10, padding: 20, width: 500, maxWidth: '92vw',
        maxHeight: '88vh', overflowY: 'auto',
        boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
        fontFamily: tokens.font,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
          <div style={{ fontSize: 14, fontWeight: 600, flex: 1 }}>Linked Devices</div>
          <button onClick={onClose} style={{
            ...btnBase, padding: '4px 10px', fontSize: 14,
            background: 'transparent', border: 'none',
          }}>✕</button>
        </div>

        <div style={{ fontSize: 12, color: tokens.muted, lineHeight: 1.5, marginBottom: 14 }}>
          Devices paired here share your identity. Calendars, profile, and groups stay in sync between them.
        </div>

        {personalErr && (
          <div style={{
            fontSize: 12, color: '#C0504A', marginBottom: 12,
            padding: '7px 10px', borderRadius: 5,
            background: tokens.bg, border: `1px solid #C0504A`,
          }}>
            Could not enable personal sync: {personalErr}. Pairing and nicknames may not work until this is resolved.
          </div>
        )}

        <div style={{ marginBottom: 16 }}>
          <div style={label}>This device</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input value={myNickname}
                   onChange={e => { setMyNickname(e.target.value); setNickSaved(false) }}
                   placeholder="Nickname (e.g. Desktop, Laptop)"
                   style={{ ...inputBase, flex: 1 }} />
            <button onClick={saveMyNickname}
                    disabled={nickSaving}
                    style={{ ...btnBase, minWidth: 80, opacity: nickSaving ? 0.5 : 1 }}>
              {nickSaved ? '✓ Saved' : (nickSaving ? 'Saving…' : 'Save')}
            </button>
          </div>
        </div>

        <div style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7 }}>
            <div style={{ ...label, marginBottom: 0, flex: 1 }}>Other linked devices ({otherDevices.length})</div>
            <button onClick={refresh} disabled={loading}
                    title="Refresh device list"
                    style={{
                      ...btnBase, padding: '3px 9px', fontSize: 11,
                      opacity: loading ? 0.5 : 1,
                    }}>
              ↻ Refresh
            </button>
          </div>
          {loading ? (
            <div style={{ fontSize: 12, color: tokens.muted, padding: '8px 0' }}>Loading…</div>
          ) : otherDevices.length === 0 ? (
            <div style={{ fontSize: 12, color: tokens.muted, padding: '8px 0' }}>
              No other devices yet. Pair one below.
            </div>
          ) : (
            <div style={{
              border: `1px solid ${tokens.border}`, borderRadius: 6,
              background: tokens.bg, overflow: 'hidden',
            }}>
              {otherDevices.map(d => (
                <div key={d.writerKey} style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '8px 10px', borderBottom: `1px solid ${tokens.border}`,
                  fontSize: 13,
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {d.nickname?.trim() || (d.platform ? d.platform.charAt(0).toUpperCase() + d.platform.slice(1) : 'Unnamed device')}
                    </div>
                    <div style={{ fontSize: 11, color: tokens.muted, fontVariantNumeric: 'tabular-nums' }}>
                      Paired {formatDate(d.pairedAt)}
                    </div>
                  </div>
                  <button onClick={() => removeDevice(d.writerKey)}
                          title="Hide this device from the linked-devices list (does not unpair)"
                          style={{ ...btnBase, color: '#C0504A', borderColor: '#C0504A', padding: '4px 10px' }}>
                    Hide
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Pairing surface — host or guest. Both branches share the
            "stop pairing" + error handling state machine. */}
        <div style={{ marginBottom: 14 }}>
          <div style={label}>Pair a new device</div>

          {!pairMode && (
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={startHostPairing} style={{ ...btnBase, flex: 1 }}>
                Pair another device
              </button>
              <button onClick={() => { setPairMode('guest'); setPairErr('') }} style={{ ...btnBase, flex: 1 }}>
                Pair this device
              </button>
            </div>
          )}

          {pairMode === 'host' && (
            <div style={{
              padding: '10px 12px', borderRadius: 6,
              background: tokens.bg, border: `1px solid ${tokens.border}`,
            }}>
              <div style={{ fontSize: 12, color: tokens.text, lineHeight: 1.5, marginBottom: 8 }}>
                {pairBusy && !pairUrl
                  ? 'Generating pairing link…'
                  : 'On the other device, scan this QR code, or open PearCal → Linked Devices and paste the link below. Link expires in '
                    + expiresIn + ' second' + (expiresIn === 1 ? '' : 's') + '.'}
              </div>
              {pairUrl && (
                <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8 }}>
                  <QRCodeCanvas value={pairUrl} size={200} tokens={tokens} />
                </div>
              )}
              {pairUrl && (
                <textarea readOnly value={pairUrl} rows={3}
                          onClick={e => e.target.select()}
                          style={{
                            ...inputBase, fontFamily: 'ui-monospace, monospace',
                            fontSize: 11, resize: 'none', marginBottom: 8,
                          }} />
              )}
              <div style={{ display: 'flex', gap: 6 }}>
                {pairUrl && (
                  <button onClick={copyPairUrl} style={{ ...btnBase, flex: 1 }}>
                    {pairCopied ? '✓ Copied' : 'Copy link'}
                  </button>
                )}
                <button onClick={cancelPairing} style={{ ...btnBase, flex: 1 }}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {pairMode === 'guest' && (
            <div style={{
              padding: '10px 12px', borderRadius: 6,
              background: tokens.bg, border: `1px solid ${tokens.border}`,
            }}>
              {!pairBusy ? (
                <>
                  <div style={{ fontSize: 12, color: tokens.text, lineHeight: 1.5, marginBottom: 8 }}>
                    Paste the pairing link generated by your other device. Keep the other device on its
                    "Pair another device" screen until this finishes.
                  </div>
                  <textarea
                    value={pasteUrl}
                    onChange={e => { setPasteUrl(e.target.value); setPairErr('') }}
                    placeholder="pearcal://pair?topic=…"
                    rows={3}
                    style={{
                      ...inputBase, fontFamily: 'ui-monospace, monospace',
                      fontSize: 11, resize: 'none', marginBottom: 8,
                    }} />
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={() => { setPairMode(null); setPasteUrl(''); setPairErr('') }}
                            style={{ ...btnBase, flex: 1 }}>
                      Cancel
                    </button>
                    <button onClick={startGuestPairing}
                            disabled={!pasteUrl.trim()}
                            style={{
                              ...btnBase, flex: 1,
                              background: tokens.accent, color: tokens.bg, borderColor: tokens.accent,
                              opacity: !pasteUrl.trim() ? 0.5 : 1,
                              cursor:  !pasteUrl.trim() ? 'default' : 'pointer',
                            }}>
                      Pair
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div style={{ fontSize: 12, color: tokens.text, lineHeight: 1.5, marginBottom: 8 }}>
                    Connecting to your other device over the peer-to-peer network. This usually takes a few
                    seconds. Both devices need to be online with PearCal open. The pair link expires 15
                    minutes after it was generated.
                  </div>
                  <div style={{
                    fontSize: 12, color: tokens.muted, fontStyle: 'italic',
                    padding: '8px 0', textAlign: 'center',
                  }}>
                    Pairing… (you can leave this open)
                  </div>
                  <button onClick={cancelPairing} style={{ ...btnBase, width: '100%' }}>
                    Cancel pairing
                  </button>
                </>
              )}
            </div>
          )}

          {pairErr && (
            <div style={{ fontSize: 12, color: '#C0504A', marginTop: 8 }}>{pairErr}</div>
          )}
          {pairSuccess && (
            <div style={{ fontSize: 12, color: '#5DBF8A', marginTop: 8 }}>{pairSuccess}</div>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 18 }}>
          <button onClick={onClose} style={{ ...btnBase, minWidth: 140 }}>Done</button>
        </div>
      </div>
    </div>
  )
}
