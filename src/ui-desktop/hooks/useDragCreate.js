import { useState } from 'react'

// Drag-to-create on a timeline. Mousedown on an empty slot starts a drag;
// mousemove updates a preview range (snapped to `snapMin`); mouseup commits.
// Click (movement < threshold) calls onClick instead — caller decides
// whether to floor that to top-of-hour or use a different default.
//
// Single drag at a time across the whole tree (only one timeline can be
// drag-targeted simultaneously). `dragRange` carries `date` so a multi-
// column view (Week) can render the preview only inside the active column.
export function useDragCreate ({ snapMin = 30, threshold = 5, onClick, onCommit }) {
  const [dragRange, setDragRange] = useState(null)  // { date, from, to } | null

  function start (e, ctx) {
    if (e.button !== 0) return            // left-click only
    if (e.target.closest('[data-event-id]')) return  // events handle their own clicks
    const { rect, date, hourHeight } = ctx
    if (!rect || hourHeight <= 0) return

    const snap = (m) => Math.max(0, Math.min(24 * 60 - snapMin, Math.floor(m / snapMin) * snapMin))
    const startMouseY = e.clientY
    const startMin = snap((e.clientY - rect.top) / hourHeight * 60)
    let dragged = false
    let lastMin = startMin

    function onMove (mev) {
      const dist = Math.abs(mev.clientY - startMouseY)
      if (dist >= threshold) {
        dragged = true
        const currentMin = snap((mev.clientY - rect.top) / hourHeight * 60)
        lastMin = currentMin
        let from = Math.min(startMin, currentMin)
        let to   = Math.max(startMin, currentMin)
        // Zero-duration drag (snapped onto same boundary) — fall back to
        // a single snap unit so the preview is visible.
        if (to <= from) to = Math.min(24 * 60, from + snapMin)
        setDragRange({ date, from, to })
      }
    }
    function onUp () {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      if (!dragged) {
        onClick?.({ date, startMin })
      } else {
        let from = Math.min(startMin, lastMin)
        let to   = Math.max(startMin, lastMin)
        if (to <= from) to = Math.min(24 * 60, from + snapMin)
        onCommit?.({ date, fromMin: from, toMin: to })
      }
      setDragRange(null)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  return { start, dragRange }
}

// HH:MM formatter for minute integers — matches the EventModal helper
// but re-declared here so the hook is self-contained for both views.
export function fromMinHHMM (mins) {
  const m = ((mins % 1440) + 1440) % 1440
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0')
}
