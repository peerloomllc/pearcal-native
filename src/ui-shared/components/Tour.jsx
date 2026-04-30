// Self-contained guided tour. Shared between mobile (src/ui) and desktop
// (src/ui-desktop) — the JSX only uses plain DOM nodes, so it works
// inside both Electron's renderer and the React Native WebView.
//
// Usage:
//   <Tour steps={[
//     { anchor: 'sidebar', title: '...', body: '...', placement: 'right' },
//     ...
//   ]} onDone={...} onSkip={...} tokens={{ accent, surface, text, muted, border, font }} />
//
// Each step's `anchor` is matched against `[data-tour="<anchor>"]` in
// the live DOM. Steps whose anchor isn't found render the tooltip centered
// in the viewport (so the tour gracefully handles platform-specific
// chrome that's missing on the other platform).
//
// Spotlight is implemented as four dim strips around the anchor's bbox
// instead of an SVG mask — simpler, no clip-path/CSS-mask compatibility
// to worry about, and the borders animate cleanly.

import { useEffect, useLayoutEffect, useState } from 'react'

const PADDING       = 6
const TOOLTIP_W     = 280
const TOOLTIP_GAP   = 12
const VIEWPORT_PAD  = 12

export function Tour ({ steps, onDone, onSkip, tokens }) {
  const [stepIdx, setStepIdx]   = useState(0)
  const [bbox,    setBbox]      = useState(null)
  const [vp,      setVp]        = useState(() => viewport())
  const step = steps[stepIdx]

  // Resolve anchor -> bbox on every step change AND any layout-affecting event.
  useLayoutEffect(() => {
    if (!step) return
    function measure () {
      const el = document.querySelector('[data-tour="' + step.anchor + '"]')
      setBbox(el ? el.getBoundingClientRect() : null)
      setVp(viewport())
    }
    measure()
    // Re-measure after a tick — some anchors mount async (sheets, modals).
    const t = setTimeout(measure, 50)
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      clearTimeout(t)
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [step?.anchor])

  // Keyboard: Esc skips; Enter / ArrowRight advances.
  useEffect(() => {
    function onKey (e) {
      if (e.key === 'Escape') { e.preventDefault(); skip() }
      else if (e.key === 'Enter' || e.key === 'ArrowRight') { e.preventDefault(); next() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [stepIdx, steps.length])

  function next () {
    if (stepIdx + 1 >= steps.length) onDone?.()
    else setStepIdx(stepIdx + 1)
  }
  function skip () { onSkip?.() }
  function back () { if (stepIdx > 0) setStepIdx(stepIdx - 1) }

  if (!step) return null

  // Anchor missing → centered tooltip + full dim overlay.
  const hasAnchor = !!bbox
  const cutout = hasAnchor ? padRect(bbox, PADDING) : null
  const tooltipPos = hasAnchor
    ? placeTooltip(cutout, vp, step.placement)
    : { left: vp.w / 2 - TOOLTIP_W / 2, top: vp.h / 2 - 80 }

  const dim = 'rgba(0, 0, 0, 0.55)'
  const accent = tokens?.accent  ?? '#6C9BF5'
  const text   = tokens?.text    ?? '#F2EFE8'
  const muted  = tokens?.muted   ?? '#8A8680'
  const surf   = tokens?.surface ?? '#1A1816'
  const border = tokens?.border  ?? '#2A2724'
  const bg     = tokens?.bg      ?? '#0E0D0C'
  const font   = tokens?.font    ?? 'system-ui, sans-serif'

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 999,
      fontFamily: font, color: text,
    }}>
      {hasAnchor ? (
        <>
          {/* Four dim strips around the cutout. */}
          <div style={{ position: 'fixed', left: 0, top: 0,                width: '100vw', height: cutout.top,                          background: dim, pointerEvents: 'auto' }} onClick={skip} />
          <div style={{ position: 'fixed', left: 0, top: cutout.bottom,    width: '100vw', height: vp.h - cutout.bottom,                background: dim, pointerEvents: 'auto' }} onClick={skip} />
          <div style={{ position: 'fixed', left: 0, top: cutout.top,       width: cutout.left, height: cutout.bottom - cutout.top,      background: dim, pointerEvents: 'auto' }} onClick={skip} />
          <div style={{ position: 'fixed', left: cutout.right, top: cutout.top, width: vp.w - cutout.right, height: cutout.bottom - cutout.top, background: dim, pointerEvents: 'auto' }} onClick={skip} />
          {/* Spotlight ring around the anchor. */}
          <div style={{
            position: 'fixed', pointerEvents: 'none',
            left: cutout.left, top: cutout.top,
            width: cutout.right - cutout.left, height: cutout.bottom - cutout.top,
            borderRadius: 8, boxShadow: '0 0 0 2px ' + accent,
            transition: 'left 200ms, top 200ms, width 200ms, height 200ms',
          }} />
        </>
      ) : (
        <div onClick={skip} style={{ position: 'fixed', inset: 0, background: dim }} />
      )}

      {/* Tooltip card */}
      <div onClick={e => e.stopPropagation()} style={{
        position: 'fixed', left: tooltipPos.left, top: tooltipPos.top,
        width: TOOLTIP_W, maxWidth: 'calc(100vw - 24px)',
        background: surf, border: '1px solid ' + border, borderRadius: 10,
        boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
        padding: '14px 16px',
        transition: 'left 200ms, top 200ms',
      }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6, color: text }}>
          {step.title}
        </div>
        <div style={{ fontSize: 12, fontWeight: 400, lineHeight: 1.5, color: muted, marginBottom: 12 }}>
          {step.body}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ flex: 1, fontSize: 11, color: muted, fontVariantNumeric: 'tabular-nums' }}>
            {stepIdx + 1} / {steps.length}
          </div>
          <button onClick={skip} style={btn(border, 'transparent', muted, font)}>
            Skip
          </button>
          {stepIdx > 0 && (
            <button onClick={back} style={btn(border, 'transparent', text, font)}>
              Back
            </button>
          )}
          <button onClick={next} style={btn(accent, accent, bg, font)}>
            {stepIdx + 1 >= steps.length ? "Let's go!" : 'Next'}
          </button>
        </div>
      </div>
    </div>
  )
}

function btn (borderColor, bg, color, font) {
  return {
    padding: '6px 12px', fontSize: 12, fontWeight: 500,
    borderRadius: 5, cursor: 'pointer',
    fontFamily: font, border: '1px solid ' + borderColor,
    background: bg, color,
  }
}

function viewport () {
  return { w: window.innerWidth, h: window.innerHeight }
}

function padRect (r, p) {
  return {
    left:   Math.max(0, r.left - p),
    top:    Math.max(0, r.top  - p),
    right:  r.right  + p,
    bottom: r.bottom + p,
  }
}

// Pick a tooltip placement that fits in the viewport. Prefers the explicit
// placement, falls back to whichever side has room, then centers below.
function placeTooltip (cut, vp, preferred) {
  const order = preferred
    ? [preferred, ...['bottom', 'top', 'right', 'left'].filter(s => s !== preferred)]
    : ['bottom', 'top', 'right', 'left']

  for (const side of order) {
    const pos = computeSide(cut, vp, side)
    if (pos) return pos
  }
  // Fallback: pin to the bottom of the cutout, clamped to viewport.
  return {
    left: clamp(cut.left, VIEWPORT_PAD, vp.w - TOOLTIP_W - VIEWPORT_PAD),
    top:  clamp(cut.bottom + TOOLTIP_GAP, VIEWPORT_PAD, vp.h - 100 - VIEWPORT_PAD),
  }
}

function computeSide (cut, vp, side) {
  const APPROX_H = 140  // tooltip body is short; this is an overestimate.
  if (side === 'bottom') {
    if (cut.bottom + TOOLTIP_GAP + APPROX_H > vp.h - VIEWPORT_PAD) return null
    return {
      left: clamp(cut.left + (cut.right - cut.left) / 2 - TOOLTIP_W / 2, VIEWPORT_PAD, vp.w - TOOLTIP_W - VIEWPORT_PAD),
      top:  cut.bottom + TOOLTIP_GAP,
    }
  }
  if (side === 'top') {
    if (cut.top - TOOLTIP_GAP - APPROX_H < VIEWPORT_PAD) return null
    return {
      left: clamp(cut.left + (cut.right - cut.left) / 2 - TOOLTIP_W / 2, VIEWPORT_PAD, vp.w - TOOLTIP_W - VIEWPORT_PAD),
      top:  cut.top - TOOLTIP_GAP - APPROX_H,
    }
  }
  if (side === 'right') {
    if (cut.right + TOOLTIP_GAP + TOOLTIP_W > vp.w - VIEWPORT_PAD) return null
    return {
      left: cut.right + TOOLTIP_GAP,
      top:  clamp(cut.top + (cut.bottom - cut.top) / 2 - APPROX_H / 2, VIEWPORT_PAD, vp.h - APPROX_H - VIEWPORT_PAD),
    }
  }
  if (side === 'left') {
    if (cut.left - TOOLTIP_GAP - TOOLTIP_W < VIEWPORT_PAD) return null
    return {
      left: cut.left - TOOLTIP_GAP - TOOLTIP_W,
      top:  clamp(cut.top + (cut.bottom - cut.top) / 2 - APPROX_H / 2, VIEWPORT_PAD, vp.h - APPROX_H - VIEWPORT_PAD),
    }
  }
  return null
}

function clamp (v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }
