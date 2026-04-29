import { useState, useEffect } from 'react'

// Groups list. Initial load on mount; the caller (App.jsx today, the
// desktop renderer in a future phase) drives updates via setGroups when
// sync subscriptions fire `groupKeyUpdated`, `groupDeleted`, the per-group
// `refreshGroupRecord` path, or local mutations (addGroup / updateGroup /
// leaveGroup / deleteGroup / kickMember / updateProfile's member ripple).
//
// Pulling those mutations into the hook would tangle it with sync, profile,
// and the sync-event subscription effect — that lives further along the
// extraction roadmap. The minimal hook still gives the desktop renderer a
// single import for read+initial-load.
export function useGroups (db) {
  const [groups, setGroups] = useState([])

  useEffect(() => {
    if (!db) return
    let cancelled = false
    db.listGroups()
      .then(g => { if (!cancelled) setGroups(g ?? []) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [db])

  return [groups, setGroups]
}
