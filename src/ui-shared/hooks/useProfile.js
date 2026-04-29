import { useState, useEffect } from 'react'

// Profile state — initial load on mount, refresh on `pear:profileChanged`
// (sibling-device profile edit ripples back through the personal base).
//
// Returns the same [value, setter] shape as useState so the caller can
// still drive the value imperatively (e.g. App.jsx's bootstrap Promise.all
// seeds it alongside the rest of the calendar state, and updateProfile
// flips it after a local edit before the round-trip back through the DB).
export function useProfile (db, emitter) {
  const [profile, setProfile] = useState(null)

  useEffect(() => {
    if (!db) return
    let cancelled = false
    db.getProfile().then(p => { if (!cancelled) setProfile(p) }).catch(() => {})
    return () => { cancelled = true }
  }, [db])

  useEffect(() => {
    if (!db || !emitter) return
    async function onProfileChanged () {
      try {
        const fresh = await db.getProfile()
        if (fresh) setProfile(fresh)
      } catch { /* non-fatal */ }
    }
    emitter.on('profileChanged', onProfileChanged)
    return () => emitter.off('profileChanged', onProfileChanged)
  }, [db, emitter])

  return [profile, setProfile]
}
