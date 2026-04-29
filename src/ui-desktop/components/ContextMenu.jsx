// Right-click context menu — single instance positioned at the click
// coords. Items array is platform-agnostic so DayView/Week/Month all
// pass the same shape.

import { useEffect, useRef } from 'react'

const MENU_WIDTH = 180

export function ContextMenu ({ tokens, x, y, items, onClose }) {
  const ref = useRef(null)

  useEffect(() => {
    function onDown (e) {
      if (ref.current && !ref.current.contains(e.target)) onClose()
    }
    function onKey (e) { if (e.key === 'Escape') onClose() }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  // Clamp inside viewport
  const vw = window.innerWidth
  const vh = window.innerHeight
  let left = x
  if (left + MENU_WIDTH > vw - 8) left = vw - MENU_WIDTH - 8
  let top  = y
  const estHeight = items.length * 30 + 8
  if (top + estHeight > vh - 8) top = vh - estHeight - 8

  return (
    <div ref={ref} style={{
      position: 'fixed', top, left, width: MENU_WIDTH, zIndex: 110,
      background: tokens.surface, border: `1px solid ${tokens.border}`,
      borderRadius: 6, padding: 4,
      boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
      fontFamily: tokens.font,
    }}>
      {items.map((it, i) => it.divider ? (
        <div key={i} style={{ height: 1, background: tokens.border, margin: '4px 0' }} />
      ) : (
        <button key={i}
          onClick={() => { it.onClick?.(); onClose() }}
          disabled={it.disabled}
          style={{
            display: 'block', width: '100%', textAlign: 'left',
            padding: '6px 10px', fontSize: 12, fontWeight: 400,
            background: 'transparent', border: 'none',
            color: it.danger ? '#C0504A' : tokens.text,
            cursor: it.disabled ? 'default' : 'pointer',
            opacity: it.disabled ? 0.5 : 1,
            fontFamily: tokens.font, borderRadius: 4,
          }}
          onMouseEnter={e => { if (!it.disabled) e.currentTarget.style.background = tokens.bg }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}>
          {it.label}
        </button>
      ))}
    </div>
  )
}
