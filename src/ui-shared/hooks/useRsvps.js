import { useState, useEffect } from 'react'

// myRsvps map { eventId: 'going'|'declined'|'pending' } — owned by the
// renderer because the sync subscription patches it imperatively when
// delta.rsvpsChanged or a full-reload fires. The hook just provides the
// initial load on mount; the caller drives updates via setMyRsvps.
export function useRsvps (db) {
  const [myRsvps, setMyRsvps] = useState({})

  useEffect(() => {
    if (!db) return
    let cancelled = false
    db.listMyRsvps?.()
      .then(r => { if (!cancelled) setMyRsvps(r ?? {}) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [db])

  return [myRsvps, setMyRsvps]
}
