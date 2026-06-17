// Lane packing for multi-day event bars.
//
// A multi-day event should render as ONE continuous bar that spans the day
// columns it covers, not a duplicated chip in every day cell. Given a
// contiguous run of dates (a month week-row, or the 7 columns of the week
// view's all-day strip) and the event list, we segment each event to the
// portion that falls inside the run, then pack the segments into horizontal
// lanes so that no two segments in the same lane overlap.
//
// Used by MonthView (the 6 week-rows) and WeekView's all-day row.

import { expandRecurring } from '../../ui-shared/index.js'

// Whole-day difference b - a for "YYYY-MM-DD" strings. UTC math avoids DST
// drift; the strings are date-only so the time component is irrelevant.
export function diffDays (a, b) {
  const [ay, am, ad] = a.split('-').map(Number)
  const [by, bm, bd] = b.split('-').map(Number)
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000)
}

// Build the per-row segment list. `rowDates` is a contiguous, ascending array
// of date strings. Each returned item carries the event plus its column span
// within the row and whether it bleeds past either edge (so the renderer can
// flatten the continuing corners).
export function buildRowItems (events, rowDates) {
  const rowStart = rowDates[0]
  const rowEnd = rowDates[rowDates.length - 1]
  const items = []
  for (const ev of events) {
    const isRecurring = ev.recurrence && ev.recurrence !== 'none' && ev.recurrenceEnd && !ev.recurrenceId
    const occs = isRecurring ? expandRecurring(ev) : [ev]
    for (const occ of occs) {
      const start = occ.date
      const end = (occ.endDate && occ.endDate > occ.date) ? occ.endDate : occ.date
      if (!start || end < rowStart || start > rowEnd) continue
      const startCol = Math.max(0, diffDays(rowStart, start))
      const endCol = Math.min(rowDates.length - 1, diffDays(rowStart, end))
      items.push({
        ev: occ,
        startCol,
        endCol,
        continuesLeft: start < rowStart,
        continuesRight: end > rowEnd,
        multiDay: end > start,
      })
    }
  }
  return items
}

// Pack items into non-overlapping horizontal lanes. All-day events sort to the
// top, then longer spans, then left-to-right, so multi-day bars settle into the
// upper lanes and stay visually stable across a row.
export function packLanes (items) {
  const sorted = [...items].sort((a, b) => {
    const aAll = a.ev.allDay ? 0 : 1
    const bAll = b.ev.allDay ? 0 : 1
    if (aAll !== bAll) return aAll - bAll
    const aSpan = a.endCol - a.startCol
    const bSpan = b.endCol - b.startCol
    if (aSpan !== bSpan) return bSpan - aSpan
    if (a.startCol !== b.startCol) return a.startCol - b.startCol
    return (a.ev.start ?? '').localeCompare(b.ev.start ?? '')
  })
  const lanes = []
  for (const it of sorted) {
    let placed = false
    for (const lane of lanes) {
      if (lane.every(x => it.endCol < x.startCol || it.startCol > x.endCol)) {
        lane.push(it)
        placed = true
        break
      }
    }
    if (!placed) lanes.push([it])
  }
  return lanes
}

// Per-column count of items that fall into lanes beyond the visible cap, so a
// cell can show "+N more". A hidden multi-day item counts toward every day it
// covers.
export function overflowByColumn (lanes, maxLanes, colCount) {
  const overflow = new Array(colCount).fill(0)
  for (let i = maxLanes; i < lanes.length; i++) {
    for (const it of lanes[i]) {
      for (let c = it.startCol; c <= it.endCol; c++) overflow[c]++
    }
  }
  return overflow
}
