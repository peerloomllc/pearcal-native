import { useState } from 'react'
import { todayStr } from '../../ui-shared/index.js'

// View state for the desktop main pane: selectedDate (YYYY-MM-DD) and
// the active view mode (day / week / month). Lives in its own hook so
// the Toolbar, Sidebar mini-month, and the view components all touch
// the same state without prop-drilling through App.jsx.
export function useViewState () {
  const [selectedDate, setSelectedDate] = useState(todayStr())
  const [mode, setMode] = useState('day')
  return { selectedDate, setSelectedDate, mode, setMode }
}
