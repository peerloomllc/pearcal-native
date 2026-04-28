// PearCal Desktop renderer — Apple-Calendar-shaped layout (sidebar +
// main grid). Phase D2 lays the structural shell and the Day view;
// later phases fill in Week/Month, sidebar group list, mouse/keyboard
// interactions, and modals. Mobile renderer (src/ui/App.jsx) is
// untouched.

import { useMemo } from 'react'
import {
  useProfile, useGroups, useEvents, useRsvps,
  emitter, todayStr, formatTime,
  derivedEventColors, leftStripeStyle,
} from '../ui-shared/index.js'
import { Sidebar } from './components/Sidebar.jsx'
import { Toolbar } from './components/Toolbar.jsx'
import { DayView } from './components/DayView.jsx'
import { useViewState } from './hooks/useViewState.js'

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

  // Group lookup by id — used by event color resolution + sidebar list.
  const groupsById = useMemo(() => {
    const map = new Map()
    for (const g of groups) map.set(g.id, g)
    return map
  }, [groups])

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

  const use24h = profile.use24h ?? !new Intl.DateTimeFormat([], { hour: 'numeric' }).format(0).match(/am|pm/i)

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
      />
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <Toolbar
          tokens={DARK_TOKENS}
          selectedDate={view.selectedDate}
          setSelectedDate={view.setSelectedDate}
          mode={view.mode}
          setMode={view.setMode}
        />
        {view.mode === 'day' && (
          <DayView
            tokens={DARK_TOKENS}
            events={events}
            groupsById={groupsById}
            myRsvps={myRsvps}
            selectedDate={view.selectedDate}
            use24h={use24h}
          />
        )}
        {view.mode !== 'day' && (
          <div style={{
            flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: DARK_TOKENS.muted, fontSize: 14,
          }}>
            {view.mode} view — coming in D3
          </div>
        )}
      </main>
    </div>
  )
}
