import { useCallback, useState } from 'react'
import { todayStr } from '../../ui-shared/index.js'

// View state for the desktop main pane: selectedDate (YYYY-MM-DD), the
// active view mode (day / week / month), navDir for the nav slide
// animation, and the sidebar mini-month's independent cursor.
//
// Coupling rules:
//   - setSelectedDate (any source) snaps miniCursor to match — so toolbar
//     arrows / palette jumps / day-clicks-in-mini all keep the mini in
//     sync with the main view.
//   - setMiniCursor (the mini-month's own ‹ › buttons) does NOT touch
//     selectedDate — user can browse months in the sidebar without
//     moving the main pane until they actually click a day.
//   - goToToday resets BOTH so the Today button can re-sync everything
//     from any drift state.

function shiftDateStr (dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  dt.setDate(dt.getDate() + days)
  return dt.getFullYear() + '-' +
    String(dt.getMonth() + 1).padStart(2, '0') + '-' +
    String(dt.getDate()).padStart(2, '0')
}

function shiftMonthStr (dateStr, months) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const target = new Date(y, m - 1 + months, 1)
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()
  const day = Math.min(d, last)
  return target.getFullYear() + '-' +
    String(target.getMonth() + 1).padStart(2, '0') + '-' +
    String(day).padStart(2, '0')
}

function ymOfDate (dateStr) {
  const [y, m] = dateStr.split('-').map(Number)
  return { y, m: m - 1 }
}

export function useViewState () {
  const today0 = todayStr()
  const [selectedDate, _setSelectedDate] = useState(today0)
  const [mode, setMode] = useState('day')
  const [navDir, setNavDir] = useState(0)
  const [miniCursor, _setMiniCursor] = useState(() => ymOfDate(today0))

  const setSelectedDate = useCallback((d) => {
    setNavDir(0)
    _setSelectedDate(d)
    _setMiniCursor(ymOfDate(d))
  }, [])

  const setMiniCursor = useCallback((c) => {
    _setMiniCursor(c)
  }, [])

  const navigateBy = useCallback((delta) => {
    setNavDir(delta > 0 ? 1 : -1)
    _setSelectedDate(prev => {
      const next = mode === 'month' ? shiftMonthStr(prev, delta)
                : mode === 'week'  ? shiftDateStr(prev, delta * 7)
                :                    shiftDateStr(prev, delta)
      _setMiniCursor(ymOfDate(next))
      return next
    })
  }, [mode])

  // Today button: jumps the main view to today AND resnaps the mini
  // cursor. Idempotent — calling when already on today still snaps the
  // mini back if the user had browsed away with ‹ ›.
  const goToToday = useCallback(() => {
    const t = todayStr()
    setNavDir(0)
    _setSelectedDate(t)
    _setMiniCursor(ymOfDate(t))
  }, [])

  // Today button enabled when EITHER the main view or the mini cursor
  // has drifted from today. Both must match for the button to be a
  // visual no-op.
  const tToday = todayStr()
  const tYM = ymOfDate(tToday)
  const isFullyToday = selectedDate === tToday && miniCursor.y === tYM.y && miniCursor.m === tYM.m

  return {
    selectedDate, setSelectedDate,
    mode, setMode,
    navDir, navigateBy,
    miniCursor, setMiniCursor,
    goToToday, isFullyToday,
  }
}
