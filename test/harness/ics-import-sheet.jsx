// Mounts ImportIcsSheet on its own in a hidden Electron window, so the import
// destination picker can be driven for real - real Chromium, real React, real
// BottomSheet - without a device, a swarm or anything on screen.
// Run it with: node test/harness/ics-import-sheet.js
import { createRoot } from 'react-dom/client'
import { ImportIcsSheet } from '../../src/ui/App.jsx'
import { injectGlobalStyles } from '../../src/ui/theme.js'

injectGlobalStyles()

const GROUPS = [
  { id: 'work',   name: 'Work',   color: '#6C9BF5', emoji: '\u{1F4BC}' },
  { id: 'family', name: 'Family', color: '#E8A87C', emoji: '\u{1F3E1}' },
]
const EVENTS = [
  { title: 'Standup', date: '2026-08-24', start: '09:00', end: '09:15', allDay: false, uid: 'e1', groups: ['work'] },
  { title: 'Dentist', date: '2026-08-25', allDay: true, uid: 'e2' },
  { title: 'Already imported', date: '2026-08-26', allDay: true, uid: 'dupe' },
]

createRoot(document.getElementById('root')).render(
  <ImportIcsSheet events={EVENTS} filename="calendar.ics" groups={GROUPS}
    existingEventIds={new Set(['dupe'])}
    onImport={(toImport) => {
      window.__imported = toImport.map(r => ({ title: r.ev.title, groups: r.keptGroups }))
    }}
    onClose={() => { window.__closed = true }} />
)
