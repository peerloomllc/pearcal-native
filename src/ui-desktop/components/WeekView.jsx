// Week view — 7-day grid sharing the DayView's hour gutter on the
// left. Click handlers identical to DayView except date is per-column.

import { useMemo, useRef } from 'react'
import { derivedEventColors, leftStripeStyle, formatTime, expandRecurring } from '../../ui-shared/index.js'
import { useDragCreate, fromMinHHMM } from '../hooks/useDragCreate.js'
import { useDragEvent } from '../hooks/useDragEvent.js'
import { DragPreview } from './DragPreview.jsx'

const HOUR_HEIGHT = 56
const HOUR_PAD_LEFT = 56
const DOW_FULL = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']

function shiftDate (dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  dt.setDate(dt.getDate() + days)
  return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0')
}

function weekStartFor (dateStr, weekStartDow) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  const offset = (dt.getDay() - weekStartDow + 7) % 7
  dt.setDate(dt.getDate() - offset)
  return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0')
}

function todayLocal () {
  const t = new Date()
  return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0')
}

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

// Click anywhere within an hour band → top of that hour. See DayView
// for rationale; D4b drag-to-create will use a finer snap.
function topOfHourAtY (y) {
  const h = Math.max(0, Math.min(23, Math.floor(y / HOUR_HEIGHT)))
  return String(h).padStart(2, '0') + ':00'
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

export function WeekView ({ tokens, events, groupsById, myRsvps, selectedDate, setSelectedDate, use24h, weekStart = 0, interactions = {} }) {
  const startDate = useMemo(() => weekStartFor(selectedDate, weekStart), [selectedDate, weekStart])
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => shiftDate(startDate, i)), [startDate])
  const today = todayLocal()
  const colRefs = useRef({})

  // Drag-to-create. dragRange.date scopes the preview to the active
  // column so other columns don't render a stale ghost.
  const drag = useDragCreate({
    snapMin: 30,
    onClick: ({ date, startMin }) => {
      const h = Math.floor(startMin / 60)
      interactions.onSlotClick?.(date, String(h).padStart(2, '0') + ':00', '')
    },
    onCommit: ({ date, fromMin, toMin }) => {
      interactions.onSlotClick?.(date, fromMinHHMM(fromMin), fromMinHHMM(toMin))
    },
  })

  // Drag-on-event: move (drag body) or resize (drag bottom 8px). Same
  // hook as DayView; the visual delta lives on the event itself.
  const dragEv = useDragEvent({
    snapMin: 30,
    onClickThrough: (ev, x, y) => interactions.onEventClick?.(ev, x, y),
    onCommit: (info) => interactions.onEventDragCommit?.(info),
  })

  function handleColMouseDown (date, e) {
    const rect = colRefs.current[date]?.getBoundingClientRect()
    drag.start(e, { rect, date, hourHeight: HOUR_HEIGHT })
  }
  function handleColContextMenu (date, e) {
    if (e.target.closest('[data-event-id]')) return
    e.preventDefault()
    const rect = colRefs.current[date]?.getBoundingClientRect()
    if (!rect) return
    interactions.onSlotContextMenu?.(date, topOfHourAtY(e.clientY - rect.top), e.clientX, e.clientY)
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{
        display: 'grid', gridTemplateColumns: HOUR_PAD_LEFT + 'px repeat(7, 1fr)',
        borderBottom: `1px solid ${tokens.border}`, background: tokens.bg,
      }}>
        <div />
        {days.map(d => {
          const [y, mo, dd] = d.split('-').map(Number)
          const isToday = d === today
          const isSelected = d === selectedDate
          return (
            <button key={d} onClick={() => setSelectedDate(d)} style={{
              padding: '8px 0', borderLeft: `1px solid ${tokens.border}`,
              background: 'transparent', border: 'none', borderLeftColor: tokens.border,
              color: isToday ? tokens.accent : tokens.text,
              fontWeight: isSelected ? 600 : 400, fontSize: 12,
              cursor: 'pointer', fontFamily: tokens.font,
            }}>
              <div style={{ fontSize: 10, color: tokens.muted, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                {DOW_FULL[new Date(y, mo - 1, dd).getDay()]}
              </div>
              <div style={{ fontSize: 16, fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>{dd}</div>
            </button>
          )
        })}
      </div>

      <AllDayRow tokens={tokens} days={days} events={events} groupsById={groupsById} myRsvps={myRsvps}
                 interactions={interactions} />

      <div style={{ flex: 1, overflowY: 'auto' }}>
        <div style={{
          display: 'grid', gridTemplateColumns: HOUR_PAD_LEFT + 'px repeat(7, 1fr)',
          height: HOUR_HEIGHT * 24, position: 'relative',
        }}>
          <div style={{ position: 'relative' }}>
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} style={{
                position: 'absolute', top: h * HOUR_HEIGHT, right: 8, fontSize: 11, color: tokens.muted,
                fontVariantNumeric: 'tabular-nums', paddingTop: 2,
              }}>
                {formatHour(h, use24h)}
              </div>
            ))}
          </div>

          {days.map(d => (
            <div key={d}
              ref={el => { if (el) colRefs.current[d] = el }}
              onMouseDown={(e) => handleColMouseDown(d, e)}
              onContextMenu={(e) => handleColContextMenu(d, e)}
              style={{
                position: 'relative', borderLeft: `1px solid ${tokens.border}`, height: HOUR_HEIGHT * 24,
                cursor: 'crosshair',
              }}>
              {Array.from({ length: 24 }, (_, h) => (
                <div key={h} style={{
                  position: 'absolute', top: h * HOUR_HEIGHT, left: 0, right: 0, height: HOUR_HEIGHT,
                  borderTop: `1px solid ${tokens.border}`, pointerEvents: 'none',
                }} />
              ))}
              {eventsForDate(events, d).filter(e => !e.allDay && e.start).map(ev => (
                <PositionedEvent key={ev.id} ev={ev} tokens={tokens} groupsById={groupsById} myRsvps={myRsvps}
                                 use24h={use24h} interactions={interactions}
                                 dragState={dragEv.dragState} onDragStart={dragEv.start} />
              ))}
              {drag.dragRange && drag.dragRange.date === d && (
                <DragPreview tokens={tokens} fromMin={drag.dragRange.from} toMin={drag.dragRange.to} hourHeight={HOUR_HEIGHT} />
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function AllDayRow ({ tokens, days, events, groupsById, myRsvps, interactions }) {
  const perDay = days.map(d => eventsForDate(events, d).filter(e => e.allDay))
  if (perDay.every(arr => arr.length === 0)) return null
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: HOUR_PAD_LEFT + 'px repeat(7, 1fr)',
      borderBottom: `1px solid ${tokens.border}`, background: tokens.bg,
      minHeight: 28,
    }}>
      <div />
      {perDay.map((evs, i) => (
        <div key={i} style={{
          padding: '4px 6px', borderLeft: `1px solid ${tokens.border}`,
          display: 'flex', flexDirection: 'column', gap: 2,
        }}>
          {evs.map(ev => {
            const colors = derivedEventColors(ev, eventGroups(ev, groupsById))
            const declined = myRsvps[ev.id] === 'declined'
            return (
              <div key={ev.id} data-event-id={ev.id}
                onClick={(e) => { e.stopPropagation(); interactions.onEventClick?.(ev, e.clientX, e.clientY) }}
                onContextMenu={(e) => { e.stopPropagation(); e.preventDefault(); interactions.onEventContextMenu?.(ev, e.clientX, e.clientY) }}
                style={{
                  padding: '2px 6px',
                  background: tokens.surface, border: `1px solid ${tokens.border}`,
                  borderRadius: 3, fontSize: 11, fontWeight: 500,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  opacity: declined ? 0.45 : 1,
                  textDecoration: declined ? 'line-through' : 'none',
                  cursor: 'pointer',
                  ...leftStripeStyle(colors, 3),
                }}>
                {ev.title}
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

function PositionedEvent ({ ev, tokens, groupsById, myRsvps, use24h, interactions, dragState, onDragStart }) {
  const startMin = parseTimeToMinutes(ev.start)
  const endMin   = ev.end ? parseTimeToMinutes(ev.end) : startMin + 30
  const isDragged = dragState && dragState.ev.id === ev.id
  let vStart = startMin, vEnd = endMin
  if (isDragged) {
    if (dragState.mode === 'move') {
      vStart = startMin + dragState.deltaMin
      vEnd   = endMin   + dragState.deltaMin
    } else {
      vEnd   = Math.max(startMin + 30, endMin + dragState.deltaMin)
    }
  }
  const top    = (vStart / 60) * HOUR_HEIGHT
  const height = Math.max(20, ((vEnd - vStart) / 60) * HOUR_HEIGHT)
  const colors = derivedEventColors(ev, eventGroups(ev, groupsById))
  const declined = myRsvps[ev.id] === 'declined'
  function onMouseDown (e) { onDragStart?.(e, ev, HOUR_HEIGHT) }
  function onContextMenu (e) { e.stopPropagation(); e.preventDefault(); interactions.onEventContextMenu?.(ev, e.clientX, e.clientY) }
  return (
    <div data-event-id={ev.id} onMouseDown={onMouseDown} onContextMenu={onContextMenu} style={{
      position: 'absolute', top, left: 4, right: 4, height,
      background: tokens.surface, border: `1px solid ${tokens.border}`,
      borderRadius: 4, padding: '2px 6px 2px 8px',
      fontSize: 11, overflow: 'hidden',
      opacity: declined ? 0.45 : (isDragged ? 0.7 : 1),
      cursor: isDragged && dragState.mode === 'resize' ? 'ns-resize' : (isDragged ? 'grabbing' : 'pointer'),
      zIndex: isDragged ? 10 : 1,
      ...leftStripeStyle(colors, 3),
    }}>
      <div style={{
        fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        textDecoration: declined ? 'line-through' : 'none', pointerEvents: 'none',
      }}>
        {ev.title}
      </div>
      {height >= 30 && (
        <div style={{ color: tokens.muted, fontSize: 10, fontVariantNumeric: 'tabular-nums', pointerEvents: 'none' }}>
          {formatTime(ev.start, use24h)}
        </div>
      )}
      <div style={{
        position: 'absolute', left: 0, right: 0, bottom: 0, height: 8,
        cursor: 'ns-resize', pointerEvents: 'none',
      }} />
    </div>
  )
}
