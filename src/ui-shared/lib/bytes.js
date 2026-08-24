// One byte formatter for both renderers.
//
// Mobile had it inline in App.jsx and the desktop storage report needed the
// same thing, which is exactly the drift proposals/2026-08-08-desktop-ui-parity.md
// is about: two copies that agree today and quietly disagree later. Decimal
// units on purpose - these numbers sit next to disk figures the OS also reports
// in GB, and the report is a rough orientation, not an audit.
export const formatBytes = b => b > 1e9 ? (b / 1e9).toFixed(2) + ' GB'
                              : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB'
                              : b > 1e3 ? (b / 1e3).toFixed(0) + ' KB'
                              : b + ' B'
