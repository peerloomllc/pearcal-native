// Sidebar stub for D2 — profile footer + group list. D3 adds the mini
// month picker and group visibility toggles. Width is fixed at 240px;
// scrolls independently of the main grid.

const SIDEBAR_WIDTH = 240

export function Sidebar ({ tokens, profile, groups, selectedDate, setSelectedDate }) {
  return (
    <aside style={{
      width: SIDEBAR_WIDTH, flexShrink: 0,
      background: tokens.surface, borderRight: `1px solid ${tokens.border}`,
      display: 'flex', flexDirection: 'column',
    }}>
      <header style={{ padding: '20px 16px 12px', borderBottom: `1px solid ${tokens.border}` }}>
        <div style={{ fontSize: 18, fontWeight: 600, letterSpacing: '-0.01em' }}>🍐 PearCal</div>
      </header>

      <div style={{
        padding: '16px',
        flex: 1, overflowY: 'auto', minHeight: 0,
      }}>
        <div style={{ fontSize: 11, fontWeight: 500, color: tokens.muted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
          Groups
        </div>
        {groups.length === 0 && (
          <div style={{ fontSize: 13, color: tokens.muted, fontWeight: 300 }}>
            No groups yet
          </div>
        )}
        {groups.map(g => (
          <div key={g.id} style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '6px 4px', fontSize: 13, fontWeight: 400,
          }}>
            <div style={{
              width: 10, height: 10, borderRadius: 3,
              background: g.color ?? tokens.muted,
            }} />
            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {g.emoji ? g.emoji + ' ' : ''}{g.name}
            </div>
          </div>
        ))}
      </div>

      <footer style={{
        padding: '12px 16px', borderTop: `1px solid ${tokens.border}`,
        display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <div style={{
          width: 32, height: 32, borderRadius: '50%',
          background: tokens.accent, color: tokens.bg,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 13, fontWeight: 600,
        }}>
          {profile.avatar?.startsWith?.('data:') ? null : (profile.avatar ?? '?')}
          {profile.avatar?.startsWith?.('data:') && (
            <img src={profile.avatar} alt="" style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover' }} />
          )}
        </div>
        <div style={{ overflow: 'hidden', minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {profile.name ?? 'Unnamed'}
          </div>
        </div>
      </footer>
    </aside>
  )
}
