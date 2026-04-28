// Time + date string formatting. Pure functions — no Date arithmetic
// that depends on timezone state, no React hooks.

export function formatTime (t, use24h) {
  if (!t) return ''
  const [hStr, mStr] = t.split(':')
  if (use24h) return hStr + ':' + mStr
  const h = parseInt(hStr, 10)
  const ampm = h >= 12 ? 'pm' : 'am'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return h12 + ':' + mStr + ampm
}

export function formatRelativeTime (ts) {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 0 || diff < 10_000)       return 'just now'
  if (diff < 60_000)                    return Math.floor(diff / 1000)  + 's ago'
  if (diff < 3_600_000)                 return Math.floor(diff / 60_000) + 'm ago'
  if (diff < 86_400_000)                return Math.floor(diff / 3_600_000) + 'h ago'
  return Math.floor(diff / 86_400_000) + 'd ago'
}

export function todayStr () {
  const t = new Date()
  return dateStr(t.getFullYear(), t.getMonth(), t.getDate())
}

export function dateStr (y, m, d) {
  return `${y}-${String(m + 1).padStart(2,'0')}-${String(d).padStart(2,'0')}`
}
