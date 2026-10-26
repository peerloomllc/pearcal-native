// Floating popover anchored to a clicked event. Shows core info plus
// Edit / Delete / Duplicate buttons. Doesn't include RSVP buttons yet —
// the RSVP UI plumbs through saveRsvp + member-id + group-id checks
// that are lighter to land alongside D7's full Settings/Profile work.

import { useEffect, useRef, useState } from 'react'
import { formatTime, derivedEventColors, leftStripeStyle } from '../../ui-shared/index.js'
import { linksInText, pearLinkLabel, eventLink, openPearLink } from '../../ui-shared/lib/pearLinks.js'

const POPOVER_WIDTH = 260

// `canEdit` is false for a locked event owned by someone else, or a holiday
// (#162). Delete is withheld then — it would append a group-wide deletion of an
// event this user does not own. Edit stays, reading as "View", because the
// modal opens read-only and is how you see the full details.
export function EventInspector ({ tokens, ev, anchor, groupsById, use24h, canEdit = true, sync, onEdit, onDelete, onDuplicate, onClose }) {
  const ref = useRef(null)
  // PearOffice and PearCal links in the notes, and this event's own link when
  // it is in a shared calendar (proposals/2026-10-26-pearcal-pearoffice-links.md
  // in the suite root).
  const links = linksInText(ev.desc)
  const shareLink = ev.isShadow ? null : eventLink((ev.groups ?? [])[0], ev.id)
  const [copied, setCopied] = useState(false)
  async function copyLink () {
    try { await navigator.clipboard?.writeText?.(shareLink) } catch { return }
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

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
      {links.map(l => (
        <button key={l.url} onClick={() => openPearLink(l.url, sync)} title={l.url} style={{
          display: 'block', width: '100%', textAlign: 'left', marginBottom: 4,
          padding: '5px 8px', fontSize: 12, borderRadius: 4, cursor: 'pointer',
          fontFamily: tokens.font, border: `1px solid ${tokens.border}`,
          background: tokens.bg, color: tokens.accent ?? tokens.text,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {pearLinkLabel(l)}
        </button>
      ))}
      {shareLink && (
        <button onClick={copyLink} style={{ ...btn, display: 'block', width: '100%', flex: 'none', marginTop: 4 }}>
          {copied ? 'Link copied' : 'Copy link'}
        </button>
      )}
      <div style={{ display: 'flex', gap: 5, marginTop: 6 }}>
        <button onClick={onEdit}      style={btn}>{canEdit ? 'Edit' : 'View'}</button>
        <button onClick={onDuplicate} style={btn}>Duplicate</button>
        {canEdit && (
          <button onClick={onDelete}  style={{ ...btn, color: '#C0504A', borderColor: '#C0504A' }}>Delete</button>
        )}
      </div>
    </div>
  )
}
