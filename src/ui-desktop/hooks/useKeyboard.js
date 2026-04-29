import { useEffect } from 'react'

// Global keyboard shortcuts for the desktop renderer (D5). Lives at the
// App-level so date nav, view switch, palette open, and Esc-close all
// route through the same place.
//
// Skips dispatch when the user is typing in an input/textarea/select or
// a contenteditable element — the modal's title field, the palette's
// search box, etc. all keep their normal text-edit behavior. Esc is the
// one exception: it always reaches `onCloseTransient` so the user can
// always escape an open layer.
//
// We deliberately don't hijack other meta-keyed shortcuts (Cmd+C,
// Cmd+R, Cmd+W, Cmd+Q, etc.); only Cmd+K and Cmd+F are claimed.

function shiftDate (dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  dt.setDate(dt.getDate() + days)
  return dt.getFullYear() + '-' +
    String(dt.getMonth() + 1).padStart(2, '0') + '-' +
    String(dt.getDate()).padStart(2, '0')
}

function shiftMonth (dateStr, months) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const target = new Date(y, m - 1 + months, 1)
  // Clamp day to last-of-month so Mar 31 → Feb 28 (not Mar 3 from rollover).
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()
  const day = Math.min(d, last)
  return target.getFullYear() + '-' +
    String(target.getMonth() + 1).padStart(2, '0') + '-' +
    String(day).padStart(2, '0')
}

function todayLocal () {
  const t = new Date()
  return t.getFullYear() + '-' +
    String(t.getMonth() + 1).padStart(2, '0') + '-' +
    String(t.getDate()).padStart(2, '0')
}

function isTyping (target) {
  if (!target) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (target.isContentEditable) return true
  return false
}

export function useKeyboard ({
  selectedDate, setSelectedDate, mode, setMode,
  onCreate, onOpenPalette, onOpenSettings, onCloseTransient,
}) {
  useEffect(() => {
    function onKey (e) {
      if (e.key === 'Escape') {
        onCloseTransient?.()
        return
      }

      const meta = e.metaKey || e.ctrlKey
      if (meta && (e.key === 'k' || e.key === 'K' || e.key === 'f' || e.key === 'F')) {
        e.preventDefault()
        onOpenPalette?.()
        return
      }
      // Match by both `e.key` and `e.code` — some Linux/Wayland setups
      // send a modifier-translated character for Ctrl+, that doesn't
      // equal ",". e.code is layout-stable.
      if (meta && (e.key === ',' || e.code === 'Comma')) {
        e.preventDefault()
        onOpenSettings?.()
        return
      }
      if (meta) return

      if (isTyping(e.target)) return

      switch (e.key) {
        case 'ArrowLeft':
          if (mode === 'month') setSelectedDate(shiftMonth(selectedDate, -1))
          else setSelectedDate(shiftDate(selectedDate, mode === 'week' ? -7 : -1))
          e.preventDefault()
          break
        case 'ArrowRight':
          if (mode === 'month') setSelectedDate(shiftMonth(selectedDate, 1))
          else setSelectedDate(shiftDate(selectedDate, mode === 'week' ? 7 : 1))
          e.preventDefault()
          break
        case 't':
        case 'T':
          setSelectedDate(todayLocal())
          e.preventDefault()
          break
        case '1':
          setMode('day')
          e.preventDefault()
          break
        case '2':
          setMode('week')
          e.preventDefault()
          break
        case '3':
          setMode('month')
          e.preventDefault()
          break
        case 'n':
        case 'N':
          onCreate?.()
          e.preventDefault()
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedDate, setSelectedDate, mode, setMode, onCreate, onOpenPalette, onOpenSettings, onCloseTransient])
}
