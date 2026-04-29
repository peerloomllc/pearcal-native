// Cmd+K palette — searchable command list. Source of commands lives in
// App.jsx (it has the state); the palette is a pure consumer that
// filters, renders, and dispatches. Keyboard-first: Up/Down moves the
// selection, Enter executes, Esc closes. Mouse use also works.
//
// Synthetic "Jump to date" command: when the query parses as a date
// (YYYY-MM-DD or YYYY/MM/DD), we prepend a one-off command that jumps
// `selectedDate` to that day. This is purely a query-side affordance —
// the parent doesn't need to know it exists.

import { useEffect, useMemo, useRef, useState } from 'react'

const PALETTE_WIDTH = 560

function parseQueryDate (q) {
  const s = q.trim()
  // YYYY-MM-DD or YYYY/MM/DD
  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/)
  if (!m) return null
  const y = parseInt(m[1], 10), mo = parseInt(m[2], 10), d = parseInt(m[3], 10)
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  // Round-trip through Date to reject Feb 30 etc.
  const dt = new Date(y, mo - 1, d)
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null
  return y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0')
}

function score (cmd, q) {
  const label = cmd.label.toLowerCase()
  const hint  = (cmd.hint ?? '').toLowerCase()
  const idx = label.indexOf(q)
  if (idx !== -1) return idx
  const hIdx = hint.indexOf(q)
  if (hIdx !== -1) return hIdx + 1000
  return -1
}

export function CommandPalette ({ tokens, commands, onJumpToDate, onClose }) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef(null)
  const listRef = useRef(null)

  const filtered = useMemo(() => {
    const out = []
    const q = query.trim().toLowerCase()
    const dateMatch = parseQueryDate(query)
    if (dateMatch && onJumpToDate) {
      out.push({
        id: '__jump_date__',
        label: 'Jump to ' + dateMatch,
        hint: 'Date',
        icon: '📅',
        action: () => onJumpToDate(dateMatch),
      })
    }
    if (!q) {
      // No query → show all commands in their natural order.
      return out.concat(commands.slice(0, 40))
    }
    const scored = []
    for (const c of commands) {
      const s = score(c, q)
      if (s !== -1) scored.push({ cmd: c, s })
    }
    scored.sort((a, b) => a.s - b.s)
    return out.concat(scored.slice(0, 30).map(x => x.cmd))
  }, [query, commands, onJumpToDate])

  // Reset highlight when the filtered list changes.
  useEffect(() => { setActive(0) }, [query])
  useEffect(() => { inputRef.current?.focus() }, [])

  // Keep the active row visible.
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${active}"]`)
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' })
  }, [active])

  function onKey (e) {
    if (e.key === 'ArrowDown') {
      setActive(i => Math.min(i + 1, Math.max(filtered.length - 1, 0)))
      e.preventDefault()
    } else if (e.key === 'ArrowUp') {
      setActive(i => Math.max(i - 1, 0))
      e.preventDefault()
    } else if (e.key === 'Enter') {
      const cmd = filtered[active]
      if (cmd) { cmd.action(); onClose() }
      e.preventDefault()
    } else if (e.key === 'Escape') {
      onClose()
      e.preventDefault()
    } else if (e.key === 'Tab') {
      // Don't let Tab leave the palette and start scrolling background.
      e.preventDefault()
    }
  }

  return (
    <div onMouseDown={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 120,
      background: 'rgba(0,0,0,0.5)',
      display: 'flex', justifyContent: 'center', alignItems: 'flex-start',
      paddingTop: '12vh',
    }}>
      <div onMouseDown={e => e.stopPropagation()}
           onKeyDown={onKey}
           style={{
             width: PALETTE_WIDTH, maxWidth: '92vw',
             background: tokens.surface, border: `1px solid ${tokens.border}`,
             borderRadius: 10,
             boxShadow: '0 16px 48px rgba(0,0,0,0.6)',
             fontFamily: tokens.font,
             overflow: 'hidden',
             display: 'flex', flexDirection: 'column',
           }}>
        <input
          ref={inputRef}
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search commands, events, or YYYY-MM-DD…"
          aria-label="Command palette search"
          style={{
            width: '100%', boxSizing: 'border-box',
            padding: '13px 14px', fontSize: 14,
            background: 'transparent', border: 'none',
            borderBottom: `1px solid ${tokens.border}`,
            color: tokens.text, fontFamily: tokens.font,
            outline: 'none',
          }}
        />
        <div ref={listRef} style={{ maxHeight: 420, overflowY: 'auto', padding: 4 }}>
          {filtered.length === 0 && (
            <div style={{ padding: '16px 12px', fontSize: 14, color: tokens.muted }}>
              No matches
            </div>
          )}
          {filtered.map((c, i) => {
            const isActive = i === active
            return (
              <div
                key={c.id}
                data-idx={i}
                onMouseEnter={() => setActive(i)}
                onMouseDown={() => { c.action(); onClose() }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '7px 12px', borderRadius: 5,
                  cursor: 'pointer', fontSize: 13,
                  background: isActive ? tokens.accent : 'transparent',
                  color: isActive ? tokens.bg : tokens.text,
                }}>
                <div style={{
                  width: 20, fontSize: 13, textAlign: 'center',
                  opacity: isActive ? 1 : 0.85,
                }}>
                  {c.icon ?? '·'}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.label}
                  </div>
                  {c.hint && (
                    <div style={{
                      fontSize: 11,
                      color: isActive ? tokens.bg : tokens.muted,
                      opacity: isActive ? 0.75 : 1,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {c.hint}
                    </div>
                  )}
                </div>
                {c.shortcut && (
                  <div style={{
                    fontSize: 11, color: isActive ? tokens.bg : tokens.muted,
                    opacity: 0.75, fontVariantNumeric: 'tabular-nums',
                  }}>
                    {c.shortcut}
                  </div>
                )}
              </div>
            )
          })}
        </div>
        <div style={{
          display: 'flex', gap: 14, padding: '7px 12px',
          borderTop: `1px solid ${tokens.border}`,
          fontSize: 11, color: tokens.muted, fontVariantNumeric: 'tabular-nums',
        }}>
          <span>↑↓ navigate</span>
          <span>↵ select</span>
          <span>Esc close</span>
        </div>
      </div>
    </div>
  )
}
