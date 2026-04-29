// Centered modal for create + edit. The form is intentionally simple
// for D4 — title, date, all-day toggle, time range, group multi-select,
// notes, location. Recurring + reminders + RSVP-enable land in later
// phases; the underlying record format already accepts those fields,
// so existing events with them will round-trip safely (we just don't
// expose UI to change them yet).

import { useEffect, useRef, useState } from 'react'

function makeEventId () {
  return 'e' + Date.now() + Math.floor(Math.random() * 1000)
}

const DEFAULT_TIMES = { start: '09:00', end: '10:00' }

export function EventModal ({ tokens, mode, initial, groups, profile, onSave, onDelete, onClose }) {
  const [title,    setTitle]    = useState(initial?.title ?? '')
  const [date,     setDate]     = useState(initial?.date ?? '')
  const [allDay,   setAllDay]   = useState(initial?.allDay ?? false)
  const [start,    setStart]    = useState(initial?.start ?? DEFAULT_TIMES.start)
  const [end,      setEnd]      = useState(initial?.end ?? DEFAULT_TIMES.end)
  const [groupIds, setGroupIds] = useState(initial?.groups ?? [])
  const [notes,    setNotes]    = useState(initial?.desc ?? '')
  const [location, setLocation] = useState(initial?.location ?? '')

  const titleRef = useRef(null)
  useEffect(() => { titleRef.current?.focus() }, [])

  // Esc-to-close at the modal level — App.jsx wires its own global
  // Esc handler in D5; for now keep the listener local.
  useEffect(() => {
    function onKey (e) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function toggleGroup (id) {
    setGroupIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  }

  function handleSave () {
    const t = title.trim()
    if (!t || !date) return
    const ev = {
      id: initial?.id ?? makeEventId(),
      title: t,
      date,
      allDay,
      start: allDay ? '' : start,
      end:   allDay ? '' : end,
      groups: groupIds,
      invitees: initial?.invitees ?? [],
      desc: notes,
      location,
      meetingLink: initial?.meetingLink ?? '',
      color:       initial?.color ?? '',
      colors:      initial?.colors ?? [],
      creatorId:   initial?.creatorId ?? profile?.id ?? 'unknown',
      recurrence:        initial?.recurrence ?? 'none',
      recurrenceId:      initial?.recurrenceId ?? '',
      recurrenceEnd:     initial?.recurrenceEnd ?? '',
      recurrenceNth:     initial?.recurrenceNth ?? 0,
      recurrenceWeekday: initial?.recurrenceWeekday ?? 0,
      editPermission:    initial?.editPermission ?? 'creator',
      endDate:           initial?.endDate ?? '',
      rsvpEnabled:       initial?.rsvpEnabled ?? false,
    }
    const opts = {}
    if (mode === 'edit' && initial?.date && initial.date !== date) opts._prevDate = initial.date
    onSave(ev, opts)
  }

  function handleDelete () {
    if (mode !== 'edit' || !initial?.id) return
    if (!confirm('Delete "' + (initial.title ?? 'this event') + '"?')) return
    onDelete(initial.id)
  }

  const inputBase = {
    width: '100%', padding: '8px 10px', borderRadius: 6,
    fontSize: 13, fontWeight: 400,
    border: `1px solid ${tokens.border}`, background: tokens.bg, color: tokens.text,
    fontFamily: tokens.font, boxSizing: 'border-box', outline: 'none',
  }

  const label = {
    fontSize: 11, fontWeight: 500, color: tokens.muted,
    textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4,
  }

  const btnBase = {
    padding: '8px 16px', fontSize: 13, fontWeight: 500,
    borderRadius: 6, cursor: 'pointer',
    fontFamily: tokens.font, border: `1px solid ${tokens.border}`,
    background: tokens.bg, color: tokens.text,
  }

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0,
      background: 'rgba(0,0,0,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 100,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: tokens.surface, border: `1px solid ${tokens.border}`,
        borderRadius: 10, padding: 24, width: 480, maxWidth: '90vw',
        maxHeight: '90vh', overflowY: 'auto',
        boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
      }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 16 }}>
          {mode === 'edit' ? 'Edit event' : 'New event'}
        </div>

        <div style={{ marginBottom: 12 }}>
          <div style={label}>Title</div>
          <input ref={titleRef} value={title} onChange={e => setTitle(e.target.value)}
                 placeholder="Event title" style={inputBase} />
        </div>

        <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={label}>Date</div>
            <input type="date" value={date} onChange={e => setDate(e.target.value)} style={inputBase} />
          </div>
          <label style={{
            display: 'flex', alignItems: 'flex-end', gap: 6, paddingBottom: 8,
            fontSize: 13, color: tokens.text, cursor: 'pointer',
          }}>
            <input type="checkbox" checked={allDay} onChange={e => setAllDay(e.target.checked)} />
            All day
          </label>
        </div>

        {!allDay && (
          <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={label}>Start</div>
              <input type="time" value={start} onChange={e => setStart(e.target.value)} style={inputBase} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={label}>End</div>
              <input type="time" value={end} onChange={e => setEnd(e.target.value)} style={inputBase} />
            </div>
          </div>
        )}

        <div style={{ marginBottom: 12 }}>
          <div style={label}>Groups</div>
          {groups.length === 0 && (
            <div style={{ fontSize: 13, color: tokens.muted }}>
              No groups. Event will be personal-only.
            </div>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {groups.map(g => {
              const selected = groupIds.includes(g.id)
              return (
                <button key={g.id} onClick={() => toggleGroup(g.id)} style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '4px 10px', borderRadius: 14,
                  background: selected ? (g.color ?? tokens.muted) : 'transparent',
                  color: selected ? tokens.bg : tokens.text,
                  border: `1px solid ${g.color ?? tokens.border}`,
                  fontSize: 12, fontWeight: 500, cursor: 'pointer',
                  fontFamily: tokens.font,
                }}>
                  {g.emoji ? g.emoji + ' ' : ''}{g.name}
                </button>
              )
            })}
          </div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <div style={label}>Location</div>
          <input value={location} onChange={e => setLocation(e.target.value)}
                 placeholder="Optional" style={inputBase} />
        </div>

        <div style={{ marginBottom: 16 }}>
          <div style={label}>Notes</div>
          <textarea value={notes} onChange={e => setNotes(e.target.value)}
                    rows={3} placeholder="Optional"
                    style={{ ...inputBase, resize: 'vertical', minHeight: 60 }} />
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          {mode === 'edit' && (
            <button onClick={handleDelete} style={{
              ...btnBase,
              color: '#C0504A', borderColor: '#C0504A', marginRight: 'auto',
            }}>Delete</button>
          )}
          <button onClick={onClose} style={btnBase}>Cancel</button>
          <button onClick={handleSave} disabled={!title.trim() || !date} style={{
            ...btnBase,
            background: tokens.accent, color: tokens.bg, borderColor: tokens.accent,
            opacity: (!title.trim() || !date) ? 0.5 : 1,
            cursor:  (!title.trim() || !date) ? 'default' : 'pointer',
          }}>{mode === 'edit' ? 'Save' : 'Create'}</button>
        </div>
      </div>
    </div>
  )
}
