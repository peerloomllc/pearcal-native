// PearCal Desktop renderer — Apple-Calendar-shaped layout (sidebar +
// main grid). D2 laid the structural shell + Day view; D3 adds the
// sidebar mini-month, group visibility toggles, and Week + Month
// views. Mouse interactions, modals, keyboard shortcuts come in
// later phases. Mobile renderer (src/ui/App.jsx) is untouched.

import { useMemo } from 'react'
import {
  useProfile, useGroups, useEvents, useRsvps,
  emitter,
} from '../ui-shared/index.js'
import { Sidebar } from './components/Sidebar/index.jsx'
import { Toolbar } from './components/Toolbar.jsx'
import { DayView } from './components/DayView.jsx'
import { WeekView } from './components/WeekView.jsx'
import { MonthView } from './components/MonthView.jsx'
import { useViewState } from './hooks/useViewState.js'
import { useVisibleGroups } from './hooks/useVisibleGroups.js'

const DARK_TOKENS = {
  bg:        '#0E0D0C',
  surface:   '#1A1916',
  border:    '#2C2A26',
  text:      '#F2EFE8',
  muted:     '#8A8478',
  accent:    '#C8922A',
  font:      "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif",
}

export default function App ({ db, notifs, sync }) {
  const [profile] = useProfile(db, emitter)
  const [groups]  = useGroups(db)
  const [events]  = useEvents(db)
  const [myRsvps] = useRsvps(db)
  const view      = useViewState()
  const visibleGroups = useVisibleGroups(groups)

  // Group lookup by id — used by event color resolution + sidebar list.
  const groupsById = useMemo(() => {
    const map = new Map()
    for (const g of groups) map.set(g.id, g)
    return map
  }, [groups])

  // Filter events by visible-groups membership (any-of). Events with no
  // groups (legacy or personal) stay visible regardless.
  const visibleEvents = useMemo(() => {
    if (visibleGroups.hiddenIds.size === 0) return events
    return events.filter(ev => {
      const ids = ev.groups ?? []
      if (ids.length === 0) return true
      return ids.some(id => visibleGroups.isVisible(id))
    })
  }, [events, visibleGroups])

  if (!profile) {
    return (
      <div style={{
        height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: DARK_TOKENS.bg, color: DARK_TOKENS.muted,
        fontFamily: DARK_TOKENS.font, fontSize: 14,
      }}>
        Loading PearCal…
      </div>
    )
  }

  const use24h    = profile.use24h ?? !new Intl.DateTimeFormat([], { hour: 'numeric' }).format(0).match(/am|pm/i)
  const weekStart = profile.weekStart ?? 0

  const viewProps = {
    tokens: DARK_TOKENS,
    events: visibleEvents,
    groupsById,
    myRsvps,
    selectedDate: view.selectedDate,
    setSelectedDate: view.setSelectedDate,
    use24h,
    weekStart,
  }

  return (
    <div style={{
      height: '100vh', display: 'flex',
      background: DARK_TOKENS.bg, color: DARK_TOKENS.text,
      fontFamily: DARK_TOKENS.font,
    }}>
      <Sidebar
        tokens={DARK_TOKENS}
        profile={profile}
        groups={groups}
        selectedDate={view.selectedDate}
        setSelectedDate={view.setSelectedDate}
        visibleGroups={visibleGroups}
      />
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <Toolbar
          tokens={DARK_TOKENS}
          selectedDate={view.selectedDate}
          setSelectedDate={view.setSelectedDate}
          mode={view.mode}
          setMode={view.setMode}
        />
        {view.mode === 'day'   && <DayView   {...viewProps} />}
        {view.mode === 'week'  && <WeekView  {...viewProps} />}
        {view.mode === 'month' && <MonthView {...viewProps} setMode={view.setMode} />}
      </main>
    </div>
  )
}
