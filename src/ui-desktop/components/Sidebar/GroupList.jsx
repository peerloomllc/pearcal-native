// Groups list with per-group visibility checkboxes. Toggle hides a
// group's events from all main-pane views without touching the
// underlying data. Right-click a row to open the group's context
// menu (settings / leave / delete) — the menu items live up at the
// App level since they need access to the group-mutation handlers.

export function GroupList ({ tokens, groups, isVisible, toggle, onContextMenu }) {
  return (
    <div style={{ padding: '10px 14px', flex: 1, overflowY: 'auto', minHeight: 0 }}>
      <div style={{
        fontSize: 11, fontWeight: 600, color: tokens.muted,
        textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6,
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
            onContextMenu={(e) => {
              if (!onContextMenu) return
              e.preventDefault()
              onContextMenu(g, e.clientX, e.clientY)
            }}
            style={{
              display: 'flex', alignItems: 'center', gap: 9,
              padding: '5px 4px', width: '100%',
              background: 'transparent', border: 'none', borderRadius: 4,
              color: tokens.text, fontFamily: tokens.font,
              fontSize: 13, fontWeight: 400,
              cursor: 'pointer',
              opacity: visible ? 1 : 0.4,
              textAlign: 'left',
            }}>
            <div style={{
              width: 11, height: 11, borderRadius: 2,
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
