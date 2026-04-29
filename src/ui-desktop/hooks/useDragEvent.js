import { useState } from 'react'

// Drag an existing event — either move (whole block translates by a
// preserved-duration delta) or resize (only the bottom edge moves).
// Mode is derived at mousedown time by where the click landed in the
// event's bounding box: bottom 8px = resize handle, anywhere else = move.
//
// Click (movement < threshold) falls through to onClickThrough so the
// inspector still opens for plain clicks. The hook owns dragState so
// the views can render the in-flight event at its visual position
// without writing to the underlying record until commit.
export function useDragEvent ({ snapMin = 30, threshold = 5, onCommit, onClickThrough }) {
  const [dragState, setDragState] = useState(null)  // { ev, mode, deltaMin } | null

  function start (e, ev, hourHeight) {
    if (e.button !== 0) return
    const elRect = e.currentTarget.getBoundingClientRect()
    const yWithin = e.clientY - elRect.top
    const mode = yWithin > elRect.height - 8 ? 'resize' : 'move'

    const startY = e.clientY
    let dragged = false
    let lastDelta = 0

    function onMove (mev) {
      const dist = Math.abs(mev.clientY - startY)
      if (dist >= threshold) {
        dragged = true
        const deltaY = mev.clientY - startY
        const deltaMin = Math.round(deltaY / hourHeight * 60 / snapMin) * snapMin
        if (deltaMin !== lastDelta) {
          lastDelta = deltaMin
          setDragState({ ev, mode, deltaMin })
        }
      }
    }
    function onUp (mev) {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      if (!dragged) {
        onClickThrough?.(ev, mev.clientX, mev.clientY)
      } else if (lastDelta !== 0) {
        onCommit?.({ ev, mode, deltaMin: lastDelta })
      }
      setDragState(null)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  return { start, dragState }
}
