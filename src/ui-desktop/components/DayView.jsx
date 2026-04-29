// Day view — 24h timeline, single column. Click any timed event opens
// the inspector popover; click empty timeline opens the create modal
// pre-filled with the slot time. Right-click anywhere opens the
// context menu (event-specific or "New event here").
//
// Drag-to-create / drag-to-move / drag-to-resize land in a follow-up
// phase — D4 ships click + right-click only.

import { useMemo, useRef } from 'react'
import { derivedEventColors, leftStripeStyle, formatTime, expandRecurring } from '../../ui-shared/index.js'

const HOUR_HEIGHT = 56
const HOUR_PAD_LEFT = 56
const SNAP_MIN = 15  // 15-minute snap when computing time from y

function eventsForDate (events, dateStr) {
  const out = []
  for (const ev of events) {
    if (ev.recurrence && ev.recurrence !== 'none' && ev.recurrenceEnd && !ev.recurrenceId) {
      for (const occ of expandRecurring(ev)) if (occ.date === dateStr) out.push(occ)
    } else if (ev.date === dateStr) {
      out.push(ev)
    }
    if (ev.endDate && ev.date !== dateStr && dateStr >= ev.date && dateStr <= ev.endDate) {
      if (!out.some(e => e.id === ev.id)) out.push(ev)
    }
  }
  return out
}

function parseTimeToMinutes (t) {
  if (!t) return 0
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}

function minutesToHHMM (mins) {
  const total = Math.max(0, Math.min(24 * 60 - 1, Math.round(mins / SNAP_MIN) * SNAP_MIN))
  const h = Math.floor(total / 60)
  const m = total % 60
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0')
}

function formatHour (h, use24h) {
  if (use24h) return String(h).padStart(2, '0') + ':00'
  if (h === 0) return '12am'
  if (h === 12) return '12pm'
  return (h > 12 ? h - 12 : h) + (h >= 12 ? 'pm' : 'am')
}

function eventGroups (ev, groupsById) {
  return (ev.groups ?? []).map(id => groupsById.get(id)).filter(Boolean)
}

export function DayView ({ tokens, events, groupsById, myRsvps, selectedDate, use24h, interactions = {} }) {
  const dayEvents    = useMemo(() => eventsForDate(events, selectedDate), [events, selectedDate])
  const allDayEvents = dayEvents.filter(e => e.allDay)
  const timedEvents  = dayEvents.filter(e => !e.allDay && e.start)
  const timelineRef  = useRef(null)

  function timeAtY (clientY) {
    const rect = timelineRef.current?.getBoundingClientRect()
    if (!rect) return ''
    const y = clientY - rect.top
    const minutes = (y / HOUR_HEIGHT) * 60
    return minutesToHHMM(minutes)
  }

  function handleTimelineClick (e) {
    if (e.target.closest('[data-event-id]')) return  // click landed on an event
    interactions.onSlotClick?.(selectedDate, timeAtY(e.clientY), '')
  }

  function handleTimelineContextMenu (e) {
    if (e.target.closest('[data-event-id]')) return  // event has its own menu
    e.preventDefault()
    interactions.onSlotContextMenu?.(selectedDate, timeAtY(e.clientY), e.clientX, e.clientY)
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {allDayEvents.length > 0 && (
        <div style={{
          padding: '8px 24px 8px ' + (HOUR_PAD_LEFT + 24) + 'px',
          borderBottom: `1px solid ${tokens.border}`,
          background: tokens.bg,
          display: 'flex', flexWrap: 'wrap', gap: 6,
        }}>
          {allDayEvents.map(ev => (
            <EventChip key={ev.id} ev={ev} tokens={tokens} groupsById={groupsById} myRsvps={myRsvps}
                       interactions={interactions} />
          ))}
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', position: 'relative' }}>
        <div ref={timelineRef}
             onClick={handleTimelineClick}
             onContextMenu={handleTimelineContextMenu}
             style={{ position: 'relative', height: HOUR_HEIGHT * 24, minHeight: HOUR_HEIGHT * 24, cursor: 'crosshair' }}>
          {Array.from({ length: 24 }, (_, h) => (
            <div key={h} style={{
              position: 'absolute', top: h * HOUR_HEIGHT, left: 0, right: 0,
              height: HOUR_HEIGHT, borderTop: `1px solid ${tokens.border}`,
              display: 'flex', pointerEvents: 'none',
            }}>
              <div style={{
                width: HOUR_PAD_LEFT, paddingTop: 4, paddingRight: 8, textAlign: 'right',
                color: tokens.muted, fontSize: 11, fontVariantNumeric: 'tabular-nums',
              }}>
                {formatHour(h, use24h)}
              </div>
              <div style={{ flex: 1 }} />
            </div>
          ))}

          <div style={{ position: 'absolute', top: 0, left: HOUR_PAD_LEFT, right: 24, bottom: 0 }}>
            {timedEvents.map(ev => (
              <PositionedEvent key={ev.id} ev={ev} tokens={tokens} groupsById={groupsById} myRsvps={myRsvps}
                               use24h={use24h} interactions={interactions} />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function PositionedEvent ({ ev, tokens, groupsById, myRsvps, use24h, interactions }) {
  const startMin = parseTimeToMinutes(ev.start)
  const endMin   = ev.end ? parseTimeToMinutes(ev.end) : startMin + 30
  const top    = (startMin / 60) * HOUR_HEIGHT
  const height = Math.max(20, ((endMin - startMin) / 60) * HOUR_HEIGHT - 2)
  const colors = derivedEventColors(ev, eventGroups(ev, groupsById))
  const declined = myRsvps[ev.id] === 'declined'

  function onClick (e) {
    e.stopPropagation()
    interactions.onEventClick?.(ev, e.clientX, e.clientY)
  }
  function onContextMenu (e) {
    e.stopPropagation()
    e.preventDefault()
    interactions.onEventContextMenu?.(ev, e.clientX, e.clientY)
  }

  return (
    <div data-event-id={ev.id} onClick={onClick} onContextMenu={onContextMenu}
      style={{
        position: 'absolute', top, left: 8, right: 8, height,
        background: tokens.surface,
        border: `1px solid ${tokens.border}`,
        borderRadius: 6,
        padding: '4px 8px 4px 12px',
        fontSize: 12, overflow: 'hidden',
        opacity: declined ? 0.45 : 1,
        cursor: 'pointer',
        ...leftStripeStyle(colors, 4),
      }}>
      <div style={{
        fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        textDecoration: declined ? 'line-through' : 'none', pointerEvents: 'none',
      }}>
        {ev.title}
      </div>
      <div style={{ color: tokens.muted, fontSize: 11, fontVariantNumeric: 'tabular-nums', pointerEvents: 'none' }}>
        {formatTime(ev.start, use24h)}{ev.end ? '–' + formatTime(ev.end, use24h) : ''}
      </div>
    </div>
  )
}

function EventChip ({ ev, tokens, groupsById, myRsvps, interactions }) {
  const colors = derivedEventColors(ev, eventGroups(ev, groupsById))
  const declined = myRsvps[ev.id] === 'declined'
  function onClick (e) { e.stopPropagation(); interactions.onEventClick?.(ev, e.clientX, e.clientY) }
  function onContextMenu (e) {
    e.stopPropagation(); e.preventDefault()
    interactions.onEventContextMenu?.(ev, e.clientX, e.clientY)
  }
  return (
    <div data-event-id={ev.id} onClick={onClick} onContextMenu={onContextMenu} style={{
      padding: '3px 10px',
      background: tokens.surface, border: `1px solid ${tokens.border}`,
      borderRadius: 4, fontSize: 12, fontWeight: 500,
      opacity: declined ? 0.45 : 1,
      textDecoration: declined ? 'line-through' : 'none',
      cursor: 'pointer',
      ...leftStripeStyle(colors, 3),
    }}>
      {ev.title}
    </div>
  )
}
