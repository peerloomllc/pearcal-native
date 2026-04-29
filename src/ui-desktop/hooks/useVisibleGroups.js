import { useState, useEffect, useMemo, useCallback } from 'react'

// Visible-groups set drives which groups' events show up in the main
// view. Defaults to "all visible" — newly synced groups are visible
// automatically. Toggling a group hides its events without affecting
// the underlying data.
//
// In-session state for D3 (no persistence). When D7 ships and updateProfile
// becomes available to the desktop renderer, this hook can persist to a
// `profile.desktopHiddenGroups` field — keeping it inverted (storing
// HIDDEN ids, not visible ones) so newly added groups remain visible by
// default with no migration.
export function useVisibleGroups (groups) {
  const [hiddenIds, setHiddenIds] = useState(() => new Set())

  // Drop ids whose group no longer exists (group deleted or user left).
  useEffect(() => {
    setHiddenIds(prev => {
      if (prev.size === 0) return prev
      const live = new Set(groups.map(g => g.id))
      let changed = false
      const next = new Set()
      for (const id of prev) {
        if (live.has(id)) next.add(id)
        else changed = true
      }
      return changed ? next : prev
    })
  }, [groups])

  const toggle = useCallback((id) => {
    setHiddenIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const isVisible = useCallback((id) => !hiddenIds.has(id), [hiddenIds])

  const visibleIds = useMemo(() => {
    return new Set(groups.filter(g => !hiddenIds.has(g.id)).map(g => g.id))
  }, [groups, hiddenIds])

  return { isVisible, toggle, visibleIds, hiddenIds }
}
