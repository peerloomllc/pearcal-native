// PearCal design tokens. Matches the PeerLoom suite (PearList/PearPetal/
// PearCircle/PearGuard): Manrope, [data-theme] CSS variables, the shared
// spacing/radius scales. Body weight 300, headings 400, emphasis 500.
//
// PearCal keeps its own brand hue — a warm gold on warm neutrals — where the
// other apps are green/pink/blue. Only the *structure* is shared; the palette
// is deliberately ours.
//
// The exported colour values are the `var()` strings themselves, so any inline
// style referencing `colors.x` picks up the current theme automatically with no
// re-render: switching themes is one attribute flip on <html>.

import { FONT_CSS } from './fonts.js'

export const FONT = `'Manrope', -apple-system, BlinkMacSystemFont, sans-serif`
export const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace'

export const spacing = { xs: 4, sm: 8, md: 12, base: 16, lg: 20, xl: 24, xxl: 32, xxxl: 48 }
export const radius = { sm: 4, md: 8, lg: 10, xl: 14, sheet: 20, full: 9999 }

const v = (n) => `var(--color-${n})`
export const colors = {
  primary: v('primary'), primaryDark: v('primary-dark'), accent: v('accent'),
  error: v('error'), warn: v('warn'), success: v('success'),
  text: { primary: v('text-primary'), secondary: v('text-secondary'), muted: v('text-muted'), onPrimary: v('text-on-primary') },
  surface: { base: v('surface-base'), card: v('surface-card'), elevated: v('surface-elevated'), input: v('surface-input') },
  border: v('border'), divider: v('divider'), track: v('track'),
  // Tinted washes for selected/active states on the two signal colours.
  accentFaint: v('accent-faint'), destructiveFaint: v('destructive-faint'),
}

// Dark is the default (plain :root), matching the suite.
//
// `text-on-primary` is dark ink, not white: white on our gold is 2.76:1 in dark
// and 3.62:1 in light, both under the WCAG AA 4.5:1 floor. Dark ink is 6.36:1
// and 4.86:1. Every filled-primary control reads from this token.
//
// Light `text-muted` is #6E6A5E rather than the old #9A9288 (2.82:1, failing) —
// #6E6A5E clears AA at 4.96:1.
const THEME_VARS = `
:root, :root[data-theme="dark"] {
  --color-primary:#C8922A; --color-primary-dark:#A5761F; --color-accent:var(--color-primary);
  --color-error:#C0504A; --color-warn:#E5864A; --color-success:#5DBF8A;
  --color-text-primary:#F2EFE8; --color-text-secondary:#B8B2A6; --color-text-muted:#8A8478; --color-text-on-primary:#1A1916;
  --color-surface-base:#0E0D0C; --color-surface-card:#1A1916; --color-surface-elevated:#252220; --color-surface-input:#0E0D0C;
  --color-border:#2C2A26; --color-divider:#232120; --color-track:#4A4640;
  --color-accent-faint:rgba(200,146,42,0.12); --color-destructive-faint:rgba(192,80,74,0.12);
}
:root[data-theme="light"] {
  --color-primary:#B07D20; --color-primary-dark:#8E6318; --color-accent:var(--color-primary);
  --color-error:#C0504A; --color-warn:#A85F1E; --color-success:#4A9E6E;
  --color-text-primary:#1A1916; --color-text-secondary:#55514A; --color-text-muted:#6E6A5E; --color-text-on-primary:#1A1916;
  --color-surface-base:#F7F5F0; --color-surface-card:#FFFFFF; --color-surface-elevated:#EFECE4; --color-surface-input:#F7F5F0;
  --color-border:#E5E1D8; --color-divider:#EDEAE3; --color-track:#C9C4B8;
  --color-accent-faint:rgba(176,125,32,0.10); --color-destructive-faint:rgba(192,80,74,0.08);
}
/* Pre-suite names, kept as aliases of the tokens above so the ~7k lines of
   App.jsx that still say var(--color-bg) keep working while call sites migrate.
   One source of truth: edit the block above, never these. */
:root {
  --color-bg:var(--color-surface-base);
  --color-surface:var(--color-surface-card);
  --color-text:var(--color-text-primary);
  --color-muted:var(--color-text-muted);
  --color-destructive:var(--color-error);
}`

const SCALES = `
:root {
  --space-xs:4px; --space-sm:8px; --space-md:12px; --space-base:16px;
  --space-lg:20px; --space-xl:24px; --space-xxl:32px; --space-xxxl:48px;
  --radius-sm:4px; --radius-md:8px; --radius-lg:10px; --radius-xl:14px;
  --radius-sheet:20px; --radius-full:9999px;
  --font-sans:${FONT};
  --duration-fast:120ms; --duration-normal:200ms; --duration-slow:280ms;
  --easing:cubic-bezier(0.2, 0, 0, 1);
  --safe-area-top:env(safe-area-inset-top, 0px);
  --safe-area-bottom:env(safe-area-inset-bottom, 0px);
}`

const RESET = `
*, *::before, *::after { box-sizing: border-box; }
* { -webkit-tap-highlight-color: transparent; -webkit-user-select: none; user-select: none; -webkit-overflow-scrolling: touch; }
html, body, #root { height: 100%; margin: 0; background: var(--color-surface-base); }
/* Body owns the family and the 300 weight, so text nodes inherit it instead of
   each re-declaring fontWeight:300 inline (the pre-suite App.jsx did that 300+
   times). Headings step up to 400, emphasis to 500 — those are the only three
   weights fonts.js ships. */
body {
  color: var(--color-text-primary);
  font-family: var(--font-sans);
  font-weight: 300;
  -webkit-font-smoothing: antialiased;
}
input, textarea { -webkit-user-select: text; user-select: text; }
input, textarea, select, button { font-family: var(--font-sans); }
input, textarea { font-size: 16px; font-weight: 300; }  /* 16px is the iOS "don't zoom on focus" floor */
button { transition: transform var(--duration-fast) var(--easing); }
button:active { transform: scale(0.97); }
input:focus, textarea:focus { border-color: var(--color-primary) !important; }
@keyframes pearFadeUp { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
@keyframes pearFadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes pearFadeOut { from { opacity: 1; } to { opacity: 0; } }
@keyframes pearPulse { 0%, 100% { opacity: 0.3; } 50% { opacity: 0.7; } }
@keyframes pearShake { 0%, 100% { transform: translateX(0); } 20%, 60% { transform: translateX(-4px); } 40%, 80% { transform: translateX(4px); } }
@keyframes pearSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes pearSlideInRight { from { opacity: 0; transform: translateX(32px) } to { opacity: 1; transform: translateX(0) } }
@keyframes pearSlideInLeft { from { opacity: 0; transform: translateX(-32px) } to { opacity: 1; transform: translateX(0) } }
@keyframes pearSkeletonPulse { 0%, 100% { opacity: 0.4 } 50% { opacity: 0.8 } }
`

export function injectGlobalStyles () {
  if (typeof document === 'undefined') return
  if (document.getElementById('pear-styles')) return
  const el = document.createElement('style')
  el.id = 'pear-styles'
  el.textContent = FONT_CSS + THEME_VARS + SCALES + RESET
  document.head.appendChild(el)
}

export function setTheme (mode) {
  if (typeof document === 'undefined') return
  const m = mode === 'light' ? 'light' : 'dark'
  document.documentElement.setAttribute('data-theme', m)
}
