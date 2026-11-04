// Create, rename, recolor or delete a personal calendar (TODO #189).
// Deleting asks whether the calendar's events move to the default calendar or
// go with it.

import { useEffect, useState } from 'react'

const CAL_COLORS = ['#6C9BF5','#5DBF8A','#E5864A','#D45F7A','#A97FD4','#4BBDCC','#F5C842','#E07B54']

export function CalendarEditModal ({ tokens, cal, calendar, events, saveEventQuiet, removeEvent, onClose }) {
  const isNew = !calendar?.id
  const [name, setName] = useState(calendar?.name ?? '')
  const [color, setColor] = useState(calendar?.color ?? CAL_COLORS[cal.calendars.length % CAL_COLORS.length])
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    function onKey (e) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const count = isNew ? 0 : (events ?? []).filter(e =>
    !(e.groups && e.groups.length) && (e.calendarId || 'default') === calendar.id).length
  const defaultName = cal.calendars[0]?.name ?? 'Personal'

  async function save () {
    if (!name.trim()) { setErr('Give the calendar a name.'); return }
    setBusy(true)
    try {
      if (isNew) await cal.createCalendar({ name: name.trim(), color })
      else await cal.updateCalendar(calendar.id, { name: name.trim(), color })
      onClose()
    } catch (e) { setErr(e?.message ?? String(e)) } finally { setBusy(false) }
  }

  async function doDelete (move) {
    setBusy(true)
    try {
      await cal.deleteCalendar(calendar.id, { events, moveTo: move ? 'default' : null, saveEvent: saveEventQuiet, removeEvent })
      onClose()
    } catch (e) { setErr(e?.message ?? String(e)) } finally { setBusy(false) }
  }

  const inputBase = {
    width: '100%', padding: '7px 10px', borderRadius: 5, fontSize: 13, fontWeight: 400,
    border: `1px solid ${tokens.border}`, background: tokens.bg, color: tokens.text,
    fontFamily: tokens.font, boxSizing: 'border-box', outline: 'none',
  }
  const label = {
    fontSize: 11, fontWeight: 600, color: tokens.muted,
    textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 7,
  }
  const btnBase = {
    padding: '7px 14px', fontSize: 13, fontWeight: 500, borderRadius: 5, cursor: 'pointer',
    fontFamily: tokens.font, border: `1px solid ${tokens.border}`, background: tokens.bg, color: tokens.text,
  }

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: tokens.surface, border: `1px solid ${tokens.border}`,
        borderRadius: 10, padding: 20, width: 400, maxWidth: '90vw',
        boxShadow: '0 12px 40px rgba(0,0,0,0.5)', fontFamily: tokens.font, color: tokens.text,
      }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>
          {isNew ? 'New calendar' : 'Edit calendar'}
        </div>
        {confirmDelete ? (
          <>
            <div style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 16 }}>
              {count === 0
                ? `Delete ${calendar.name}? It has no events.`
                : `${calendar.name} has ${count} event${count === 1 ? '' : 's'}. Move ${count === 1 ? 'it' : 'them'} to ${defaultName}, or delete ${count === 1 ? 'it' : 'them'} too?`}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <button onClick={() => setConfirmDelete(false)} style={btnBase}>Cancel</button>
              {count > 0 && (
                <button disabled={busy} onClick={() => doDelete(true)} style={btnBase}>Move events, delete calendar</button>
              )}
              <button disabled={busy} onClick={() => doDelete(false)}
                style={{ ...btnBase, background: '#E5484D', borderColor: '#E5484D', color: '#fff' }}>
                {count > 0 ? 'Delete with events' : 'Delete'}
              </button>
            </div>
          </>
        ) : (
          <>
            <div style={{ marginBottom: 14 }}>
              <div style={label}>Name</div>
              <input autoFocus value={name} maxLength={60}
                onChange={e => { setName(e.target.value); setErr('') }}
                onKeyDown={e => { if (e.key === 'Enter') save() }}
                placeholder="Health, Work, Family..." style={inputBase} />
            </div>
            <div style={{ marginBottom: 16 }}>
              <div style={label}>Color</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {CAL_COLORS.map(c => (
                  <button key={c} onClick={() => setColor(c)} aria-label={c} style={{
                    width: 24, height: 24, borderRadius: 12, background: c, cursor: 'pointer',
                    border: color === c ? `2px solid ${tokens.text}` : '2px solid transparent',
                  }} />
                ))}
              </div>
            </div>
            {err && <div style={{ fontSize: 12, color: '#E5484D', marginBottom: 10 }}>{err}</div>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              {!isNew && !calendar.isDefault && (
                <button onClick={() => setConfirmDelete(true)}
                  style={{ ...btnBase, marginRight: 'auto', color: '#E5484D' }}>Delete</button>
              )}
              <button onClick={onClose} style={btnBase}>Cancel</button>
              <button disabled={busy} onClick={save}
                style={{ ...btnBase, background: tokens.accent, borderColor: tokens.accent, color: '#fff' }}>Save</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
