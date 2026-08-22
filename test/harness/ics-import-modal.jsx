// Desktop twin of ics-import-sheet.jsx: mounts ImportIcsModal on its own so the
// same destination picker can be driven without launching the whole Electron
// app. Same props, same fixtures - the runner asserts the same behaviour
// against both, which is the point.
import { createRoot } from 'react-dom/client'
import { ImportIcsModal } from '../../src/ui-desktop/components/ImportIcsModal.jsx'

const TOKENS = {
  font: 'system-ui, sans-serif',
  bg: '#111', surface: '#1b1b1b', border: '#333',
  text: '#eee', muted: '#999', accent: '#D9A441',
}
const GROUPS = [
  { id: 'work',   name: 'Work',   color: '#6C9BF5', emoji: '\u{1F4BC}' },
  { id: 'family', name: 'Family', color: '#E8A87C', emoji: '\u{1F3E1}' },
]
const EVENTS = [
  { title: 'Standup', date: '2026-08-24', start: '09:00', end: '09:15', allDay: false, uid: 'e1', groups: ['work'] },
  { title: 'Dentist', date: '2026-08-25', allDay: true, uid: 'e2' },
  { title: 'Already imported', date: '2026-08-26', allDay: true, uid: 'dupe' },
]

document.body.style.background = TOKENS.bg

createRoot(document.getElementById('root')).render(
  <ImportIcsModal tokens={TOKENS} events={EVENTS} filename="calendar.ics" groups={GROUPS}
    existingEventIds={new Set(['dupe'])}
    onImport={(toImport) => {
      window.__imported = toImport.map(r => ({ title: r.ev.title, groups: r.keptGroups }))
    }}
    onClose={() => { window.__closed = true }} />
)
