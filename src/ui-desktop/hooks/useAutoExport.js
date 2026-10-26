import { useState, useEffect, useCallback } from 'react'
import { autoExportFiles } from '../../ui-shared/index.js'

// Automatic .ics export to a folder (TODO #186). The settings and the folder
// live in Electron main (see shell-handlers.js); this hook builds one file per
// chosen calendar from the events the window already holds and hands them
// over whenever events, groups or the settings change. The window keeps
// running while hidden in the tray, so the files stay current without it open.
// Main skips files whose events did not change, so a burst of sync updates
// costs one comparison per file.
const WRITE_DELAY_MS = 3000

export function useAutoExport (db, events, groups, eventsReady) {
  const [config, setConfig] = useState(null)

  useEffect(() => {
    let alive = true
    db?.getAutoExport?.().then(c => { if (alive && c) setConfig(c) }).catch(() => {})
    return () => { alive = false }
  }, [db])

  const enabled = !!(config?.enabled && config?.folder)
  const calendarKey = (config?.calendars ?? []).join(',')

  useEffect(() => {
    if (!enabled || !eventsReady || !db?.writeAutoExport) return
    // Groups load separately from events. Until they arrive a chosen group
    // looks deleted and main would remove its file, so wait for them.
    if (groups.length === 0 && config.calendars.some(id => id !== 'personal')) return
    const t = setTimeout(() => {
      const files = autoExportFiles(events, groups, config.calendars)
      db.writeAutoExport(files).then(c => { if (c) setConfig(c) }).catch(() => {})
    }, WRITE_DELAY_MS)
    return () => clearTimeout(t)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, eventsReady, db, events, groups, calendarKey, config?.folder])

  const update = useCallback(async (patch) => {
    const c = await db?.setAutoExport?.(patch)
    if (c) setConfig(c)
    return c
  }, [db])

  const pickFolder = useCallback(async () => {
    const c = await db?.pickExportFolder?.()
    if (c) setConfig(c)
    return c
  }, [db])

  return { config, update, pickFolder }
}
