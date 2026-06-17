// Month view — 6×7 grid of day cells. Each cell shows up to N event
// chips with a "+N more" overflow link. Click a day cell → main pane
// jumps to Day view for that date (handled by setSelectedDate +
// setMode at the App level via the prop).

import { useMemo } from 'react'
import { derivedEventColors, leftStripeStyle } from '../../ui-shared/index.js'
import { buildRowItems, packLanes, overflowByColumn } from '../lib/multiDayLanes.js'

const DOW_FULL = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
// Vertical budget per week-row: a day-number header, then up to this many
// event lanes, then a per-day "+N more" overflow line.
const MAX_LANES = 3
const DAYNUM_H = 20
const LANE_H = 17

function fmt (y, m, d) {
  return y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0')
}

function todayLocal () {
  const t = new Date()
  return fmt(t.getFullYear(), t.getMonth(), t.getDate())
}

function eventGroups (ev, groupsById) {
  return (ev.groups ?? []).map(id => groupsById.get(id)).filter(Boolean)
}

export function MonthView ({ tokens, events, groupsById, myRsvps, selectedDate, setSelectedDate, setMode, weekStart = 0, navDir = 0, interactions = {} }) {
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

  const slideClass = navDir > 0 ? 'pearcal-nav-forward'
                  : navDir < 0 ? 'pearcal-nav-back'
                  : ''
  // Key on year-month so within-month date changes (clicking a different
  // day in the same month) don't trigger a re-mount + animation.
  const monthKey = cy + '-' + cm
  return (
    <div key={monthKey} className={slideClass}
         style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
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
          <WeekRow key={row} tokens={tokens}
                   cells={cells.slice(row * 7, row * 7 + 7)}
                   today={today} selectedDate={selectedDate}
                   events={events} groupsById={groupsById} myRsvps={myRsvps}
                   lastRow={row === 5} interactions={interactions}
                   onDayClick={d => { setSelectedDate(d); setMode?.('day') }} />
        ))}
      </div>
    </div>
  )
}

// One week (7 day cells). Renders two stacked layers: a background grid of
// clickable day cells (day number + today/selected wash + empty-slot context
// menu), and an absolutely-positioned overlay of event lanes. Multi-day events
// occupy a single bar spanning their columns instead of repeating per cell.
function WeekRow ({ tokens, cells, today, selectedDate, events, groupsById, myRsvps, lastRow, onDayClick, interactions }) {
  const rowDates = cells.map(c => c.date)
  const { lanes, overflow } = useMemo(() => {
    const items = buildRowItems(events, rowDates)
    const packed = packLanes(items)
    return { lanes: packed, overflow: overflowByColumn(packed, MAX_LANES, rowDates.length) }
  }, [events, rowDates.join(',')])

  const visibleLanes = lanes.slice(0, MAX_LANES)

  function onCellContextMenu (date, e) {
    if (e.target.closest('[data-event-id]')) return
    e.preventDefault()
    interactions.onSlotContextMenu?.(date, '', e.clientX, e.clientY)
  }

  return (
    <div style={{
      position: 'relative',
      borderBottom: lastRow ? 'none' : `1px solid ${tokens.border}`,
      overflow: 'hidden', minHeight: 0,
    }}>
      {/* Background: clickable day cells */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', height: '100%' }}>
        {cells.map((cell, col) => {
          const isToday = cell.date === today
          const isSelected = cell.date === selectedDate
          return (
            <div key={cell.date} data-clickable
              onClick={() => onDayClick(cell.date)}
              onContextMenu={(e) => onCellContextMenu(cell.date, e)}
              style={{
                borderLeft: col > 0 ? `1px solid ${tokens.border}` : 'none',
                padding: '4px 6px', cursor: 'pointer', minHeight: 0,
                background: isToday || isSelected ? tokens.surface : 'transparent',
              }}>
              <div style={{
                fontSize: 12, fontWeight: isToday ? 600 : 400,
                color: cell.inMonth ? (isToday ? tokens.accent : tokens.text) : tokens.muted,
                fontVariantNumeric: 'tabular-nums',
              }}>
                {cell.day}
              </div>
            </div>
          )
        })}
      </div>

      {/* Overlay: spanning event lanes + per-day overflow. pointerEvents:none
          lets clicks on empty space fall through to the day cells below; bars
          and "+N more" re-enable their own pointer events. */}
      <div style={{
        position: 'absolute', top: DAYNUM_H, left: 0, right: 0, bottom: 0,
        pointerEvents: 'none',
      }}>
        {visibleLanes.map((lane, li) => (
          <div key={li} style={{
            display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', height: LANE_H, marginBottom: 1,
          }}>
            {lane.map(seg => {
              const ev = seg.ev
              const colors = derivedEventColors(ev, eventGroups(ev, groupsById))
              const declined = myRsvps[ev.id] === 'declined'
              return (
                <div key={ev.id} data-event-id={ev.id}
                  onClick={(e) => { e.stopPropagation(); interactions.onEventClick?.(ev, e.clientX, e.clientY) }}
                  onContextMenu={(e) => { e.stopPropagation(); e.preventDefault(); interactions.onEventContextMenu?.(ev, e.clientX, e.clientY) }}
                  style={{
                    gridColumn: `${seg.startCol + 1} / ${seg.endCol + 2}`,
                    margin: '0 3px', pointerEvents: 'auto', boxSizing: 'border-box',
                    fontSize: 11, lineHeight: `${LANE_H - 2}px`, padding: '0 6px 0 8px',
                    // Color lives in a left-edge stripe over a solid surface so
                    // the title stays legible (multi-color events like US
                    // holidays' red/white/blue show all segments in the stripe).
                    // Matches the Day/Week event treatment.
                    background: tokens.surface,
                    border: `1px solid ${tokens.border}`,
                    color: tokens.text,
                    borderTopLeftRadius: seg.continuesLeft ? 0 : 3,
                    borderBottomLeftRadius: seg.continuesLeft ? 0 : 3,
                    borderTopRightRadius: seg.continuesRight ? 0 : 3,
                    borderBottomRightRadius: seg.continuesRight ? 0 : 3,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    opacity: declined ? 0.5 : 1,
                    textDecoration: declined ? 'line-through' : 'none',
                    cursor: 'pointer',
                    ...leftStripeStyle(colors, 3),
                  }}>
                  {seg.continuesLeft ? '◂ ' : ''}{ev.title}
                </div>
              )
            })}
          </div>
        ))}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)' }}>
          {overflow.map((n, col) => n > 0 ? (
            <div key={col} data-clickable
              onClick={(e) => { e.stopPropagation(); onDayClick(rowDates[col]) }}
              style={{
                gridColumn: `${col + 1} / ${col + 2}`, pointerEvents: 'auto',
                fontSize: 10, color: tokens.muted, padding: '0 6px', cursor: 'pointer',
              }}>
              +{n} more
            </div>
          ) : null)}
        </div>
      </div>
    </div>
  )
}
