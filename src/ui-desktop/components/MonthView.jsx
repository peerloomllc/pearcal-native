// Month view — 6×7 grid of day cells. Each cell shows up to N event
// chips with a "+N more" overflow link. Click a day cell → main pane
// jumps to Day view for that date (handled by setSelectedDate +
// setMode at the App level via the prop).

import { useMemo } from 'react'
import { derivedEventColors, expandRecurring } from '../../ui-shared/index.js'

const DOW_FULL = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
const MAX_CHIPS_PER_CELL = 3

function fmt (y, m, d) {
  return y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0')
}

function todayLocal () {
  const t = new Date()
  return fmt(t.getFullYear(), t.getMonth(), t.getDate())
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
  // All-day events first, then sorted by start time
  out.sort((a, b) => {
    if (a.allDay && !b.allDay) return -1
    if (!a.allDay && b.allDay) return 1
    return (a.start ?? '').localeCompare(b.start ?? '')
  })
  return out
}

function eventGroups (ev, groupsById) {
  return (ev.groups ?? []).map(id => groupsById.get(id)).filter(Boolean)
}

export function MonthView ({ tokens, events, groupsById, myRsvps, selectedDate, setSelectedDate, setMode, weekStart = 0, interactions = {} }) {
  const [cy, cmRaw] = selectedDate.split('-').map(Number)
  const cm = cmRaw - 1
  const today = todayLocal()

  const cells = useMemo(() => {
    const first = new Date(cy, cm, 1)
    const startOffset = (first.getDay() - weekStart + 7) % 7
    const start = new Date(cy, cm, 1 - startOffset)
    const out = []
    for (let i = 0; i < 42; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)
      out.push({
        date: fmt(d.getFullYear(), d.getMonth(), d.getDate()),
        day: d.getDate(),
        inMonth: d.getMonth() === cm,
      })
    }
    return out
  }, [cy, cm, weekStart])

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* DOW header */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)',
        borderBottom: `1px solid ${tokens.border}`, background: tokens.bg,
      }}>
        {Array.from({ length: 7 }, (_, i) => {
          const dowIdx = (weekStart + i) % 7
          return (
            <div key={i} style={{
              padding: '6px 0', textAlign: 'center',
              fontSize: 10, fontWeight: 500, color: tokens.muted,
              textTransform: 'uppercase', letterSpacing: '0.06em',
              borderLeft: i > 0 ? `1px solid ${tokens.border}` : 'none',
            }}>
              {DOW_FULL[dowIdx]}
            </div>
          )
        })}
      </div>

      {/* 6-row grid */}
      <div style={{ flex: 1, display: 'grid', gridTemplateRows: 'repeat(6, 1fr)', overflow: 'hidden' }}>
        {Array.from({ length: 6 }, (_, row) => (
          <div key={row} style={{
            display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)',
            borderBottom: row < 5 ? `1px solid ${tokens.border}` : 'none',
            minHeight: 0,
          }}>
            {cells.slice(row * 7, row * 7 + 7).map((cell, col) => (
              <Cell key={cell.date} tokens={tokens} cell={cell}
                    today={today} selectedDate={selectedDate}
                    events={eventsForDate(events, cell.date)}
                    groupsById={groupsById} myRsvps={myRsvps}
                    borderLeft={col > 0}
                    interactions={interactions}
                    onClick={() => { setSelectedDate(cell.date); setMode?.('day') }} />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

function Cell ({ tokens, cell, today, selectedDate, events, groupsById, myRsvps, borderLeft, onClick, interactions }) {
  const isToday = cell.date === today
  const isSelected = cell.date === selectedDate
  const visible = events.slice(0, MAX_CHIPS_PER_CELL)
  const overflow = events.length - visible.length

  function onCellContextMenu (e) {
    if (e.target.closest('[data-event-id]')) return
    e.preventDefault()
    interactions.onSlotContextMenu?.(cell.date, '', e.clientX, e.clientY)
  }

  return (
    <div data-clickable onClick={onClick} onContextMenu={onCellContextMenu}
      style={{
        borderLeft: borderLeft ? `1px solid ${tokens.border}` : 'none',
        padding: '4px 6px', overflow: 'hidden',
        background: isSelected ? tokens.border : 'transparent',
        cursor: 'pointer',
        display: 'flex', flexDirection: 'column', gap: 2, minHeight: 0,
      }}>
      <div style={{
        fontSize: 11, fontWeight: isToday ? 600 : 400,
        color: cell.inMonth ? (isToday ? tokens.accent : tokens.text) : tokens.muted,
        fontVariantNumeric: 'tabular-nums', flexShrink: 0,
      }}>
        {cell.day}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1, overflow: 'hidden', flex: 1, minHeight: 0 }}>
        {visible.map(ev => {
          const colors = derivedEventColors(ev, eventGroups(ev, groupsById))
          const declined = myRsvps[ev.id] === 'declined'
          return (
            <div key={ev.id} data-event-id={ev.id}
              onClick={(e) => { e.stopPropagation(); interactions.onEventClick?.(ev, e.clientX, e.clientY) }}
              onContextMenu={(e) => { e.stopPropagation(); e.preventDefault(); interactions.onEventContextMenu?.(ev, e.clientX, e.clientY) }}
              style={{
                fontSize: 11, padding: '1px 6px',
                background: colors[0] ?? tokens.muted,
                color: tokens.bg,
                borderRadius: 2,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                opacity: declined ? 0.5 : 1,
                textDecoration: declined ? 'line-through' : 'none',
                cursor: 'pointer',
              }}>
              {ev.title}
            </div>
          )
        })}
        {overflow > 0 && (
          <div style={{ fontSize: 10, color: tokens.muted, padding: '0 6px' }}>
            +{overflow} more
          </div>
        )}
      </div>
    </div>
  )
}
