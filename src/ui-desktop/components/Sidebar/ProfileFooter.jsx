// Avatar + name footer at the bottom of the sidebar. D7 wires the
// settings/profile-edit modals to a click on this row.

export function ProfileFooter ({ tokens, profile }) {
  const isPhoto = profile.avatar?.startsWith?.('data:')
  return (
    <footer style={{
      padding: '10px 14px', borderTop: `1px solid ${tokens.border}`,
      display: 'flex', alignItems: 'center', gap: 9,
    }}>
      <div style={{
        width: 28, height: 28, borderRadius: '50%',
        background: tokens.accent, color: tokens.bg,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 12, fontWeight: 600, overflow: 'hidden', flexShrink: 0,
      }}>
        {isPhoto
          ? <img src={profile.avatar} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          : (profile.avatar ?? '?')}
      </div>
      <div style={{ overflow: 'hidden', minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {profile.name ?? 'Unnamed'}
        </div>
      </div>
    </footer>
  )
}
