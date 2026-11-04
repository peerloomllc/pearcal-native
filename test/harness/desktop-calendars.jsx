// TODO #189: mounts the desktop sidebar and event editor against a fake db, so
// the Personal section, the show/hide switches, folding Groups and the editor's
// calendar picker can be driven in a hidden window.
// Run it with: node test/harness/desktop-calendars.js
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Sidebar } from '../../src/ui-desktop/components/Sidebar/index.jsx'
import { EventModal } from '../../src/ui-desktop/components/EventModal.jsx'
import { useCalendars } from '../../src/ui-shared/hooks/useCalendars.js'

const TOKENS = {
  font: 'system-ui, sans-serif',
  bg: '#111', surface: '#1b1b1b', border: '#333',
  text: '#eee', muted: '#999', accent: '#D9A441',
}
const GROUPS = [{ id: 'work', name: 'Work', color: '#6C9BF5', emoji: '' }]

const rows = [{ id: 'health', name: 'Health', color: '#5DBF8A', createdAt: 1, updatedAt: 1 }]
window.__vis = { hidden: [], hiddenEventIds: [] }
window.__saved = null
const db = {
  listPersonalCalendars: async () => {
    const out = [{ id: 'default', name: 'Personal', color: null, isDefault: true }]
    return out.concat(rows)
  },
  putPersonalCalendar: async c => { const r = { ...c, id: c.id || 'cal' + rows.length, updatedAt: Date.now() }; rows.push(r); return r },
  deletePersonalCalendar: async () => ({}),
  getCalendarVisibility: async () => window.__vis,
  setCalendarVisibility: async v => { window.__vis = v; return v },
  listReminders: async () => [], getReminders: async () => [], getPrivateNote: async () => null,
}

function Harness () {
  const [selectedDate, setSelectedDate] = useState('2026-11-04')
  const [miniCursor, setMiniCursor] = useState({ y: 2026, m: 10 })
  const cal = useCalendars(db, { activeHolidayCountries: [] })
  const visibleGroups = { isVisible: id => !cal.isHidden('group:' + id), toggle: id => cal.toggle('group:' + id) }
  window.__cal = cal
  return (
    <div style={{ display: 'flex', height: '100vh' }}>
      <Sidebar tokens={TOKENS} profile={{ id: 'me', name: 'Me' }} groups={GROUPS}
        selectedDate={selectedDate} setSelectedDate={setSelectedDate}
        miniCursor={miniCursor} setMiniCursor={setMiniCursor}
        visibleGroups={visibleGroups} cal={cal} onNewCalendar={() => {}} pendingApprovalGroups={new Set()}
        onOpenProfile={() => {}} onOpenSettings={() => {}} onOpenAbout={() => {}} />
      <div id="editor">
        <EventModal tokens={TOKENS} mode="create"
          initial={{ date: '2026-11-04', start: '', end: '', groups: [] }}
          groups={GROUPS} calendars={cal.calendars} profile={{ id: 'me', name: 'Me' }} use24h={false} db={db}
          onSave={ev => { window.__saved = ev }} onDelete={() => {}} onClose={() => {}} />
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')).render(<Harness />)
