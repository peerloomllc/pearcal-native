// GitHub #400 - show who added a shared event. The notification named them,
// but nothing on the event itself did once it was dismissed.
//
// Every event already carries creatorId (the creator's profile id). This
// resolves it to the name the viewer sees for that person in the event's
// groups. Returns null when there is nothing worth showing: my own events,
// personal events, holidays, busy-time shadows (their cards already show the
// name) and creators no longer listed in any of the groups.

export function eventAddedByName (ev, groups, myId) {
  if (!ev || ev.isShadow) return null
  const creatorId = ev.creatorId
  if (!creatorId || creatorId === 'system' || creatorId === 'unknown') return null
  if (myId && creatorId === myId) return null
  const groupIds = Array.isArray(ev.groups) ? ev.groups : []
  if (groupIds.length === 0) return null

  for (const gid of groupIds) {
    const g = (groups ?? []).find(x => x?.id === gid)
    const m = (g?.members ?? []).find(x => x?.id === creatorId)
    if (!m) continue
    // The invite placeholder is not a real name.
    if (m.name === 'Inviter' && m.avatar === '?') continue
    const name = (m.nickname || m.name || '').trim()
    if (name) return name
  }
  // The last editor is often the creator; use their saved name if so.
  if (ev.updatedById === creatorId && ev.updatedByName && ev.updatedByName !== 'Someone') {
    return ev.updatedByName
  }
  return null
}
