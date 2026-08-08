// Groups list with per-group visibility checkboxes. Toggle hides a
// group's events from all main-pane views without touching the
// underlying data. Right-click a row to open the group's context
// menu (settings / leave / delete). The header carries "+ new group"
// + "join group" affordances so onboarding doesn't require diving
// into the command palette.

// #163 - a row marker for a calendar that is in trouble. The full explanation
// lives in the shared notices inside group settings; a sidebar row is one line
// tall and cannot carry it, but going completely silent is what let a broken
// calendar look identical to a quiet one on desktop. The glyph is the way in.
function troubleWith (g, pendingApprovalGroups) {
  if (g?.keyless) {
    return g.keyless.certainty === 'certain'
      ? "Can't sync on this device - open group settings"
      : "Hasn't synced since you joined - open group settings"
  }
  if (g?.syncHealth?.state === 'stale') return "Hasn't synced in a while - open group settings"
  if (pendingApprovalGroups?.has?.(g?.id)) return 'Waiting for owner approval - open group settings'
  return null
}

export function GroupList ({ tokens, groups, isVisible, toggle, onContextMenu, onNewGroup, onJoinGroup, pendingApprovalGroups }) {
  const headerBtn = {
    background: 'transparent', border: 'none',
    fontSize: 13, cursor: 'pointer', color: tokens.muted,
    padding: '2px 6px', borderRadius: 4, fontFamily: tokens.font,
    lineHeight: 1,
  }
  return (
    <div style={{ padding: '10px 14px', flex: 1, overflowY: 'auto', minHeight: 0 }}>
      <div data-tour="sidebar-add-group" style={{
        display: 'flex', alignItems: 'center', gap: 4, marginBottom: 6,
      }}>
        <div style={{
          flex: 1, fontSize: 11, fontWeight: 600, color: tokens.muted,
          textTransform: 'uppercase', letterSpacing: '0.08em',
        }}>
          Groups
        </div>
        {onJoinGroup && (
          <button onClick={onJoinGroup} title="Join a group" aria-label="Join a group" style={headerBtn}>↘</button>
        )}
        {onNewGroup && (
          <button onClick={onNewGroup} title="New group" aria-label="New group"
                  style={{ ...headerBtn, fontSize: 16, fontWeight: 600 }}>+</button>
        )}
      </div>
      {groups.length === 0 && (
        <div style={{ fontSize: 13, color: tokens.muted, fontWeight: 300 }}>
          No groups yet
        </div>
      )}
      {groups.map(g => {
        const visible = isVisible(g.id)
        const hasIcon = typeof g.icon === 'string' && g.icon.startsWith('data:')
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
            {hasIcon ? (
              <div style={{
                width: 18, height: 18, borderRadius: 4,
                border: `1px solid ${g.color ?? tokens.muted}`,
                overflow: 'hidden', flexShrink: 0,
              }}>
                <img src={g.icon} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              </div>
            ) : (
              <div style={{
                width: 11, height: 11, borderRadius: 2,
                background: visible ? (g.color ?? tokens.muted) : 'transparent',
                border: `1px solid ${g.color ?? tokens.muted}`,
                flexShrink: 0,
              }} />
            )}
            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
              {!hasIcon && g.emoji ? g.emoji + ' ' : ''}{g.name}
            </div>
            {(() => {
              const trouble = troubleWith(g, pendingApprovalGroups)
              if (!trouble) return null
              return (
                <span title={trouble} aria-label={trouble}
                  style={{ flexShrink: 0, color: g.keyless ? '#E5484D' : '#F5A623', fontSize: 12, lineHeight: 1 }}>
                  ▲
                </span>
              )
            })()}
          </button>
        )
      })}
    </div>
  )
}
