// Compact month grid in the sidebar. Click any cell → main pane jumps
// to that date (and switches to Day view via the Toolbar's mode state).
// Cursor is controlled by useViewState (so the Toolbar's Today button
// can re-sync it from any drift state); the ‹ › nav buttons let the
// user browse months independently of the main view.

import { useEffect, useRef, useState, useMemo } from 'react'

const DOW = ['S','M','T','W','T','F','S']
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

function todayLocal () {
  const t = new Date()
  return { y: t.getFullYear(), m: t.getMonth(), d: t.getDate() }
}

function fmt (y, m, d) {
  return y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0')
}

export function MiniMonth ({ tokens, selectedDate, setSelectedDate, cursor, setCursor }) {
  const today = todayLocal()
  const todayStr = fmt(today.y, today.m, today.d)

  // Direction for the slide animation. Tracked via a ref of the previous
  // cursor + a state that drives the className. Updates whether the
  // change came from a ‹ › click here or from a parent setMiniCursor
  // call (toolbar arrow / Today button).
  const prevCursorRef = useRef(cursor)
  const [navDir, setNavDir] = useState(0)
  useEffect(() => {
    const prev = prevCursorRef.current
    if (prev.y === cursor.y && prev.m === cursor.m) return
    const prevAbs = prev.y * 12 + prev.m
    const nextAbs = cursor.y * 12 + cursor.m
    setNavDir(nextAbs > prevAbs ? 1 : -1)
    prevCursorRef.current = cursor
  }, [cursor])

  const cells = useMemo(() => {
    const first = new Date(cursor.y, cursor.m, 1)
    const startWeekday = first.getDay()  // 0 = Sun
    const daysInMonth = new Date(cursor.y, cursor.m + 1, 0).getDate()
    const out = []
    // Lead with empty slots for prev-month days
    for (let i = 0; i < startWeekday; i++) out.push(null)
    for (let d = 1; d <= daysInMonth; d++) out.push(d)
    // Always pad to 7 rows (49 cells) so the sidebar's GroupList stays
    // anchored at a fixed vertical position regardless of the month's
    // layout. Months only ever need 4-6 rows of cells; the trailing
    // empty row keeps a consistent buffer.
    while (out.length < 49) out.push(null)
    return out
  }, [cursor])

  const monthLabel = MONTHS[cursor.m] + ' ' + cursor.y

  const navBtn = {
    background: 'transparent', border: 'none', color: tokens.muted,
    fontSize: 15, cursor: 'pointer', padding: '2px 6px', borderRadius: 4,
    fontFamily: tokens.font,
  }

  const slideClass = navDir > 0 ? 'pearcal-nav-forward'
                  : navDir < 0 ? 'pearcal-nav-back'
                  : ''

  return (
    <div style={{ padding: '10px 14px', borderBottom: `1px solid ${tokens.border}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 6 }}>
        <button style={navBtn}
                onClick={() => setCursor(cursor.m === 0 ? { y: cursor.y - 1, m: 11 } : { y: cursor.y, m: cursor.m - 1 })}
                aria-label="Previous month">‹</button>
        <div style={{ flex: 1, textAlign: 'center', fontSize: 12, fontWeight: 600 }}>{monthLabel}</div>
        <button style={navBtn}
                onClick={() => setCursor(cursor.m === 11 ? { y: cursor.y + 1, m: 0 } : { y: cursor.y, m: cursor.m + 1 })}
                aria-label="Next month">›</button>
      </div>

      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2,
        fontSize: 11, color: tokens.muted, marginBottom: 4,
      }}>
        {DOW.map((d, i) => (
          <div key={i} style={{ textAlign: 'center', fontWeight: 500, padding: '2px 0' }}>{d}</div>
        ))}
      </div>

      <div key={cursor.y + '-' + cursor.m} className={slideClass}
           style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }}>
        {cells.map((d, i) => {
          // Empty padding cells need the same aspectRatio as buttons,
          // otherwise an entire all-null row would collapse to 0 height
          // (CSS grid auto-sizes rows to their tallest cell, and an
          // empty <div /> has no intrinsic height).
          if (d === null) return <div key={i} style={{ aspectRatio: '1 / 1' }} />
          const dateStr = fmt(cursor.y, cursor.m, d)
          const isToday    = dateStr === todayStr
          const isSelected = dateStr === selectedDate
          return (
            <button key={i}
              onClick={() => setSelectedDate(dateStr)}
              style={{
                aspectRatio: '1 / 1',
                background: isSelected ? tokens.accent : (isToday ? tokens.border : 'transparent'),
                color: isSelected ? tokens.bg : tokens.text,
                border: 'none', borderRadius: 4,
                fontSize: 12, fontWeight: isSelected ? 600 : 400,
                cursor: 'pointer',
                fontFamily: tokens.font,
                fontVariantNumeric: 'tabular-nums',
              }}>
              {d}
            </button>
          )
        })}
      </div>
    </div>
  )
}
