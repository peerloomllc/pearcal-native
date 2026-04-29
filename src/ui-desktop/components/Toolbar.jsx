// Top toolbar — date navigation (← → Today) + view mode tabs.

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']
const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']

function shiftDate (dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  dt.setDate(dt.getDate() + days)
  return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0')
}

function todayLocal () {
  const t = new Date()
  return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0')
}

function formatDateHeader (dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  return DAYS[dt.getDay()] + ', ' + MONTHS[dt.getMonth()] + ' ' + dt.getDate() + ', ' + dt.getFullYear()
}

export function Toolbar ({ tokens, selectedDate, setSelectedDate, mode, setMode, onCreate }) {
  const isToday = selectedDate === todayLocal()

  const btn = {
    background: 'transparent', border: `1px solid ${tokens.border}`, color: tokens.text,
    padding: '4px 10px', fontSize: 12, fontWeight: 400,
    borderRadius: 5, cursor: 'pointer',
    fontFamily: tokens.font,
  }

  const tabBtn = (active) => ({
    ...btn,
    background: active ? tokens.accent : 'transparent',
    color: active ? tokens.bg : tokens.text,
    borderColor: active ? tokens.accent : tokens.border,
    fontWeight: active ? 500 : 400,
  })

  return (
    <header style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '8px 16px', borderBottom: `1px solid ${tokens.border}`,
      background: tokens.bg,
    }}>
      <button style={btn} onClick={() => setSelectedDate(shiftDate(selectedDate, -1))} aria-label="Previous day">←</button>
      <button style={btn} onClick={() => setSelectedDate(shiftDate(selectedDate, 1))} aria-label="Next day">→</button>
      <button style={{ ...btn, opacity: isToday ? 0.5 : 1, cursor: isToday ? 'default' : 'pointer' }}
              onClick={() => !isToday && setSelectedDate(todayLocal())}>
        Today
      </button>

      <div style={{
        flex: 1, fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em',
        textAlign: 'center',
      }}>
        {formatDateHeader(selectedDate)}
      </div>

      <div style={{ display: 'flex', gap: 4 }}>
        <button style={tabBtn(mode === 'day')}   onClick={() => setMode('day')}>Day</button>
        <button style={tabBtn(mode === 'week')}  onClick={() => setMode('week')}>Week</button>
        <button style={tabBtn(mode === 'month')} onClick={() => setMode('month')}>Month</button>
      </div>

      {onCreate && (
        <button onClick={onCreate} title="New event (N)"
                style={{ ...btn, marginLeft: 4, background: tokens.accent, color: tokens.bg, borderColor: tokens.accent, fontWeight: 600 }}>
          + New
        </button>
      )}
    </header>
  )
}
