// Floating popover anchored to a clicked event. Shows core info plus
// Edit / Delete / Duplicate buttons. Doesn't include RSVP buttons yet —
// the RSVP UI plumbs through saveRsvp + member-id + group-id checks
// that are lighter to land alongside D7's full Settings/Profile work.

import { useEffect, useRef } from 'react'
import { formatTime, derivedEventColors, leftStripeStyle } from '../../ui-shared/index.js'

const POPOVER_WIDTH = 260

export function EventInspector ({ tokens, ev, anchor, groupsById, use24h, onEdit, onDelete, onDuplicate, onClose }) {
  const ref = useRef(null)

  useEffect(() => {
    function onDown (e) {
      if (ref.current && !ref.current.contains(e.target)) onClose()
    }
    function onKey (e) { if (e.key === 'Escape') onClose() }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  // Position: try to place to the right of the anchor; if it would overflow
  // the viewport, place to the left.
  const vw = window.innerWidth
  const vh = window.innerHeight
  let left = anchor.x + 8
  if (left + POPOVER_WIDTH > vw - 16) left = anchor.x - POPOVER_WIDTH - 8
  let top  = anchor.y
  if (top + 200 > vh - 16) top = vh - 216

  const groupNames = (ev.groups ?? [])
    .map(id => groupsById.get(id))
    .filter(Boolean)
    .map(g => (g.emoji ? g.emoji + ' ' : '') + g.name)
  const colors = derivedEventColors(ev, (ev.groups ?? []).map(id => groupsById.get(id)).filter(Boolean))

  const btn = {
    flex: 1, padding: '6px 10px', fontSize: 12, fontWeight: 500,
    borderRadius: 4, cursor: 'pointer',
    fontFamily: tokens.font,
    border: `1px solid ${tokens.border}`,
    background: tokens.bg, color: tokens.text,
  }

  return (
    <div ref={ref} onMouseDown={e => e.stopPropagation()} style={{
      position: 'fixed', top, left, width: POPOVER_WIDTH, zIndex: 90,
      background: tokens.surface, border: `1px solid ${tokens.border}`,
      borderRadius: 8, padding: 10,
      boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
      ...leftStripeStyle(colors, 4),
      paddingLeft: 14,
      fontFamily: tokens.font,
    }}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
        {ev.title}
      </div>
      <div style={{ fontSize: 12, color: tokens.muted, marginBottom: 6, fontVariantNumeric: 'tabular-nums' }}>
        {ev.allDay
          ? 'All day · ' + ev.date
          : ev.date + ' · ' + formatTime(ev.start, use24h) + (ev.end ? '–' + formatTime(ev.end, use24h) : '')}
      </div>
      {groupNames.length > 0 && (
        <div style={{ fontSize: 11, color: tokens.muted, marginBottom: 5 }}>
          {groupNames.join(', ')}
        </div>
      )}
      {ev.location && (
        <div style={{ fontSize: 12, color: tokens.text, marginBottom: 5 }}>
          📍 {ev.location}
        </div>
      )}
      {ev.desc && (
        <div style={{
          fontSize: 12, color: tokens.text, marginBottom: 6,
          maxHeight: 80, overflowY: 'auto', whiteSpace: 'pre-wrap',
        }}>
          {ev.desc}
        </div>
      )}
      <div style={{ display: 'flex', gap: 5, marginTop: 6 }}>
        <button onClick={onEdit}      style={btn}>Edit</button>
        <button onClick={onDuplicate} style={btn}>Duplicate</button>
        <button onClick={onDelete}    style={{ ...btn, color: '#C0504A', borderColor: '#C0504A' }}>Delete</button>
      </div>
    </div>
  )
}
