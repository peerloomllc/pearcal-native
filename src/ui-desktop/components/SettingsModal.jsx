// Settings modal — display preferences (24h / week start), recovery
// phrase reveal + restore, linked devices, About. Mobile's settings
// tab also covers backup/blind-peer, holiday subscriptions, ICS
// import/export, and storage reclaim — deferred until users ask.
//
// updateProfile-routed prefs use the wrapper from App.jsx (db.updateProfile
// + optimistic setProfile) since bare's profileChanged event only fires
// on sibling-device sync, never on local writes.

import { useEffect, useState } from 'react'

const APP_VERSION = '0.0.1'  // Mirrors electron/package.json#version. Update in lockstep.

const WEEK_STARTS = [
  { value: 0, label: 'Sunday' },
  { value: 1, label: 'Monday' },
]

export function SettingsModal ({ tokens, profile, updateProfile, db, sync, onOpenLinkedDevices, onClose }) {
  const [phrase,   setPhrase]   = useState(null)         // null = hidden, '' = loading, '...' = revealed
  const [phraseErr, setPhraseErr] = useState('')
  const [phraseCopied, setPhraseCopied] = useState(false)
  // Mnemonic restore lives in bare (db.restoreMnemonic), but the mobile
  // app doesn't expose a settings-time restore yet — restore there only
  // runs during onboarding. Hide the desktop UI until parity lands.
  // Match the same locale-aware default the App uses so the toggle
  // reads "On" only when the user has explicitly chosen 24h.
  const localeUse24h = !new Intl.DateTimeFormat([], { hour: 'numeric' }).format(0).match(/am|pm/i)
  const [use24h,    setUse24h]    = useState(profile?.use24h    ?? localeUse24h)
  const [weekStart, setWeekStart] = useState(profile?.weekStart ?? 0)
  const [saving,    setSaving]    = useState(false)
  const [saved,     setSaved]     = useState(false)

  useEffect(() => {
    function onKey (e) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Save-on-change so the modal feels native — same pattern as macOS
  // System Settings. The "Saved" pill flashes for 1.5s after each write.
  async function persist (updates) {
    setSaving(true)
    try {
      await updateProfile(updates)
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    } catch (e) {
      alert('Could not save: ' + (e?.message ?? 'unknown error'))
    }
    setSaving(false)
  }

  async function revealPhrase () {
    if (phrase != null) { setPhrase(null); setPhraseErr(''); return }  // toggle hide
    setPhrase('')
    setPhraseErr('')
    try {
      const m = await db.revealMnemonic()
      setPhrase(m ?? '')
    } catch (e) {
      setPhrase(null)
      setPhraseErr(e?.message ?? 'Could not reveal recovery phrase')
    }
  }

  async function copyPhrase () {
    if (!phrase) return
    try { await navigator.clipboard?.writeText?.(phrase) } catch {}
    setPhraseCopied(true)
    setTimeout(() => setPhraseCopied(false), 1500)
  }

  function handleUse24hChange (next) {
    setUse24h(next)
    persist({ use24h: next })
  }
  function handleWeekStartChange (next) {
    setWeekStart(next)
    persist({ weekStart: next })
  }

  const label = {
    fontSize: 11, fontWeight: 600, color: tokens.muted,
    textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 7,
  }
  const row = {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '9px 0',
  }
  const btnBase = {
    padding: '7px 14px', fontSize: 13, fontWeight: 500,
    borderRadius: 5, cursor: 'pointer',
    fontFamily: tokens.font, border: `1px solid ${tokens.border}`,
    background: tokens.bg, color: tokens.text,
  }

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: tokens.surface, border: `1px solid ${tokens.border}`,
        borderRadius: 10, padding: 20, width: 460, maxWidth: '90vw',
        maxHeight: '85vh', overflowY: 'auto',
        boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
        fontFamily: tokens.font,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
          <div style={{ fontSize: 14, fontWeight: 600, flex: 1 }}>Settings</div>
          {saved && <div style={{ fontSize: 12, color: '#5DBF8A', marginRight: 10 }}>✓ Saved</div>}
          {saving && !saved && <div style={{ fontSize: 12, color: tokens.muted, marginRight: 10 }}>Saving…</div>}
          <button onClick={onClose} style={{
            ...btnBase, padding: '4px 10px', fontSize: 14,
            background: 'transparent', border: 'none',
          }}>✕</button>
        </div>

        <div style={{ marginBottom: 18 }}>
          <div style={label}>Display</div>
          <div style={row}>
            <div style={{ flex: 1, fontSize: 13 }}>24-hour time</div>
            <ToggleSwitch tokens={tokens} value={use24h} onChange={handleUse24hChange} />
          </div>
          <div style={row}>
            <div style={{ flex: 1, fontSize: 13 }}>Week starts on</div>
            <div style={{ display: 'flex', gap: 4 }}>
              {WEEK_STARTS.map(w => (
                <button key={w.value}
                  onClick={() => handleWeekStartChange(w.value)}
                  style={{
                    ...btnBase, padding: '4px 10px',
                    background: weekStart === w.value ? tokens.accent : tokens.bg,
                    color:      weekStart === w.value ? tokens.bg     : tokens.text,
                    borderColor: weekStart === w.value ? tokens.accent : tokens.border,
                  }}>
                  {w.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div style={{ marginBottom: 18 }}>
          <div style={label}>Recovery phrase</div>
          <div style={{ fontSize: 12, color: tokens.muted, lineHeight: 1.5, padding: '4px 0 8px' }}>
            Twelve words that recover your identity on a new device. Anyone with this phrase can impersonate you.
            Write it down somewhere safe; do not share it.
          </div>
          {phrase != null && phrase !== '' && (
            <div style={{
              padding: '10px 12px', borderRadius: 5,
              background: tokens.bg, border: `1px solid ${tokens.border}`,
              fontFamily: 'ui-monospace, monospace', fontSize: 13,
              lineHeight: 1.7, marginBottom: 8, userSelect: 'text',
            }}>{phrase}</div>
          )}
          {phraseErr && (
            <div style={{ fontSize: 12, color: '#C0504A', marginBottom: 8 }}>{phraseErr}</div>
          )}
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={revealPhrase}
                    disabled={phrase === ''}
                    style={{ ...btnBase, flex: 1, opacity: phrase === '' ? 0.5 : 1 }}>
              {phrase === ''      ? 'Loading…'
               : phrase != null   ? 'Hide phrase'
               :                    'Reveal phrase'}
            </button>
            {phrase && (
              <button onClick={copyPhrase} style={{ ...btnBase, flex: 1 }}>
                {phraseCopied ? '✓ Copied' : 'Copy phrase'}
              </button>
            )}
          </div>
        </div>

        {onOpenLinkedDevices && (
          <div style={{ marginBottom: 18 }}>
            <div style={label}>Linked devices</div>
            <div style={{ fontSize: 12, color: tokens.muted, lineHeight: 1.5, padding: '4px 0 8px' }}>
              Pair another phone or computer so the same calendar identity follows you across devices.
            </div>
            <button onClick={onOpenLinkedDevices} style={{ ...btnBase, width: '100%' }}>
              Manage linked devices
            </button>
          </div>
        )}

        <div style={{ marginBottom: 18 }}>
          <div style={label}>Help</div>
          <div style={{ fontSize: 12, color: tokens.muted, lineHeight: 1.5, padding: '4px 0 8px' }}>
            Walk through the calendar's main controls again — sidebar, view tabs, and event creation.
          </div>
          <button onClick={async () => {
              await updateProfile({ tourPending: true })
              onClose()
            }} style={{ ...btnBase, width: '100%' }}>
            Replay welcome tour
          </button>
        </div>

        <div style={{ marginBottom: 4 }}>
          <div style={label}>About</div>
          <div style={{ ...row, fontSize: 13, color: tokens.text }}>
            <div style={{ flex: 1 }}>PearCal Desktop</div>
            <div style={{ color: tokens.muted, fontVariantNumeric: 'tabular-nums' }}>v{APP_VERSION}</div>
          </div>
          <div style={{ fontSize: 12, color: tokens.muted, lineHeight: 1.5, padding: '4px 0 8px' }}>
            Decentralized calendar. Your data lives only on the devices in your groups.
            No servers, no accounts, no data collection.
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => sync?.openURL?.('https://peerloomllc.com/pearcal/')}
                    style={{ ...btnBase, flex: 1 }}>Website</button>
            <button onClick={() => sync?.openURL?.('https://github.com/peerloomllc/pearcal-native')}
                    style={{ ...btnBase, flex: 1 }}>Source</button>
            <button onClick={() => sync?.openURL?.('https://pears.com/')}
                    style={{ ...btnBase, flex: 1 }}>How P2P works</button>
          </div>
        </div>
      </div>
    </div>
  )
}

function ToggleSwitch ({ tokens, value, onChange }) {
  return (
    <button
      onClick={() => onChange(!value)}
      role="switch"
      aria-checked={value}
      style={{
        width: 36, height: 20, borderRadius: 10,
        background: value ? tokens.accent : tokens.border,
        border: 'none', position: 'relative', cursor: 'pointer',
        padding: 0, flexShrink: 0,
        transition: 'background 120ms ease',
      }}>
      <div style={{
        position: 'absolute', top: 2, left: value ? 18 : 2,
        width: 16, height: 16, borderRadius: '50%',
        background: '#fff',
        transition: 'left 120ms ease',
      }} />
    </button>
  )
}
