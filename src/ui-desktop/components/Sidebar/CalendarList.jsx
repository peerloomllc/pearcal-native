// Personal calendars and holiday countries, above Groups in the sidebar
// (TODO #189). Click a row to show or hide it on this device; right-click a
// personal calendar to rename, recolor or delete it.

export function CalendarList ({ tokens, cal, web, onNewCalendar, onCalendarContextMenu, onNewWebCalendar, onWebCalendarContextMenu }) {
  const headerBtn = {
    background: 'transparent', border: 'none',
    fontSize: 16, fontWeight: 600, cursor: 'pointer', color: tokens.muted,
    padding: '2px 6px', borderRadius: 4, fontFamily: tokens.font, lineHeight: 1,
  }
  const heading = {
    flex: 1, fontSize: 11, fontWeight: 600, color: tokens.muted,
    textTransform: 'uppercase', letterSpacing: '0.08em',
  }
  const row = (key, name, color, onContextMenu, prefix) => {
    const visible = !cal.isHidden(key)
    return (
      <button key={key}
        onClick={() => cal.toggle(key)}
        onContextMenu={onContextMenu ? (e) => { e.preventDefault(); onContextMenu(e.clientX, e.clientY) } : undefined}
        title={visible ? 'Hide on this device' : 'Show on this device'}
        style={{
          display: 'flex', alignItems: 'center', gap: 9,
          padding: '5px 4px', width: '100%',
          background: 'transparent', border: 'none', borderRadius: 4,
          color: tokens.text, fontFamily: tokens.font, fontSize: 13, fontWeight: 400,
          cursor: 'pointer', opacity: visible ? 1 : 0.4, textAlign: 'left',
        }}>
        <div style={{
          width: 11, height: 11, borderRadius: 2,
          background: visible ? (color ?? tokens.muted) : 'transparent',
          border: `1px solid ${color ?? tokens.muted}`, flexShrink: 0,
        }} />
        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
          {prefix ? prefix + ' ' : ''}{name}
        </div>
      </button>
    )
  }
  return (
    <div style={{ padding: '10px 14px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 6 }}>
        <div style={heading}>Personal</div>
        {onNewCalendar && (
          <button onClick={onNewCalendar} title="New calendar" aria-label="New calendar" style={headerBtn}>+</button>
        )}
      </div>
      {cal.calendars.map(c => row('personal:' + c.id, c.name, c.color, onCalendarContextMenu
        ? (x, y) => onCalendarContextMenu(c, x, y) : null))}
      {web?.supported && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, margin: '10px 0 6px' }}>
            <div style={heading}>Web calendars</div>
            {onNewWebCalendar && (
              <button onClick={onNewWebCalendar} title="Add a web calendar" aria-label="Add a web calendar" style={headerBtn}>+</button>
            )}
          </div>
          {web.subscriptions.map(sb => row('sub:' + sb.id, sb.name || 'Web calendar', sb.color,
            onWebCalendarContextMenu ? (x, y) => onWebCalendarContextMenu(sb, x, y) : null,
            web.feeds[sb.id]?.error ? '⚠' : null))}
        </>
      )}
      {cal.holidayCalendars.length > 0 && (
        <>
          <div style={{ ...heading, margin: '10px 0 6px' }}>Holidays</div>
          {cal.holidayCalendars.map(h => row(h.key, h.name, h.color, null, h.flag))}
        </>
      )}
    </div>
  )
}
