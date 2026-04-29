// Event + member color helpers. Pure functions — derive a render-time
// color list from event/group state so neither renderer (mobile or
// desktop) bakes group color into the underlying record.

export const MAX_COLOR_SEGMENTS = 3

export function eventColors (ev) {
  const cs = Array.isArray(ev?.colors) && ev.colors.length ? ev.colors : (ev?.color ? [ev.color] : [])
  return cs.slice(0, MAX_COLOR_SEGMENTS)
}

// Per-member color palette. Two resolvers:
//   memberColorFor(id)          — hash fallback, stable across devices but may
//                                 collide (used for shadow events where we
//                                 don't have a canonical member list to index).
//   memberColorIndexed(g, id)   — sorted-index within a group's member list.
//                                 Guaranteed-distinct up to palette length, so
//                                 the common 2-member group never collides.
export const MEMBER_PALETTE = [
  '#6C9BF5', '#7FB77E', '#E8A87C', '#C38D9E',
  '#85CDCA', '#E27D60', '#B388EB', '#F0C987',
  '#8DD7BF', '#F2A365', '#F7B2AD', '#90AFC5',
]

export function memberColorFor (memberId) {
  if (!memberId) return MEMBER_PALETTE[0]
  let h = 0
  for (let i = 0; i < memberId.length; i++) h = ((h << 5) - h + memberId.charCodeAt(i)) | 0
  return MEMBER_PALETTE[Math.abs(h) % MEMBER_PALETTE.length]
}

export function memberColorIndexed (group, memberId) {
  if (!group || !Array.isArray(group.members) || !memberId) return memberColorFor(memberId)
  const ids = group.members.map(m => m?.id).filter(Boolean).sort()
  const idx = ids.indexOf(memberId)
  if (idx < 0) return memberColorFor(memberId)
  return MEMBER_PALETTE[idx % MEMBER_PALETTE.length]
}

export function derivedEventColors (ev, groups) {
  const cid = ev?.creatorId
  const authored = cid && cid !== 'system' && cid !== 'unknown'
  // Shadow events: author-color regardless of group count (collapses #56).
  if (ev?.isShadow && authored) return [memberColorFor(cid)]
  // Single-group case: distinct per-member color instead of the group color.
  if (Array.isArray(groups) && groups.length === 1 && authored) {
    return [memberColorIndexed(groups[0], cid)]
  }
  return eventColors(ev)
}

// Segmented vertical stripe as a CSS linear-gradient — used in place of a
// solid borderLeft so 2–3 group colors are visible side-by-side.
export function stripeBackground (colors) {
  if (!colors || colors.length === 0) return null
  if (colors.length === 1) return colors[0]
  const n = colors.length
  const stops = colors.flatMap((c, i) => [`${c} ${(i / n) * 100}%`, `${c} ${((i + 1) / n) * 100}%`]).join(', ')
  return `linear-gradient(to bottom, ${stops})`
}

// Style fragment that paints a left-edge stripe via backgroundImage, so we
// can layer it on top of an existing backgroundColor (e.g. translucent tint).
// Replaces `borderLeft: Npx solid X` while preserving card layout.
export function leftStripeStyle (colors, widthPx = 4) {
  const bg = stripeBackground(colors)
  if (!bg) return {}
  return {
    backgroundImage: bg.startsWith('linear-gradient') ? bg : `linear-gradient(${bg}, ${bg})`,
    backgroundSize: `${widthPx}px 100%`,
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'left top',
  }
}

// Dot background for day-grid indicators — single color when one group,
// diagonal split for 2–3 groups so the multi-group case is legible at 6–8px.
export function dotBackground (colors) {
  const cs = colors && colors.length ? colors.slice(0, MAX_COLOR_SEGMENTS) : null
  if (!cs) return null
  if (cs.length === 1) return cs[0]
  const n = cs.length
  const stops = cs.flatMap((c, i) => [`${c} ${(i / n) * 100}%`, `${c} ${((i + 1) / n) * 100}%`]).join(', ')
  return `linear-gradient(135deg, ${stops})`
}
