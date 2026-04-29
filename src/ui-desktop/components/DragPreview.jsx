// Translucent ghost rendered while a drag-create is in progress on a
// timeline. Shows the snapped time range so the user knows what
// they'll get on mouseup. Used by both DayView and WeekView.

import { fromMinHHMM } from '../hooks/useDragCreate.js'

export function DragPreview ({ tokens, fromMin, toMin, hourHeight }) {
  const top    = fromMin / 60 * hourHeight
  const height = (toMin - fromMin) / 60 * hourHeight
  return (
    <div style={{
      position: 'absolute',
      top, left: 4, right: 4, height,
      // 8-digit hex with alpha — '40' ≈ 25% opacity. Browser-native and
      // works inside Electron without a separate rgba() conversion.
      background: tokens.accent + '40',
      border: `1.5px solid ${tokens.accent}`,
      borderRadius: 4,
      pointerEvents: 'none',
      color: tokens.text,
      padding: '2px 6px',
      fontSize: 11, fontWeight: 500,
      fontVariantNumeric: 'tabular-nums',
      fontFamily: tokens.font,
      overflow: 'hidden',
    }}>
      {fromMinHHMM(fromMin)}–{fromMinHHMM(toMin)}
    </div>
  )
}
