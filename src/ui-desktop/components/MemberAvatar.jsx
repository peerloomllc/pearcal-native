// Member avatar renderer that handles all three storage shapes used by
// the bare backend:
//   - inline data: URL on the member record (`avatar`)
//   - hash reference (`avatarHash`) that resolves via window.__pearResolveAvatar
//   - emoji or letter character (`avatar` is a short string, no hash)
//
// Mirrors mobile's MemberAvatar (src/ui/App.jsx:1775-1810). The hash path
// is what was missing on desktop — bare's apply hook dedupes inline
// avatars into avatar-hash refs so member rows from peers carry only
// the hash by the time they reach the renderer.

import { useEffect, useState } from 'react'

export function MemberAvatar ({ avatar, avatarHash, name = '?', color = '#6C9BF5', size = 24, fontSize = 12 }) {
  const isPhoto = typeof avatar === 'string' && avatar.startsWith('data:')

  // No hash → render whatever's inline (data URL, emoji, letter).
  if (isPhoto || !avatarHash) {
    return (
      <div style={{
        width: size, height: size, borderRadius: '50%',
        background: isPhoto ? 'transparent' : color,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        overflow: 'hidden', flexShrink: 0,
      }}>
        {isPhoto
          ? <img src={avatar} alt={name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          : <span style={{ color: '#fff', fontWeight: 600, fontSize, lineHeight: 1 }}>{(avatar?.trim()) || (name?.trim()?.[0]?.toUpperCase() ?? '?')}</span>}
      </div>
    )
  }

  return <MemberAvatarByHash avatarHash={avatarHash} fallback={avatar} name={name}
                             color={color} size={size} fontSize={fontSize} />
}

function MemberAvatarByHash ({ avatarHash, fallback, name, color, size, fontSize }) {
  const [resolved, setResolved] = useState(null)
  useEffect(() => {
    if (!window.__pearResolveAvatar) return
    let cancelled = false
    window.__pearResolveAvatar(avatarHash).then(d => { if (!cancelled) setResolved(d) })
    return () => { cancelled = true }
  }, [avatarHash])
  const isPhoto = typeof resolved === 'string' && resolved.startsWith('data:')
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: isPhoto ? 'transparent' : color,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      overflow: 'hidden', flexShrink: 0,
    }}>
      {isPhoto
        ? <img src={resolved} alt={name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        : <span style={{ color: '#fff', fontWeight: 600, fontSize, lineHeight: 1 }}>{(fallback?.trim()) || (name?.trim()?.[0]?.toUpperCase() ?? '?')}</span>}
    </div>
  )
}
