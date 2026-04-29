// Compact month grid in the sidebar. Click any cell → main pane jumps
// to that date (and switches to Day view via the Toolbar's mode state).
// Has its own month cursor so you can browse forward/back without
// touching the main pane's selectedDate.

import { useState, useMemo } from 'react'

const DOW = ['S','M','T','W','T','F','S']
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

function todayLocal () {
  const t = new Date()
  return { y: t.getFullYear(), m: t.getMonth(), d: t.getDate() }
}

function fmt (y, m, d) {
  return y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0')
}

export function MiniMonth ({ tokens, selectedDate, setSelectedDate }) {
  const today = todayLocal()
  const todayStr = fmt(today.y, today.m, today.d)
  // Cursor — independent of selectedDate so user can browse months
  // without moving the main pane until they actually click a day.
  const [cursor, setCursor] = useState(() => {
    const [y, m] = selectedDate.split('-').map(Number)
    return { y, m: m - 1 }
  })

  const cells = useMemo(() => {
    const first = new Date(cursor.y, cursor.m, 1)
    const startWeekday = first.getDay()  // 0 = Sun
    const daysInMonth = new Date(cursor.y, cursor.m + 1, 0).getDate()
    const out = []
    // Lead with empty slots for prev-month days
    for (let i = 0; i < startWeekday; i++) out.push(null)
    for (let d = 1; d <= daysInMonth; d++) out.push(d)
    // Pad to a multiple of 7 so the grid stays square
    while (out.length % 7) out.push(null)
    return out
  }, [cursor])

  const monthLabel = MONTHS[cursor.m] + ' ' + cursor.y

  const navBtn = {
    background: 'transparent', border: 'none', color: tokens.muted,
    fontSize: 14, cursor: 'pointer', padding: '2px 6px', borderRadius: 4,
    fontFamily: tokens.font,
  }

  return (
    <div style={{ padding: '12px 16px', borderBottom: `1px solid ${tokens.border}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 8 }}>
        <button style={navBtn} onClick={() => setCursor(c => c.m === 0 ? { y: c.y - 1, m: 11 } : { y: c.y, m: c.m - 1 })} aria-label="Previous month">‹</button>
        <div style={{ flex: 1, textAlign: 'center', fontSize: 12, fontWeight: 500 }}>{monthLabel}</div>
        <button style={navBtn} onClick={() => setCursor(c => c.m === 11 ? { y: c.y + 1, m: 0 } : { y: c.y, m: c.m + 1 })} aria-label="Next month">›</button>
      </div>

      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2,
        fontSize: 10, color: tokens.muted, marginBottom: 4,
      }}>
        {DOW.map((d, i) => (
          <div key={i} style={{ textAlign: 'center', fontWeight: 500, padding: '2px 0' }}>{d}</div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }}>
        {cells.map((d, i) => {
          if (d === null) return <div key={i} />
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
                fontSize: 11, fontWeight: isSelected ? 600 : 400,
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
