// Settings modal - display preferences (24h / week start), holidays, .ics
// import/export, storage reports, linked devices, About. Blind-peer management
// is the remaining gap against mobile's settings tab (#163).
//
// The storage section is read-only on purpose. Mobile ships the same two
// reports and hides its two write actions, Reclaim Storage and Sweep Orphaned
// Data, behind `{false && ...}` (#154, PR #143), so desktop does not offer them
// either.
//
// No recovery-phrase surface: the seed is an internal identity seed, never
// shown, exported or backed up (removed 2026-07-27).
//
// updateProfile-routed prefs use the wrapper from App.jsx (db.updateProfile
// + optimistic setProfile) since bare's profileChanged event only fires
// on sibling-device sync, never on local writes.

import { useEffect, useRef, useState } from 'react'
import { HOLIDAY_COUNTRIES, holidayEventId, holidayCalendarIds, strayHolidayEvents, generateIcs, parseIcs } from '../../ui-shared/index.js'
import { REMINDER_OPTIONS } from '../lib/reminderOptions.js'
import { StorageReportModal } from './StorageReportModal.jsx'

// Injected by electron/scripts/bundle-ui.sh from electron/package.json#version
// at build time. Falls back to "0.0.0" only if someone runs the bundle without
// that script (e.g., raw esbuild during dev).
const APP_VERSION = process.env.PEARCAL_VERSION || '0.0.0'

const WEEK_STARTS = [
  { value: 0, label: 'Sunday' },
  { value: 1, label: 'Monday' },
]


export function SettingsModal ({ tokens, profile, updateProfile, db, sync, events = [], setEvents, onOpenLinkedDevices, onImportIcs, onClose }) {
  const [holidayWorking, setHolidayWorking] = useState(false)
  const icsFileRef = useRef(null)
  // Set when a picked file parses to nothing usable, so the click isn't silent.
  const [icsError, setIcsError] = useState('')
  // Match the same locale-aware default the App uses so the toggle
  // reads "On" only when the user has explicitly chosen 24h.
  const localeUse24h = !new Intl.DateTimeFormat([], { hour: 'numeric' }).format(0).match(/am|pm/i)
  const [use24h,    setUse24h]    = useState(profile?.use24h    ?? localeUse24h)
  const [weekStart, setWeekStart] = useState(profile?.weekStart ?? 0)
  const [dark,      setDark]      = useState(profile?.dark      ?? true)
  const [saving,    setSaving]    = useState(false)
  const [saved,     setSaved]     = useState(false)
  // Launch-at-startup (TODO #103). Desktop reminders are in-memory timers that
  // die with the process, so they only fire after a reboot if the app is
  // auto-started at login. Default off; the truth lives in the OS login-item,
  // read here on open via db.getLaunchAtLogin (electron main intercept).
  const [launchAtLogin, setLaunchAtLogin] = useState(false)
  // TODO #134 - null until loaded; `configured: false` means this build has no
  // relay wired at all, in which case the section stays hidden rather than
  // offering a switch that controls nothing.
  const [relayStatus, setRelayStatus] = useState(null)
  // { kind: 'breakdown' | 'analyze', report, error } while a report is open.
  const [storageReport, setStorageReport] = useState(null)
  const [storageBusy, setStorageBusy] = useState('')

  useEffect(() => {
    function onKey (e) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    let alive = true
    db?.getLaunchAtLogin?.().then(v => { if (alive) setLaunchAtLogin(!!v) }).catch(() => {})
    return () => { alive = false }
  }, [db])

  useEffect(() => {
    let alive = true
    db?.getRelayStatus?.().then(s => { if (alive) setRelayStatus(s ?? null) }).catch(() => {})
    return () => { alive = false }
  }, [db])

  // Optimistic like the toggle above, and re-read afterwards so the counters
  // below reflect what the worklet actually did rather than what we asked for.
  async function handleUseRelayChange (next) {
    setRelayStatus(prev => prev ? { ...prev, useRelay: next } : prev)
    try {
      await db?.setUseRelay?.(next)
      const fresh = await db?.getRelayStatus?.()
      if (fresh) setRelayStatus(fresh)
    } catch (e) {
      setRelayStatus(prev => prev ? { ...prev, useRelay: !next } : prev)
    }
  }

  async function handleLaunchAtLoginChange (next) {
    setLaunchAtLogin(next)  // optimistic
    try {
      const applied = await db?.setLaunchAtLogin?.(next)
      if (typeof applied === 'boolean') setLaunchAtLogin(applied)
    } catch (e) {
      setLaunchAtLogin(!next)  // revert on failure
    }
  }

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
    const years = [thisYear, thisYear + 1]
    const newActive = new Set(activeCountries)
    // IDs the calendars that stay on after this toggle still need.
    const otherIds = () => {
      const keep = new Set()
      for (const { code: otherCode, fn: otherFn } of HOLIDAY_COUNTRIES) {
        if (otherCode === code || !newActive.has(otherCode)) continue
        for (const id of holidayCalendarIds(otherFn, years)) keep.add(id)
      }
      return keep
    }
    // Remove this calendar's stored events that `keepIds` does not claim. Matched
    // by title slug rather than exact ID so events sitting at a date an older
    // build computed wrongly are still found.
    const keepAndSweep = async keepIds => {
      for (const ev of strayHolidayEvents(events, fn, years, keepIds)) {
        await db?.localDeleteEvent(ev.date, ev.id).catch(() => {})
        setEvents?.(prev => prev.filter(e => e.id !== ev.id))
      }
    }
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
        // Turning a calendar on also repairs it: drop anything it left behind at
        // a date an older build computed wrongly, keeping the dates it and the
        // other active calendars still want.
        await keepAndSweep(new Set([...otherIds(), ...holidayCalendarIds(fn, years)]))
      } else {
        newActive.delete(code)
        await keepAndSweep(otherIds())
      }
      await updateProfile({ holidayCountries: [...newActive] }).catch(() => {})
    } finally {
      setHolidayWorking(false)
    }
  }

  // One handler for both reports. They are slow enough on a big store to need a
  // busy label, and a failure has to land in the modal rather than disappearing:
  // a silent catch here is how the desktop ended up with features nobody could
  // tell were missing (#146).
  async function runReport (kind) {
    if (storageBusy) return
    setStorageBusy(kind)
    try {
      const report = kind === 'breakdown'
        ? await sync.storageBreakdown()
        : await sync.analyzeStorage({ keepTail: 100 })
      setStorageReport({ kind, report })
    } catch (e) {
      setStorageReport({ kind, error: e?.message || 'That report could not be produced.' })
    } finally {
      setStorageBusy('')
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
          <div style={row}>
            <div style={{ flex: 1, fontSize: 13 }}>Launch at startup</div>
            <ToggleSwitch tokens={tokens} value={launchAtLogin} onChange={handleLaunchAtLoginChange} />
          </div>
          <div style={{ fontSize: 12, color: tokens.muted, lineHeight: 1.5, paddingTop: 2 }}>
            Opens PearCal to the tray when you log in, so reminders still fire after a restart.
          </div>
        </div>

        {/* Connection — the off-LAN relay backstop (TODO #130 engine, #134 control).
            Wording deliberately mirrors mobile's: same feature, same promise. */}
        {relayStatus?.configured && (
          <div style={{ marginBottom: 18 }}>
            <div style={label}>Connection</div>
            <div style={row}>
              <div style={{ flex: 1, fontSize: 13 }}>Use a relay when direct fails</div>
              <ToggleSwitch tokens={tokens} value={relayStatus.useRelay !== false}
                onChange={handleUseRelayChange} />
            </div>
            <div style={{ fontSize: 12, color: tokens.muted, lineHeight: 1.5, paddingTop: 2 }}>
              Some networks block devices from connecting straight to each other. When
              that happens, PearCal routes through a relay run by PeerLoom. It only ever
              carries scrambled data it can’t read, and it’s only used after a direct
              connection has already failed.
            </div>
            {relayStatus.useRelay !== false
              && (relayStatus.offers > 0 || (relayStatus.relaying?.successes ?? 0) > 0) && (
              <div style={{ fontSize: 12, color: tokens.muted, lineHeight: 1.5, paddingTop: 6 }}>
                Used since the app started: {relayStatus.offers} outgoing
                {(relayStatus.relaying?.successes ?? 0) > 0
                  ? `, ${relayStatus.relaying.successes} incoming`
                  : ''}
              </div>
            )}
            {relayStatus.useRelay === false && (
              <div style={{ fontSize: 12, color: tokens.muted, lineHeight: 1.5, paddingTop: 6 }}>
                Off — connections stay strictly device to device. On a network that
                blocks them, syncing may not work at all.
              </div>
            )}
          </div>
        )}

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

        {/* Import & Export (TODO #170) — the picked file is handed up to App.jsx,
            which owns the destination prompt and the saveEvent path. */}
        <div style={{ marginBottom: 18 }}>
          <div style={label}>Import &amp; export</div>
          <input ref={icsFileRef} type="file" accept=".ics,.ical,text/calendar"
            style={{ display: 'none' }} onChange={e => {
              const file = e.target.files?.[0]
              if (!file) return
              e.target.value = ''
              setIcsError('')
              const reader = new FileReader()
              reader.onerror = () => setIcsError('Could not read that file.')
              reader.onload = ev => {
                const parsed = parseIcs(String(ev.target.result ?? ''))
                if (!parsed.length) { setIcsError('No events found in that file.'); return }
                onImportIcs?.({ events: parsed, filename: file.name })
              }
              reader.readAsText(file)
            }} />
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => icsFileRef.current?.click()}
              style={{ ...btnBase, flex: 1 }}>Import from .ics</button>
            <button onClick={() => {
              const nonHoliday = (events ?? []).filter(e => !e.id?.startsWith('holiday-'))
              if (!nonHoliday.length || !sync) { setIcsError('There are no events to export yet.'); return }
              setIcsError('')
              sync.exportIcs(generateIcs(nonHoliday))
            }} style={{ ...btnBase, flex: 1 }}>Export to .ics</button>
          </div>
          <div style={{ fontSize: 12, color: tokens.muted, lineHeight: 1.5, paddingTop: 6 }}>
            {icsError || 'Importing asks whether the events stay personal or go to one of your groups. Exporting saves every event except holidays.'}
          </div>
        </div>

        {sync?.storageBreakdown && (
          <div style={{ marginBottom: 18 }}>
            <div style={label}>Storage</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button disabled={!!storageBusy} onClick={() => runReport('breakdown')}
                style={{ ...btnBase, flex: 1, cursor: storageBusy ? 'wait' : 'pointer', opacity: storageBusy ? 0.6 : 1 }}>
                {storageBusy === 'breakdown' ? 'Measuring…' : 'Storage breakdown'}
              </button>
              <button disabled={!!storageBusy} onClick={() => runReport('analyze')}
                style={{ ...btnBase, flex: 1, cursor: storageBusy ? 'wait' : 'pointer', opacity: storageBusy ? 0.6 : 1 }}>
                {storageBusy === 'analyze' ? 'Analyzing…' : 'Analyze reclaimable'}
              </button>
            </div>
            <div style={{ fontSize: 12, color: tokens.muted, lineHeight: 1.5, paddingTop: 6 }}>
              See where this computer's disk space went, and how much of it is old history.
              Both reports only look; neither changes or deletes anything.
            </div>
          </div>
        )}

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
      {storageReport && (
        <StorageReportModal
          tokens={tokens}
          kind={storageReport.kind}
          report={storageReport.report}
          error={storageReport.error}
          onClose={() => setStorageReport(null)}
        />
      )}
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
