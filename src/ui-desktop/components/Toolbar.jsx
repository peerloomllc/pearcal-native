// Top toolbar — date navigation (< Today >) + view mode tabs. Arrows
// route through useViewState's navigateBy so the view component can
// slide the new period in from the matching side. The arrow stride
// (1 day vs 7 days vs 1 month) is decided inside navigateBy based on
// the active mode.

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']
const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']

function todayLocal () {
  const t = new Date()
  return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0')
}

function formatDateHeader (dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  return DAYS[dt.getDay()] + ', ' + MONTHS[dt.getMonth()] + ' ' + dt.getDate() + ', ' + dt.getFullYear()
}

export function Toolbar ({ tokens, selectedDate, setSelectedDate, mode, setMode, navigateBy, goToToday, isFullyToday, onCreate }) {
  // Today button is enabled when EITHER the main view OR the mini-month
  // sidebar has drifted from today. So a user who browsed the mini's
  // cursor away can still hit Today to re-sync, even when the main view
  // is on today.
  const todayDisabled = !!isFullyToday

  const btn = {
    background: 'transparent', border: `1px solid ${tokens.border}`, color: tokens.text,
    padding: '5px 11px', fontSize: 13, fontWeight: 400,
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
      <button style={btn}
              onClick={() => navigateBy?.(-1)}
              aria-label={mode === 'month' ? 'Previous month' : mode === 'week' ? 'Previous week' : 'Previous day'}>←</button>
      <button style={{ ...btn, opacity: todayDisabled ? 0.5 : 1, cursor: todayDisabled ? 'default' : 'pointer' }}
              onClick={() => { if (todayDisabled) return; (goToToday ?? (() => setSelectedDate(todayLocal())))() }}>
        Today
      </button>
      <button style={btn}
              onClick={() => navigateBy?.(1)}
              aria-label={mode === 'month' ? 'Next month' : mode === 'week' ? 'Next week' : 'Next day'}>→</button>

      <div style={{
        flex: 1, fontSize: 14, fontWeight: 600, letterSpacing: '-0.01em',
        textAlign: 'center',
      }}>
        {formatDateHeader(selectedDate)}
      </div>

      <div data-tour="toolbar-views" style={{ display: 'flex', gap: 4 }}>
        <button style={tabBtn(mode === 'day')}   onClick={() => setMode('day')}>Day</button>
        <button style={tabBtn(mode === 'week')}  onClick={() => setMode('week')}>Week</button>
        <button style={tabBtn(mode === 'month')} onClick={() => setMode('month')}>Month</button>
      </div>

      {onCreate && (
        <button data-tour="toolbar-create" onClick={onCreate} title="New event (N)"
                style={{ ...btn, marginLeft: 4, background: tokens.accent, color: tokens.bg, borderColor: tokens.accent, fontWeight: 600 }}>
          + New
        </button>
      )}
    </header>
  )
}
