// Avatar + name footer at the bottom of the sidebar. The avatar/name
// region opens Profile; the info button opens About; the gear opens
// Settings. Stop-propagation on the trailing buttons keeps them from
// triggering the row-level click that would otherwise also open Profile.

export function ProfileFooter ({ tokens, profile, onClick, onOpenSettings, onOpenAbout }) {
  const isPhoto = profile.avatar?.startsWith?.('data:')
  // Mobile parity: when no photo and no emoji, fall back to the first letter
  // of the user's name. Empty/whitespace avatar falls through to the letter.
  const fallback = (profile.avatar?.trim()) || (profile.name?.trim()?.[0]?.toUpperCase() ?? '?')
  return (
    <footer style={{
      padding: '9px 14px', borderTop: `1px solid ${tokens.border}`,
      display: 'flex', alignItems: 'center', gap: 10,
    }}>
      <div
        data-clickable={onClick ? '' : undefined}
        onClick={onClick}
        title={onClick ? 'Edit profile' : undefined}
        style={{
          flex: 1, minWidth: 0,
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '4px 6px', margin: '-4px -6px',
          borderRadius: 5,
          cursor: onClick ? 'pointer' : 'default',
        }}>
        <div style={{
          width: 30, height: 30, borderRadius: '50%',
          background: tokens.accent, color: tokens.bg,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 13, fontWeight: 600, overflow: 'hidden', flexShrink: 0,
        }}>
          {isPhoto
            ? <img src={profile.avatar} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            : fallback}
        </div>
        <div style={{ overflow: 'hidden', minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {profile.name ?? 'Unnamed'}
          </div>
        </div>
      </div>
      {onOpenAbout && (
        <button onClick={(e) => { e.stopPropagation(); onOpenAbout() }}
                title="About PearCal"
                aria-label="About PearCal"
                style={{
                  background: 'transparent', border: `1px solid ${tokens.muted}`,
                  fontSize: 13, fontWeight: 600, cursor: 'pointer', color: tokens.muted,
                  width: 22, height: 22, lineHeight: '20px', textAlign: 'center',
                  borderRadius: '50%', fontFamily: tokens.font,
                  flexShrink: 0, padding: 0,
                }}>i</button>
      )}
      {onOpenSettings && (
        <button onClick={(e) => { e.stopPropagation(); onOpenSettings() }}
                data-tour="sidebar-settings"
                title="Settings (Ctrl+,)"
                aria-label="Settings"
                style={{
                  background: 'transparent', border: 'none',
                  fontSize: 28, cursor: 'pointer', color: tokens.muted,
                  padding: '2px 6px', borderRadius: 5, fontFamily: tokens.font,
                  lineHeight: 1, flexShrink: 0,
                }}>⚙</button>
      )}
    </footer>
  )
}
