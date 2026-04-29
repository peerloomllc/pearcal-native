// Groups list with per-group visibility checkboxes. Toggle hides a
// group's events from all main-pane views without touching the
// underlying data.

export function GroupList ({ tokens, groups, isVisible, toggle }) {
  return (
    <div style={{ padding: '12px 16px', flex: 1, overflowY: 'auto', minHeight: 0 }}>
      <div style={{
        fontSize: 11, fontWeight: 500, color: tokens.muted,
        textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8,
      }}>
        Groups
      </div>
      {groups.length === 0 && (
        <div style={{ fontSize: 13, color: tokens.muted, fontWeight: 300 }}>
          No groups yet
        </div>
      )}
      {groups.map(g => {
        const visible = isVisible(g.id)
        return (
          <button key={g.id}
            onClick={() => toggle(g.id)}
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '6px 4px', width: '100%',
              background: 'transparent', border: 'none',
              color: tokens.text, fontFamily: tokens.font,
              fontSize: 13, fontWeight: 400,
              cursor: 'pointer',
              opacity: visible ? 1 : 0.4,
              textAlign: 'left',
            }}>
            <div style={{
              width: 12, height: 12, borderRadius: 3,
              background: visible ? (g.color ?? tokens.muted) : 'transparent',
              border: `1px solid ${g.color ?? tokens.muted}`,
              flexShrink: 0,
            }} />
            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
              {g.emoji ? g.emoji + ' ' : ''}{g.name}
            </div>
          </button>
        )
      })}
    </div>
  )
}
