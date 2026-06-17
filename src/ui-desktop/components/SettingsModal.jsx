// Settings modal — display preferences (24h / week start), recovery
// phrase reveal + restore, linked devices, About. Mobile's settings
// tab also covers backup/blind-peer, holiday subscriptions, ICS
// import/export, and storage reclaim — deferred until users ask.
//
// updateProfile-routed prefs use the wrapper from App.jsx (db.updateProfile
// + optimistic setProfile) since bare's profileChanged event only fires
// on sibling-device sync, never on local writes.

import { useEffect, useState } from 'react'
import { HOLIDAY_COUNTRIES, holidayEventId } from '../../ui-shared/index.js'

// Injected by electron/scripts/bundle-ui.sh from electron/package.json#version
// at build time. Falls back to "0.0.0" only if someone runs the bundle without
// that script (e.g., raw esbuild during dev).
const APP_VERSION = process.env.PEARCAL_VERSION || '0.0.0'

const WEEK_STARTS = [
  { value: 0, label: 'Sunday' },
  { value: 1, label: 'Monday' },
]

// Mirrors the mobile reminder options (src/ui/App.jsx). The two negatives are
// fixed-time reminders rather than minute offsets; bare interprets them.
const MORNING_OF = -1
const DAY_BEFORE = -2
const REMINDER_OPTIONS = [
  { label: '5 min before',      value: 5 },
  { label: '10 min before',     value: 10 },
  { label: '15 min before',     value: 15 },
  { label: '30 min before',     value: 30 },
  { label: '1 hour before',     value: 60 },
  { label: '2 hours before',    value: 120 },
  { label: 'Morning of (9 AM)', value: MORNING_OF },
  { label: 'Day before (9 AM)', value: DAY_BEFORE },
  { label: '1 day before',      value: 1440 },
  { label: '1 week before',     value: 10080 },
  { label: '2 weeks before',    value: 20160 },
]

export function SettingsModal ({ tokens, profile, updateProfile, db, sync, events = [], setEvents, onOpenLinkedDevices, onClose }) {
  const [phrase,   setPhrase]   = useState(null)         // null = hidden, '' = loading, '...' = revealed
  const [phraseErr, setPhraseErr] = useState('')
  const [phraseCopied, setPhraseCopied] = useState(false)
  const [holidayWorking, setHolidayWorking] = useState(false)
  // Mnemonic restore lives in bare (db.restoreMnemonic), but the mobile
  // app doesn't expose a settings-time restore yet — restore there only
  // runs during onboarding. Hide the desktop UI until parity lands.
  // Match the same locale-aware default the App uses so the toggle
  // reads "On" only when the user has explicitly chosen 24h.
  const localeUse24h = !new Intl.DateTimeFormat([], { hour: 'numeric' }).format(0).match(/am|pm/i)
  const [use24h,    setUse24h]    = useState(profile?.use24h    ?? localeUse24h)
  const [weekStart, setWeekStart] = useState(profile?.weekStart ?? 0)
  const [dark,      setDark]      = useState(profile?.dark      ?? true)
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
  function handleDarkChange (next) {
    setDark(next)
    persist({ dark: next })
  }

  // Holiday subscriptions. Mirrors the mobile toggle (src/ui/App.jsx): on,
  // import this + next year's dates as personal all-day events (skipping any
  // already present by shared ID or date+title); off, remove only the dates no
  // other still-active calendar needs. Holiday events are local/personal, so
  // they go through db.putEvent / db.localDeleteEvent — not group sync.
  const activeCountries = new Set(profile?.holidayCountries ?? [])
  async function toggleCountry (code, fn, on) {
    setHolidayWorking(true)
    const meta = HOLIDAY_COUNTRIES.find(c => c.code === code)
    const color = meta?.color ?? '#CF3535'
    const colors = meta?.colors ?? []
    const desc  = meta?.desc  ?? 'Public Holiday'
    const thisYear = new Date().getFullYear()
    const newActive = new Set(activeCountries)
    try {
      if (on) {
        newActive.add(code)
        const existingIds = new Set((events ?? []).map(e => e.id))
        const existingKeys = new Set((events ?? []).map(e => e.date + '|' + e.title))
        for (const yr of [thisYear, thisYear + 1]) {
          for (const h of fn(yr)) {
            const id = holidayEventId(h)
            const key = h.date + '|' + h.title
            if (existingIds.has(id) || existingKeys.has(key)) continue
            const ev = {
              id, title: h.title, date: h.date, allDay: true,
              start: '00:00', end: '00:00', reminder: -1,
              groups: [], invitees: [], color, colors, desc, location: '',
              creatorId: 'system', recurrence: 'none',
              recurrenceId: '', recurrenceEnd: '', recurrenceNth: 0, recurrenceWeekday: 0,
              editPermission: 'everyone', updatedAt: Date.now(),
            }
            await db?.putEvent(ev).catch(() => {})
            setEvents?.(prev => prev.find(e => e.id === ev.id) ? prev : [...prev, ev])
            existingIds.add(id)
            existingKeys.add(key)
          }
        }
      } else {
        newActive.delete(code)
        // Keep IDs still needed by other still-active countries
        const keepIds = new Set()
        for (const { code: otherCode, fn: otherFn } of HOLIDAY_COUNTRIES) {
          if (otherCode === code || !newActive.has(otherCode)) continue
          for (const yr of [thisYear, thisYear + 1]) {
            for (const h of otherFn(yr)) keepIds.add(holidayEventId(h))
          }
        }
        for (const yr of [thisYear, thisYear + 1]) {
          for (const h of fn(yr)) {
            const id = holidayEventId(h)
            if (keepIds.has(id)) continue
            const ev = (events ?? []).find(e => e.id === id)
            if (ev) {
              await db?.localDeleteEvent(ev.date, ev.id).catch(() => {})
              setEvents?.(prev => prev.filter(e => e.id !== id))
            }
          }
        }
      }
      await updateProfile({ holidayCountries: [...newActive] }).catch(() => {})
    } finally {
      setHolidayWorking(false)
    }
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
  const selectStyle = {
    padding: '6px 10px', fontSize: 13, fontWeight: 400,
    borderRadius: 5, border: `1px solid ${tokens.border}`,
    background: tokens.bg, color: tokens.text, fontFamily: tokens.font,
    cursor: 'pointer', outline: 'none',
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
        <div style={{ position: 'relative', marginBottom: 14 }}>
          <div style={{ fontSize: 14, fontWeight: 600, textAlign: 'center' }}>Settings</div>
          {saved && (
            <div style={{ position: 'absolute', top: 0, right: 36, fontSize: 12, color: '#5DBF8A' }}>✓ Saved</div>
          )}
          {saving && !saved && (
            <div style={{ position: 'absolute', top: 0, right: 36, fontSize: 12, color: tokens.muted }}>Saving…</div>
          )}
          <button onClick={onClose} style={{
            ...btnBase, padding: '4px 10px', fontSize: 14,
            background: 'transparent', border: 'none',
            position: 'absolute', top: 0, right: 0,
          }}>✕</button>
        </div>

        <div style={{ marginBottom: 18 }}>
          <div style={label}>Display</div>
          <div style={row}>
            <div style={{ flex: 1, fontSize: 13 }}>Theme</div>
            <div style={{ display: 'flex', gap: 4 }}>
              {[{ value: false, label: 'Light' }, { value: true, label: 'Dark' }].map(t => (
                <button key={String(t.value)}
                  onClick={() => handleDarkChange(t.value)}
                  style={{
                    ...btnBase, padding: '4px 10px',
                    background: dark === t.value ? tokens.accent : tokens.bg,
                    color:      dark === t.value ? tokens.bg     : tokens.text,
                    borderColor: dark === t.value ? tokens.accent : tokens.border,
                  }}>
                  {t.label}
                </button>
              ))}
            </div>
          </div>
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
          <div style={label}>Reminders</div>
          <div style={row}>
            <div style={{ flex: 1, fontSize: 13 }}>Default reminder</div>
            <select
              value={profile?.defaultReminder ?? 15}
              onChange={e => persist({ defaultReminder: Number(e.target.value) })}
              style={selectStyle}>
              <option value={0}>None</option>
              {REMINDER_OPTIONS.map(r => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
          </div>
          <div style={{ fontSize: 12, color: tokens.muted, lineHeight: 1.5, paddingTop: 2 }}>
            Applied to new events you create on this device.
          </div>
        </div>

        <div style={{ marginBottom: 18 }}>
          <div style={label}>Holidays</div>
          <div style={{ opacity: holidayWorking ? 0.6 : 1, transition: 'opacity 0.2s' }}>
            {HOLIDAY_COUNTRIES.map(({ code, flag, label: cLabel, fn, color: flagColor }, i) => {
              const thisYear = new Date().getFullYear()
              return (
                <div key={code} style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0',
                  borderBottom: i < HOLIDAY_COUNTRIES.length - 1 ? `1px solid ${tokens.border}` : 'none',
                }}>
                  <span style={{ fontSize: 18, color: flagColor }}>{flag}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13 }}>{cLabel}</div>
                    <div style={{ fontSize: 11, color: tokens.muted }}>
                      {fn(thisYear).length} holidays · {thisYear}–{thisYear + 1}
                    </div>
                  </div>
                  <ToggleSwitch tokens={tokens} value={activeCountries.has(code)}
                    onChange={v => { if (!holidayWorking) toggleCountry(code, fn, v) }} />
                </div>
              )
            })}
          </div>
          {activeCountries.size > 0 && (
            <div style={{ fontSize: 12, color: tokens.muted, lineHeight: 1.5, paddingTop: 6 }}>
              Added to your personal calendar. Toggle off to remove.
            </div>
          )}
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

        <div style={{ marginBottom: 4 }}>
          <div style={label}>About</div>
          <div style={{ ...row, fontSize: 13, color: tokens.text }}>
            <div style={{ flex: 1 }}>PearCal Desktop</div>
            <div style={{ color: tokens.muted, fontVariantNumeric: 'tabular-nums' }}>v{APP_VERSION}</div>
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
