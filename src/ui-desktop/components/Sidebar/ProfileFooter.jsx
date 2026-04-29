// Avatar + name footer at the bottom of the sidebar. Click anywhere on
// the row to open the profile editor (D7.1).

export function ProfileFooter ({ tokens, profile, onClick }) {
  const isPhoto = profile.avatar?.startsWith?.('data:')
  return (
    <footer
      data-clickable={onClick ? '' : undefined}
      onClick={onClick}
      title={onClick ? 'Edit profile' : undefined}
      style={{
        padding: '11px 14px', borderTop: `1px solid ${tokens.border}`,
        display: 'flex', alignItems: 'center', gap: 10,
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
          : (profile.avatar ?? '?')}
      </div>
      <div style={{ overflow: 'hidden', minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {profile.name ?? 'Unnamed'}
        </div>
      </div>
    </footer>
  )
}
