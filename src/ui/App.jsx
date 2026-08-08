/**
 * PearCal — Root React Component
 *
 * Props (injected from src/index.js):
 *   db     {PearCalDB}           — Hyperbee data layer
 *   notifs {NotificationScheduler}
 *   sync   {SyncManager}
 *
 * All state is loaded from Hyperbee on mount.
 * All mutations write through to Hyperbee (and sync/notifs where needed).
 * A lightweight event emitter wires P2P sync updates back into React state.
 */

import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { handleInviteLink } from '../invite.js'
import { SEEDER_PAIR_SCAN_TIMEOUT_MS, secondsRemaining, formatCountdown } from '../lib/seederPairTiming.js'
import { joinOutcomeMessage, isBenignJoinOutcome } from '../lib/joinOutcome.js'
import QRCode from 'qrcode'
import { FONT, colors, injectGlobalStyles, setTheme as applyTheme } from './theme.js'
import {
  parseIcs, generateIcs,
  MAX_COLOR_SEGMENTS,
  eventColors, memberColorFor, memberColorIndexed, derivedEventColors,
  stripeBackground, leftStripeStyle, dotBackground,
  expandRecurring, stepRecurrenceDate, fmtDate, parseDate,
  formatTime, formatRelativeTime, todayStr, dateStr,
  getUSFederalHolidays, getCanadaHolidays, getBitcoinHolidays, getUKHolidays, HOLIDAY_COUNTRIES,
  holidayEventId, holidayCalendarIds, strayHolidayEvents,
  useProfile, useRsvps, useGroups, useEvents, useHolidayRepair,
  emitter, Tour,
} from '../ui-shared/index.js'
export { parseIcs, generateIcs, emitter } from '../ui-shared/index.js'
import {
  CalendarBlank, CalendarDot, Users, User, Info,
  ShareNetwork, ArrowSquareOut, MapPin, GearSix,
  Trash, SignOut, Repeat, Lock, Key, Hourglass,
  CaretRight, CaretLeft, QrCode, Plus, UserPlus,
  Check, CheckCircle, Copy, X, Eye, EyeSlash, Circle,
  Warning, ArrowLeft, DotsThree,
  Lightning, BookOpen, EnvelopeSimple, Bug,
  Image, ArrowsClockwise, CurrencyDollar,
  ShieldCheck, Crown, UploadSimple, DownloadSimple,
  FunnelSimple, GridFour, PencilSimple, Broadcast,
} from '@phosphor-icons/react'

// ─── Theme ────────────────────────────────────────────────────────────────────
// Tokens, the CSS-variable palette and the global reset live in ./theme.js — the
// same shape every other PeerLoom app uses. main.jsx injects them before first
// render; this call is the idempotent safety net for any other entry point.
injectGlobalStyles()

const IS_IOS = window.__pearPlatform === 'ios'
// Desktop (Electron) has no camera, so QR-scan buttons are hidden in favour of
// the paste/copy-link alternatives that sit beside them.
const IS_DESKTOP = window.__pearPlatform === 'desktop'

// ─── Donation (BTC / Lightning) ─────────────────────────────────────────────
// Shared across the PeerLoom app family; keep constants identical.
const LIGHTNING_ADDRESS   = 'peerloomllc@strike.me'
const STRIKE_TIP_URL      = 'https://strike.me/peerloomllc/'
// Strike deposit address (custodial, derived from Strike's xpub, so reuse is
// fine). Empty string hides the on-chain row. Rotate in one line.
const BTC_ONCHAIN_ADDRESS = 'bc1q0kksenz3j4u9ppe6f4krclvzwxk7sjy00cc9cf'
// Shared min height so every option box (buttons, copy fields, wallet rows) lines up.
const DONATE_OPTION_MIN_H = 56

const LIGHTNING_WALLETS = [
  { name: 'Strike',            url: 'https://strike.me',            desc: 'Simple Lightning payments' },
  { name: 'Cash App',          url: 'https://cash.app',             desc: 'Send Bitcoin via Lightning' },
  { name: 'Wallet of Satoshi', url: 'https://walletofsatoshi.com',  desc: 'Beginner-friendly Lightning wallet' },
  { name: 'Phoenix',           url: 'https://phoenix.acinq.co',     desc: 'Self-custodial Lightning wallet' },
]

// Copy-to-clipboard field. Routes through the shell (sync.copyText) because
// navigator.clipboard is unreliable in the about:blank WebView. Flashes
// "Copied" for ~1.6s.
function CopyField ({ sync, value, hint }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      const r = await sync?.copyText(value)
      if (r?.ok !== false) {
        sync?.haptic('success')
        setCopied(true)
        setTimeout(() => setCopied(false), 1600)
      }
    } catch {}
  }
  return (
    <div>
      <div style={{
        display:'flex', alignItems:'center', gap:8,
        background: colors.surface.card, border:`1px solid ${colors.border}`, borderRadius:12,
        padding:'10px 14px', minHeight:DONATE_OPTION_MIN_H, boxSizing:'border-box',
      }}>
        <span style={{
          flex:1, minWidth:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap',
          fontFamily:'monospace', fontSize:13, color: colors.text.primary,
        }}>{value}</span>
        <button data-haptic="success" onClick={copy} style={{
          flexShrink:0, background:'transparent', border:'none', cursor:'pointer',
          fontFamily:FONT, fontSize:13, fontWeight:400,
          color: copied ? 'var(--color-success)' : colors.primary,
          display:'flex', alignItems:'center', gap:4,
        }}>
          {copied ? <><CheckCircle size={14} weight="fill" /> Copied</> : 'Copy'}
        </button>
      </div>
      {hint && (
        <div style={{ fontSize:12, color:colors.text.muted, margin:'4px 0 0', lineHeight:1.5, textAlign:'center' }}>{hint}</div>
      )}
    </div>
  )
}

function setTheme (dark) {
  applyTheme(dark ? 'dark' : 'light')
}

// ─── Back-gesture stack ───────────────────────────────────────────────────────
// Every overlay registers a dismiss handler on mount; hardware Back and the edge
// swipe unwind them deepest-first — the most recently mounted overlay is the one
// actually on top, so it goes first. A handler consumes the gesture unless it
// explicitly returns false.
//
// This replaces a hand-maintained if/else ladder in App that named thirteen
// closeXxxRefs in a fixed order: every new overlay meant remembering to wire a
// ref in at App level, and that order had to be kept in step with the z-index
// stack by hand. BottomSheet registers itself, so all twelve sheets get Back for
// free, and a sheet opened on top of the QR modal now dismisses before it —
// which the fixed order got wrong.
const _backStack = []

function useBackHandler (active, onBack) {
  const handler = useRef(onBack)
  useEffect(() => { handler.current = onBack })
  useEffect(() => {
    if (!active) return
    const entry = () => handler.current?.()
    _backStack.push(entry)
    return () => {
      const i = _backStack.lastIndexOf(entry)
      if (i !== -1) _backStack.splice(i, 1)
    }
  }, [active])
}

function runBackStack () {
  for (let i = _backStack.length - 1; i >= 0; i--) {
    if (_backStack[i]() !== false) return true
  }
  return false
}

function extractURLs (text) {
  if (!text) return []
  const re = /https?:\/\/[^\s<>"']+/gi
  return [...new Set(text.match(re) ?? [])]
}

// Module-level camera consumer — whichever component most recently called takePhoto owns the next result
const activeCameraConsumer = { current: null }

function PearIcon ({ size = 40, color = 'var(--color-accent)' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* Stem */}
      <path d="M20 6 C20 6 22 3 24 2" stroke={color} strokeWidth="1.2" strokeLinecap="round" fill="none"/>
      {/* Small leaf on stem */}
      <path d="M21 5 C23 3 26 4 24 6 C22 7 20 6 21 5Z" fill={color} opacity="0.7"/>
      {/* Pear body — teardrop shape */}
      <path d="M20 8 C20 8 14 10 13 17 C12 22 14 28 17 31 C18.5 32.5 21.5 32.5 23 31 C26 28 28 22 27 17 C26 10 20 8 20 8Z"
        stroke={color} strokeWidth="1.2" fill="none" strokeLinejoin="round"/>
    </svg>
  )
}

function Spinner ({ size = 14 }) {
  return (
    <Circle
      size={size}
      weight="thin"
      style={{ animation: 'pearSpin 800ms linear infinite', display: 'inline-block' }}
    />
  )
}

function SkeletonBar ({ width = '100%', height = 12, style = {} }) {
  return (
    <div style={{
      width, height, borderRadius: 'var(--radius-sm)',
      background: 'var(--color-border)',
      animation: 'pearPulse 1.4s ease-in-out infinite',
      ...style,
    }} />
  )
}

function isShadowHidden (e, allEvents, myId) {
  if (!e.isShadow) return false
  // Hide a shadow only when its source event is locally present — otherwise
  // (e.g. after mnemonic-restore, where the forwarder's source events haven't
  // been recovered) the shadow is the only visible proxy and must render.
  if (allEvents.some(x => !x.isShadow && x.id === e.sourceEventId)) return true
  // Robustness for linked-device sync timing. Paired devices share one identity,
  // so e.creatorId === myId on every one of my devices. If my source event has
  // reached this device under a transiently different row/id (e.g. it arrived
  // over the personal base while the shadow arrived over the group base), the
  // id match above misses it and the detail-less shadow renders next to the
  // real event — the "same event, one with a location and one without"
  // duplicate. Fall back to a content match so my own busy-time shadow is
  // suppressed whenever the underlying event is already visible here. A
  // genuinely absent source (mnemonic-restore) matches nothing, so the shadow
  // still renders as the sole proxy.
  if (e.creatorId && e.creatorId === myId && allEvents.some(x =>
        !x.isShadow && x.title === e.title && x.date === e.date &&
        x.start === e.start && x.end === e.end)) return true
  return false
}

// Agenda inclusion: Day-tab dayEvents and Month-tab cards share this rule.
// Hide group events whose invitees[] excludes me (I can still see the dot on
// the calendar grid — this only narrows the agenda list). Shadows with no
// invitees stay visible as busy-time indicators for non-forwarders; the
// forwarder's own duplicate shadow is separately hidden by isShadowHidden
// when the source event is locally present.
function isInAgenda (e, myId) {
  if (!e.invitees || e.invitees.length === 0) return true
  if (e.creatorId === myId) return true
  if (e.invitees.includes(myId)) return true
  return false
}

function shadowCreatorName (e, groups) {
  if (!e.isShadow) return null
  for (const g of groups ?? []) {
    const m = (g.members ?? []).find(x => x.id === e.creatorId)
    if (m?.name) return m.name
  }
  return e.updatedByName || 'Someone'
}

function SkeletonEventCard () {
  return (
    <div style={{
      background: 'var(--color-surface-card)', borderRadius: 'var(--radius-lg)',
      padding: '10px 12px', marginBottom: 6,
      borderLeft: '4px solid var(--color-border)',
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <SkeletonBar width="60%" height={12} />
      <SkeletonBar width="35%" height={10} />
    </div>
  )
}

const GROUP_COLORS = ['#6C9BF5','#5DBF8A','#E5864A','#D45F7A','#A97FD4','#4BBDCC','#F5C842','#E07B54']
const GROUP_EMOJIS = ['👨‍👩‍👧‍👦','⚽','📚','🎮','🏋️','🎵','🌿','🐾','✈️','🍕','💼','🎨']
const DAYS   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']
const MORNING_OF = -1
const DAY_BEFORE = -2

// Tail-extension thresholds for `repeatForever` series (TODO #82 Phase 3).
// Re-extend when the latest materialised occurrence is within this many days
// of now; add another year of occurrences each time.
const FOREVER_REEXTEND_THRESHOLD_DAYS = 90
const FOREVER_EXTEND_WINDOW_MONTHS = 12

// Walk the just-loaded events list, find any series whose latest occurrence
// is still flagged `repeatForever: true` and falls inside the threshold
// window, generate the next chunk of occurrences, persist them via
// db.putEvent (which mirrors to personal-base for sync), and return the new
// occurrences so the caller can merge into local state.
//
// Only the LATEST occurrence's flag matters. If a user toggled forever OFF
// with scope='future' at some midpoint, every occurrence at or after that
// point is now forever=false, so the latest is forever=false and we skip
// extension — the series ends naturally at its materialized tail. Mixed
// flags (e.g. r0..r9 true, r10..r364 false) are handled correctly by this
// rule without any special-casing.
async function extendForeverSeriesIfNeeded (events, db) {
  if (!Array.isArray(events) || !db) return []
  const now = new Date()
  const thresholdMs = FOREVER_REEXTEND_THRESHOLD_DAYS * 24 * 60 * 60 * 1000

  // Group ALL series occurrences (regardless of flag) so we can inspect the
  // latest's flag below.
  const seriesMap = new Map()
  for (const ev of events) {
    if (!ev || ev.isShadow || !ev.recurrenceId) continue
    if (!seriesMap.has(ev.recurrenceId)) seriesMap.set(ev.recurrenceId, [])
    seriesMap.get(ev.recurrenceId).push(ev)
  }

  const newOccurrences = []
  for (const [rid, occurrences] of seriesMap) {
    occurrences.sort((a, b) => a.date.localeCompare(b.date))
    const last = occurrences[occurrences.length - 1]
    if (!last.repeatForever) continue
    const lastDate = parseDate(last.date)
    if (lastDate.getTime() - now.getTime() > thresholdMs) continue

    let maxIdx = 0
    for (const occ of occurrences) {
      const m = occ.id.match(/_r(\d+)$/)
      if (m) maxIdx = Math.max(maxIdx, parseInt(m[1], 10))
    }

    const target = new Date(lastDate.getFullYear(), lastDate.getMonth() + FOREVER_EXTEND_WINDOW_MONTHS, lastDate.getDate())
    const cur = new Date(lastDate)
    let i = maxIdx
    let added = 0
    const HARD_CAP = 500
    while (added < HARD_CAP) {
      stepRecurrenceDate(cur, last)
      if (cur > target) break
      i++
      added++
      newOccurrences.push({
        ...last,
        id: rid + '_r' + i,
        date: fmtDate(cur),
        recurrenceId: rid,
      })
    }
  }

  for (const occ of newOccurrences) {
    await db.putEvent(occ).catch(e => console.warn('[FOREVER-EXTEND-ERR]', e?.message))
  }
  return newOccurrences
}

const REMINDER_OPTIONS = [
  {label:'5 min before',      value:5},
  {label:'10 min before',     value:10},
  {label:'15 min before',     value:15},
  {label:'30 min before',     value:30},
  {label:'1 hour before',     value:60},
  {label:'2 hours before',    value:120},
  {label:'Morning of (9 AM)', value:MORNING_OF},
  {label:'Day before (9 AM)', value:DAY_BEFORE},
  {label:'1 day before',      value:1440},
  {label:'1 week before',     value:10080},
  {label:'2 weeks before',    value:20160},
]

// Mobile guided tour steps (D9). Anchors are `[data-tour="<key>"]` —
// missing anchors fall through to a centered tooltip in Tour.jsx.
const MOBILE_TOUR_STEPS = [
  { anchor: 'mobile-create', placement: 'top',
    title: 'Create an event',
    body: 'Tap + to add an event. Or tap any day on the calendar and start filling it in.' },
  { anchor: 'nav-groups', placement: 'top',
    title: 'Groups & invites',
    body: 'Share a calendar with others. Tap Groups to create a new one, or scan/paste an invite link to join. Each group surfaces a QR + paste link to invite more people.' },
  { anchor: 'nav-profile', placement: 'top',
    title: 'Profile & settings',
    body: 'Edit your name and photo, change theme, notifications, and time format. Linked devices and recovery phrase live here too — pair another phone or computer under the same identity.' },
  { anchor: 'nav-about', placement: 'top',
    title: 'About & help',
    body: 'How P2P works, app info, donations, and a "Replay welcome tour" button if you want to revisit this.' },
]

// Shared style recipes. Components read the design tokens straight from
// ./theme.js rather than receiving a `th` object as a prop: every token is a
// var() string, so the palette is a constant and threading it through the tree
// bought nothing but 29 signatures and 56 call sites of noise.
const iconBtn = {
  background: 'none', border: 'none', cursor: 'pointer',
  padding: '4px 8px', borderRadius: 'var(--radius-md)', fontFamily: FONT, fontWeight: 400,
  color: colors.text.primary,
}
const pillBtn = {
  background: colors.primary, border: 'none',
  borderRadius: 'var(--radius-lg)', color: colors.text.onPrimary,
  cursor: 'pointer', fontFamily: FONT, fontWeight: 400,
}

// ─── Primitives ───────────────────────────────────────────────────────────────
// Kept in this file under a banner band rather than a components/ directory —
// that is what the rest of the suite does (PearList, PearPetal and PearCircle
// are all single-file too; only PearGuard decomposed).

// The one form-field recipe, previously copy-pasted verbatim into EventModal,
// GroupSettingsModal and NewGroupModal.
const inputStyle = {
  background: colors.surface.input, border: `1px solid ${colors.border}`,
  borderRadius: 'var(--radius-md)', padding: '10px 14px',
  color: colors.text.primary,
  fontSize: 16,  // 16px is the floor below which iOS zooms the page on focus
  fontFamily: FONT, width: '100%', boxSizing: 'border-box', outline: 'none',
  transition: 'border-color var(--duration-fast) var(--easing)',
}

// `danger` keeps white text: white on our red clears AA at 4.68:1, where white
// on the gold primary does not — primary takes dark ink via text.onPrimary.
function Button ({ variant = 'primary', style, children, ...rest }) {
  const base = {
    width: '100%', padding: '12px', borderRadius: 'var(--radius-lg)',
    border: 'none', fontFamily: FONT, fontSize: 14, cursor: 'pointer',
  }
  const variants = {
    primary:   { background: colors.primary, color: colors.text.onPrimary },
    danger:    { background: colors.error, color: '#fff' },
    secondary: { background: 'transparent', color: colors.text.primary, border: `1px solid ${colors.border}` },
  }
  return <button style={{ ...base, ...variants[variant], ...style }} {...rest}>{children}</button>
}

// Collapsible row, ported from PearCircle's About accordion. The header is a
// <button> rather than a <div> so the global capture-phase click listener fires
// its haptic for free; a leading icon, a title, and a caret that rotates 90° when
// open. The body animates on max-height instead of snapping.
//
// Sits on surface.elevated so an expanded row reads as lifted off the page —
// that layer exists for exactly this and had no consumer until now.
function Collapsible ({ title, icon: Icon, open, onToggle, maxHeight = 600, children }) {
  return (
    <div style={{
      background: colors.surface.elevated, borderRadius: 'var(--radius-xl)',
      marginBottom: 10, overflow: 'hidden',
    }}>
      <button onClick={onToggle} aria-expanded={open}
        style={{
          width: '100%', textAlign: 'left', background: 'transparent', border: 'none',
          color: colors.text.primary, fontFamily: FONT, cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 16px',
        }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, fontWeight: 400 }}>
          {Icon && <Icon size={18} weight="thin" color={colors.text.secondary} />}
          {title}
        </span>
        <CaretRight size={16} weight="thin" color={colors.text.muted}
          style={{
            transition: 'transform var(--duration-slow) var(--easing)',
            transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
          }} />
      </button>
      <div style={{
        maxHeight: open ? maxHeight : 0, overflow: 'hidden',
        transition: 'max-height 0.35s cubic-bezier(0.4, 0, 0.2, 1)',
      }}>
        <div style={{ padding: '0 16px 16px' }}>{children}</div>
      </div>
    </div>
  )
}

// ─── Root App ─────────────────────────────────────────────────────────────────
// Keep fields the UI needs that a raw record does not carry. Group objects reach
// this component from two shapes: enriched (listGroups/getGroup, with syncHealth
// and keyless) and raw (sync events). Replacing an enriched object with a raw one
// silently drops the warnings, which is how the #155 banner vanished a moment
// after appearing. Same class as feedback_react_state_sync_overwrite.
function mergeGroupState (prev, incoming) {
  if (!incoming) return prev
  const merged = { ...incoming }
  if (merged.syncHealth === undefined && prev?.syncHealth !== undefined) merged.syncHealth = prev.syncHealth
  if (merged.keyless === undefined && prev?.keyless !== undefined) merged.keyless = prev.keyless
  // #159 fields ride the same path and would vanish the same way. Adding a new
  // enriched field WITHOUT a line here is the #155 bug reappearing, so this list
  // has to grow whenever listGroups/getGroup attach something new.
  if (merged.indexers === undefined && prev?.indexers !== undefined) merged.indexers = prev.indexers
  if (merged.rollout === undefined && prev?.rollout !== undefined) merged.rollout = prev.rollout
  return merged
}

// Coarse on purpose (#155). The judgement is "has this been quiet for days",
// so minutes and seconds would imply a precision the 48h threshold does not have.
function fmtSyncAge (ms) {
  if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return 'a while'
  const days = Math.floor(ms / 86400000)
  if (days >= 14) return Math.floor(days / 7) + ' weeks'
  if (days >= 2) return days + ' days'
  const hours = Math.floor(ms / 3600000)
  return hours >= 1 ? hours + ' hours' : 'a while'
}

export default function App ({ db, notifs, sync }) {
  const [dark,  setDark]  = useState(() => {
    setTheme(true) // default dark until profile loads
    return true
  })
  useEffect(() => { setTheme(dark) }, [dark])
  const [tab,   setTab]   = useState('calendar')
  const [ready, setReady] = useState(false)
  const [error, setError] = useState(null)

  const [profile,       setProfile]       = useProfile(db, emitter)
  const [groups,        setGroups]        = useGroups(db)
  const [events,        setEvents,       eventsReady] = useEvents(db)
  const [myRsvps,       setMyRsvps]       = useRsvps(db)
  // Move any holiday event still sitting at a date an older build got wrong.
  useHolidayRepair(db, profile, events, setEvents, eventsReady)
  const [selectedDate,  setSelectedDate]  = useState(todayStr())
  const [viewDate,      setViewDate]      = useState(() => {
    const t = new Date(); return { y: t.getFullYear(), m: t.getMonth() }
  })
  const [modal,         setModal]         = useState(null)
  const [newGroupOpen,  setNewGroupOpen]  = useState(false)
  const [settingsGroup, setSettingsGroup] = useState(null)
  const [blockedToast,  setBlockedToast]  = useState(false)
  // A join that was refused or that never landed (TODO #119). { message, tone }.
  const [joinToast,     setJoinToast]     = useState(null)
  const [pendingApprovalGroups, setPendingApprovalGroups] = useState(() => new Set())
  const [qrGroup,       setQrGroup]       = useState(null)  // { group, link }
  const [joinOpen,       setJoinOpen]       = useState(false)
  const [joinPasteMode,  setJoinPasteMode]  = useState(false)
  const [pendingJoin,    setPendingJoin]    = useState(null)  // { url, groupName }
  const closePendingJoinRef = useRef(null)
  const groupsRef = useRef(groups)
  useEffect(() => { groupsRef.current = groups }, [groups])
  const [onboardStep,   setOnboardStep]   = useState(0)
  const showOnboarding = ready && !profile?.onboardingComplete
  // QR scan mode flag (TODO #11 Phase 4). Default is null → existing invite-join
  // behavior. Setters from OnboardingModal / ProfileTab flip this to 'pair' before
  // calling `sync.qrScan()`, and the global `qrScanResult` handler branches on it.
  const qrScanModeRef = useRef(null)
  // Onboarding sub-mode back handler. OnboardingModal sets this to a function
  // that returns true if a restore sub-screen (menu / pair / manual) was popped,
  // false if already at the Slide-0 root. The App-level back handler at :839
  // calls it before the per-slide step decrement so back gesture unwinds the
  // sub-screens first, same pattern as closeXxxSheetRef for bottom sheets.
  const closeOnboardSubModeRef = useRef(null)
  const [showDonationReminder, setShowDonationReminder] = useState(false)
  const [showEncryptionNotice, setShowEncryptionNotice] = useState(false)
  const tabHistoryRef  = useRef([])
  const tabRef         = useRef('calendar')
  const backHandlerRef = useRef(null)
  const closeAboutSheetRef  = useRef(null)
  const closeJoinSheetRef   = useRef(null)
  const closeInviteSheetRef = useRef(null)
  const closeNewGroupSheetRef = useRef(null)
  const [groupCreatedToast, setGroupCreatedToast] = useState(null) // null | { group }
  const [confirmSheet, setConfirmSheet] = useState(null) // null | { title, message, icon, confirmLabel, dangerous, onConfirm }
  const closeConfirmSheetRef = useRef(null)
  const [infoSheet, setInfoSheet] = useState(null) // null | { title, message, icon }
  const closeInfoSheetRef = useRef(null)
  const [scopeSheet, setScopeSheet] = useState(null) // null | { ev }
  const closeScopeSheetRef = useRef(null)
  const [deleteScopeSheet, setDeleteScopeSheet] = useState(null) // null | { ev, isCreator }
  const closeDeleteScopeSheetRef = useRef(null)
  const closeEventModalRef = useRef(null)
  const closeGroupSettingsRef = useRef(null)
  const closeFullGridRef = useRef(null)
  const goTab = (t) => { tabHistoryRef.current.push(tabRef.current); tabRef.current = t; setTab(t) }
  const [readyGroupKeys, setReadyGroupKeys] = useState(() => new Set())
  const [blindPeerKey,   setBlindPeerKey]   = useState(null)
  const [syncingGroups,  setSyncingGroups]  = useState(() => new Set())

  const localeUse24h = !new Intl.DateTimeFormat([], { hour: 'numeric' }).format(0).match(/am|pm/i)
  const use24h    = profile?.use24h ?? localeUse24h
  const weekStart = profile?.weekStart ?? 0

  // ── Bootstrap: load everything from Hyperbee ────────────────────────────────
  useEffect(() => {
    if (!db) { setReady(true); return }   // no DB (e.g. storybook/dev preview)
    let cancelled = false

    async function load () {
      try {
        const [prof, grps, evts, bpk, rsvps, pendingApprovals] = await Promise.all([
          db.getProfile(),
          db.listGroups(),
          db.listEvents(),
          db.getBlindPeerKey().catch(() => null),
          db.listMyRsvps().catch(() => ({})),
          db.listPendingApprovals?.().catch(() => []) ?? [],
        ])
        if (cancelled) return
        setProfile(prof)
        if (prof?.dark !== undefined) setDark(prof.dark)
        setGroups(grps)
        setReadyGroupKeys(new Set(grps.map(g => g.id)))
        setEvents(evts)
        setMyRsvps(rsvps ?? {})
        setBlindPeerKey(bpk)
        setPendingApprovalGroups(new Set(pendingApprovals ?? []))
        eventsReady.current = true
        setReady(true)
        // Boot-time tail extension for `repeatForever` series (TODO #82
        // Phase 3). Walks the just-loaded events, finds any series whose
        // tail is within the threshold window, materialises another year
        // of occurrences, and merges them back into local state.
        extendForeverSeriesIfNeeded(evts, db).then(added => {
          if (added.length > 0 && !cancelled) {
            setEvents(prev => {
              const ids = new Set(prev.map(e => e.id))
              return [...prev, ...added.filter(e => !ids.has(e.id))]
            })
          }
          // Boot-time reconcile (TODO #82 Phase 2). Catches events whose
          // alarms expired during a long offline period and re-arms the
          // top-K window from the current canonical state. Run after
          // tail-extension so newly-materialised occurrences are included.
          notifs?.reconcile?.()
        }).catch(() => { notifs?.reconcile?.() })
      } catch (e) {
        if (!cancelled) setError(e.message)
      }
    }

    load()
    return () => { cancelled = true }
  }, [db])

  // ── Re-sync state when a P2P peer pushes new data ──────────────────────────
  useEffect(() => {
    if (!db) return

    function scheduleDefaultReminders (newEvents) {
      if (!newEvents || newEvents.length === 0) return
      ;(async () => {
        const prof = await db.getProfile().catch(() => null)
        const defaultReminder = typeof prof?.defaultReminder === 'number'
          ? prof.defaultReminder : 15
        if (defaultReminder <= 0) return
        // Await each write so reconcile sees the latest state. Sequential
        // is fine here — small N (newly-synced events in one delta).
        for (const ev of newEvents) {
          const existing = await db.getReminders(ev.id).catch(() => [])
          if (!existing || existing.length === 0) {
            await db.putReminders(ev.id, [defaultReminder]).catch(() => {})
          }
        }
        notifs?.reconcile?.()
      })()
    }

    function refreshGroupRecord (groupId) {
      if (!groupId) return
      db.getGroup(groupId).then(g => {
        if (!g) return
        if (g.migratedTo) {
          setGroups(prev => prev.filter(x => x.id !== groupId))
        } else {
          setGroups(prev => {
            const idx = prev.findIndex(x => x.id === groupId)
            if (idx === -1) return [...prev, g]
            const next = prev.slice()
            next[idx] = mergeGroupState(prev[idx], g)
            return next
          })
        }
      }).catch(() => {})
    }

    async function onSync (payload) {
      // Back-compat: accept the legacy bare groupId string shape.
      const groupId = typeof payload === 'string' ? payload : payload?.groupId
      const delta   = (payload && typeof payload === 'object') ? payload.delta : null

      if (!delta || delta.fullReload) {
        // Legacy full-reload path — re-fetch everything for this group.
        const fresh = await db.listEvents()
        setEvents(prev => {
          const prevIds = new Set(prev.map(e => e.id))
          const newEvents = fresh.filter(e =>
            !prevIds.has(e.id) && (e.groups ?? []).includes(groupId) && !e.isShadow
          )
          scheduleDefaultReminders(newEvents)
          return fresh
        })
        refreshGroupRecord(groupId)
        db.listMyRsvps().then(r => setMyRsvps(r ?? {})).catch(() => {})
        return
      }

      // Delta path — patch state directly from the payload.
      const changed = delta.changedEvents ?? []
      const removed = delta.removedIds ?? []
      if (changed.length || removed.length) {
        setEvents(prev => {
          const removedSet = new Set(removed)
          const changedMap = new Map(changed.map(e => [e.id, e]))
          const prevIds = new Set()
          const next = []
          for (const e of prev) {
            if (removedSet.has(e.id)) continue
            prevIds.add(e.id)
            const upsert = changedMap.get(e.id)
            next.push(upsert ?? e)
          }
          const newEvents = []
          for (const e of changed) {
            if (prevIds.has(e.id)) continue
            next.push(e)
            if ((e.groups ?? []).includes(groupId) && !e.isShadow) newEvents.push(e)
          }
          scheduleDefaultReminders(newEvents)
          return next
        })
      }
      if (delta.groupChanged) refreshGroupRecord(groupId)
      if (delta.rsvpsChanged) {
        db.listMyRsvps().then(r => setMyRsvps(r ?? {})).catch(() => {})
      }
    }

    emitter.on('sync', onSync)

    function onSyncing (d) {
      const gid = d?.groupId
      if (!gid) return
      setSyncingGroups(prev => { const s = new Set(prev); s.add(gid); return s })
    }
    function onSynced (d) {
      const gid = d?.groupId
      if (gid) {
        setSyncingGroups(prev => { const s = new Set(prev); s.delete(gid); return s })
      } else {
        setSyncingGroups(new Set())
      }
    }
    emitter.on('syncing', onSyncing)
    emitter.on('synced',  onSynced)

    function onGroupDeleted (groupId) {
      setGroups(prev => prev.filter(g => g.id !== groupId))
      setEvents(prev => prev
        .map(e => ({ ...e, groups: e.groups.filter(gid => gid !== groupId) }))
        .filter(e => e.groups.length > 0))
    }
    emitter.on('groupDeleted', onGroupDeleted)

    function onInviteBlocked () {
      setBlockedToast(true)
      setTimeout(() => setBlockedToast(false), 4000)
    }
    emitter.on('inviteBlocked', onInviteBlocked)

    // TODO #119: these two used to be completely silent. A refused join sat on
    // the "? Inviter" placeholder forever; so did one where the peers never met.
    function onJoinFailed (detail) {
      setJoinToast({ message: detail?.message || 'Could not join that group.', tone: 'error' })
      setTimeout(() => setJoinToast(null), 8000)
    }
    function onJoinStalled (detail) {
      setJoinToast({
        message: 'Still trying to join ' + (detail?.groupName || 'the group')
          + '. No one has responded yet - they may be offline or on an older version.',
        tone: 'warn',
      })
      setTimeout(() => setJoinToast(null), 8000)
    }
    emitter.on('joinFailed', onJoinFailed)
    emitter.on('joinStalled', onJoinStalled)

    async function onGroupJoined(group) {
      setReadyGroupKeys(prev => { const s = new Set(prev); s.add(group.id); return s })
      if (db) {
        const fresh = await db.listGroups()
        setGroups(fresh)
        // Re-mirror Autobase view → local DB in case we previously left
        // and our event cleanup removed entries that Autobase won't re-apply
        await db.resyncGroup(group.id).catch(() => {})
        const evts = await db.listEvents()
        setEvents(evts)
      } else {
        setGroups(prev => {
          if (prev.find(g => g.id === group.id)) return prev
          return [...prev, group]
        })
      }
      setTab('groups')
    }
    emitter.on('group:joined', onGroupJoined)
    // Also listen for DOM event from __pearHandleInvite
    const onDomGroupJoined = (e) => onGroupJoined(e.detail)
    window.addEventListener('pear:groupJoined', onDomGroupJoined)
    const onDomSetTab = (e) => setTab(e.detail)
    window.addEventListener('pear:setTab', onDomSetTab)
    const onDomOpenGroupSettings = (e) => {
      const gid = e.detail
      if (!gid) return
      setTab('groups')
      // Pass a minimal stub — JSX does `groups.find(g => g.id === settingsGroup.id) ?? settingsGroup`
      // and will resolve to the live group record once React re-renders.
      setSettingsGroup(prev => prev?.id === gid ? prev : { id: gid })
    }
    window.addEventListener('pear:openGroupSettings', onDomOpenGroupSettings)
    const onDomPendingJoin = (e) => openPendingJoin(e.detail)
    window.addEventListener('pear:pendingJoin', onDomPendingJoin)
    // Drain any invites buffered before this listener was registered
    // (cold-open race: URL delivered before <App> mounted).
    try {
      const buffered = window.__pearDrainInvites?.() ?? []
      if (buffered.length) openPendingJoin(buffered[buffered.length - 1])
    } catch {}

    function onGroupKeyUpdated(group) {
      // Events carry the raw record, with no syncHealth/keyless on it. Replacing
      // wholesale wiped those and silently dropped the warnings (#155).
      setGroups(prev => prev.map(g => g.id === group.id ? mergeGroupState(g, group) : g))
      setReadyGroupKeys(prev => { const s = new Set(prev); s.add(group.id); return s })
    }
    emitter.on('groupKeyUpdated', onGroupKeyUpdated)
    function onPendingApproval (gid) {
      if (!gid) return
      setPendingApprovalGroups(prev => { const s = new Set(prev); s.add(gid); return s })
    }
    function onPendingApprovalCleared (gid) {
      if (!gid) return
      setPendingApprovalGroups(prev => { const s = new Set(prev); s.delete(gid); return s })
    }
    emitter.on('pendingApproval', onPendingApproval)
    emitter.on('pendingApprovalCleared', onPendingApprovalCleared)

    return () => {
      emitter.off('sync', onSync)
      emitter.off('syncing', onSyncing)
      emitter.off('synced',  onSynced)
      emitter.off('groupDeleted', onGroupDeleted)
      emitter.off('inviteBlocked', onInviteBlocked)
      emitter.off('joinFailed', onJoinFailed)
      emitter.off('joinStalled', onJoinStalled)
      emitter.off('group:joined', onGroupJoined)
      window.removeEventListener('pear:groupJoined', onDomGroupJoined)
      window.removeEventListener('pear:setTab', onDomSetTab)
      window.removeEventListener('pear:openGroupSettings', onDomOpenGroupSettings)
      window.removeEventListener('pear:pendingJoin', onDomPendingJoin)
      emitter.off('groupKeyUpdated', onGroupKeyUpdated)
      emitter.off('pendingApproval', onPendingApproval)
      emitter.off('pendingApprovalCleared', onPendingApprovalCleared)
    }
  }, [db])
  useEffect(() => { tabRef.current = tab }, [tab])

  // Screenshot mode: drive tab/date/modal from preconfigured scene
  const _scene = typeof window !== 'undefined' ? window.__pearScreenshotScene : null
  useEffect(() => {
    if (!_scene) return
    if (_scene.tab) setTab(_scene.tab)
    if (_scene.date) {
      setSelectedDate(_scene.date)
      const [y, m] = _scene.date.split('-')
      setViewDate({ y: parseInt(y), m: parseInt(m) - 1 })
    }
  }, [])
  useEffect(() => {
    if (!_scene?.openEventId || !events.length) return
    const ev = events.find(e => e.id === _scene.openEventId)
    if (ev) setModal({ mode: 'edit', event: { ...ev } })
  }, [events])
  useEffect(() => {
    backHandlerRef.current = () => {
      // Overlays first, deepest-first. Sheets, the QR modal and the full grid all
      // register themselves, so none of them is named here any more.
      if (runBackStack()) return
      if (showOnboarding) {
        // Slide 0 sub-screens (restore menu / pair / manual phrase) get first
        // crack so back gesture unwinds them instead of noop-ing at step 0.
        if (closeOnboardSubModeRef.current?.()) return
        if (onboardStep > 0) { setOnboardStep(s => s - 1); return }
        return  // step 0 root — do nothing, don't exit
      }
      const prev = tabHistoryRef.current.pop()
      if (prev) { tabRef.current = prev; setTab(prev); return }
      window.ReactNativeWebView?.postMessage(JSON.stringify({ method: 'exitApp', id: -1 }))
    }
  }, [showOnboarding, onboardStep])
  useEffect(() => { window.__pearBack = () => backHandlerRef.current?.() }, [])
  useEffect(() => { window.__pearSync = sync }, [sync])
  useEffect(() => {
    function onQrScanResult(url) {
      if (!url || !db || !sync) return
      const mode = qrScanModeRef.current
      qrScanModeRef.current = null
      if (mode === 'seederPair') {
        // Scanned a blind peer's QR. Hand to the worklet: join the rendezvous,
        // verify the seeder pubkey, push our seed bundle. Broadcast progress +
        // result so the BlindPeerSheet can reflect it.
        emitter.emit('seederPairResult', { pending: true })
        db.seederPairScan(url)
          .then(r => emitter.emit('seederPairResult', r || { ok: false, error: 'no result' }))
          .catch(e => emitter.emit('seederPairResult', { ok: false, error: e?.message || 'pairing failed' }))
        return
      }
      if (mode === 'pair') {
        // Pair-mode: URL must be pearcal://pair. Hand to bare worklet which
        // verifies the handshake, installs the mnemonic + personal base, and
        // emits pairingCompleted / pairingFailed. The OnboardingModal is the
        // caller in this PR; it subscribes to those events to advance slides.
        db.consumePairLink(url).catch(e => {
          console.warn('[pair] consumePairLink error:', e?.message)
        })
        return
      }
      openPendingJoin(url)
    }
    emitter.on('qrScanResult', onQrScanResult)
    function onCameraResult (base64) {
      if (activeCameraConsumer.current) {
        activeCameraConsumer.current(base64)
        activeCameraConsumer.current = null
      } else if (base64) {
        // Preserve animated formats — canvas would flatten to a static frame.
        const animated = base64.startsWith('data:image/gif') || base64.startsWith('data:image/webp')
        if (animated) {
          updateProfileRef.current({ avatar: base64 }).catch(() => {})
        } else {
          downscaleAvatarDataUrl(base64)
            .then(small => updateProfileRef.current({ avatar: small }))
            .catch(() => updateProfileRef.current({ avatar: base64 }).catch(() => {}))
        }
      }
    }
    emitter.on('cameraResult', onCameraResult)
    return () => { emitter.off('qrScanResult', onQrScanResult); emitter.off('cameraResult', onCameraResult) }
  }, [db, sync])

  // ── Expose global bridge for Android → JS calls ────────────────────────────
  useEffect(() => {
    if (!db || !sync) return
    window.__pearCal = {
      handleLink: url => openPendingJoin(url),
      restoreNotifications: () => notifs?.restoreAll(),
      navigateTo: (type, id) => {
        if (type === 'event') {
          const ev = events.find(e => e.id === id)
          if (ev) { setSelectedDate(ev.date); setTab('calendar') }
        }
      },
    }
    return () => { delete window.__pearCal }
  }, [db, sync, notifs, events])

  // ─── Mutation helpers ───────────────────────────────────────────────────────

  // Forward call is installed into this ref after forwardBusyTime is declared,
  // so saveEvent can reach it despite being declared first.
  const forwardBusyTimeRef = useRef(null)

  const saveEvent = useCallback((ev, scope = 'one', options = {}, reminders = []) => {
    const { _prevDate, _myForwards, ...evClean } = ev
    ev = evClean
    // Detect frequency change on a series-occurrence edit (TODO #80). When
    // the user changes the cadence rule, PROPAGATE-patching existing occurrence
    // rows would leave them on the OLD dates but tagged with the NEW frequency
    // — semantically broken. Instead we tombstone the affected old occurrences
    // and regenerate fresh ones using a versioned id (`{rid}_v{V}_r{N}`) so
    // peer tombstones don't suppress the new puts.
    const original = events.find(e => e.id === ev.id)
    const frequencyChanged = !!ev.recurrenceId && !!original && (
      original.recurrence !== ev.recurrence ||
      (original.recurrenceNth ?? 0) !== (ev.recurrenceNth ?? 0) ||
      (original.recurrenceWeekday ?? 0) !== (ev.recurrenceWeekday ?? 0) ||
      (original.recurrenceInterval ?? 1) !== (ev.recurrenceInterval ?? 1)
    )
    // End-date / repeat-forever change on a series (TODO #102 follow-up). Like a
    // frequency change, this can't be a metadata patch — extending the end must
    // ADD occurrences and shortening must DROP them — so route it through the
    // same tombstone-and-regenerate path below.
    const endChanged = !!ev.recurrenceId && !!original && (
      (original.recurrenceEnd ?? '') !== (ev.recurrenceEnd ?? '') ||
      !!original.repeatForever !== !!ev.repeatForever
    )

    let occurrences
    let toDelete = []

    if (ev.recurrence && ev.recurrence !== 'none' && (ev.recurrenceEnd || ev.repeatForever) && !ev.recurrenceId) {
      // First-time series creation
      occurrences = expandRecurring(ev)
    } else if ((frequencyChanged || endChanged) && ev.recurrenceId && (scope === 'future' || scope === 'all')) {
      const seriesOccs = events.filter(e => !e.isShadow && e.recurrenceId === ev.recurrenceId)
      let anchorDate = ev.date
      if (scope === 'all') {
        const sorted = [...seriesOccs].sort((a, b) => a.date.localeCompare(b.date))
        anchorDate = sorted[0]?.date ?? ev.date
        toDelete = [...seriesOccs]
      } else {
        toDelete = seriesOccs.filter(e => e.date >= ev.date)
      }
      // Pick a fresh version suffix that doesn't collide with prior regens.
      let maxVersion = 1
      for (const occ of seriesOccs) {
        const m = occ.id.match(/_v(\d+)/)
        if (m) {
          const v = parseInt(m[1], 10)
          if (v > maxVersion) maxVersion = v
        }
      }
      const newRootId = ev.recurrenceId + '_v' + (maxVersion + 1)
      const template = { ...ev, id: newRootId, date: anchorDate, recurrenceId: '' }
      occurrences = expandRecurring(template).map(o => ({ ...o, recurrenceId: ev.recurrenceId }))
    } else if ((scope === 'future' || scope === 'all') && ev.recurrenceId) {
      // Non-frequency-change edit on a series — PROPAGATE patch.
      const PROPAGATE = ['title','allDay','endDate','start','end','reminder',
                         ...(options.propagateGroups ? ['groups','invitees'] : []),
                         'color','desc','location','recurrence','recurrenceEnd',
                         'repeatForever','recurrenceNth','recurrenceWeekday','recurrenceInterval','editPermission']
      const patch = {}
      for (const k of PROPAGATE) patch[k] = ev[k]
      occurrences = events
        .filter(e => e.recurrenceId === ev.recurrenceId && (scope === 'all' || e.date >= ev.date))
        .map(e => ({ ...e, ...patch }))
    } else {
      occurrences = [ev]
    }
    const withAuthor = occurrences.map(occ => ({
      ...occ, updatedByName: profile?.name ?? 'Someone', updatedById: profile?.id ?? ''
    }))
    // Optimistic UI: update calendar and close modal immediately (no async blocking).
    // On iOS, Autobase.append() and even notification IPC can stall, so we never
    // await them on the hot path. All persistence happens fire-and-forget below.
    setEvents(prev => {
      let next = [...prev]
      if (toDelete.length > 0) {
        const delIds = new Set(toDelete.map(e => e.id))
        next = next.filter(e => !delIds.has(e.id))
      }
      if (_prevDate && _prevDate !== ev.date) {
        next = next.filter(e => !(e.id === ev.id && e.date === _prevDate))
      }
      for (const occ of withAuthor) {
        const i = next.findIndex(e => e.id === occ.id)
        if (i >= 0) next[i] = occ
        else next.push(occ)
      }
      return next
    })
    setModal(null)
    // Background: persist to local DB, schedule notifications, fire P2P sync.
    // Wrapped in an async IIFE so we can `await` the local writes before the
    // top-K reconcile reads from the DB (TODO #82 Phase 2). Without these
    // awaits the worklet's IPC dispatcher races: it processes putReminders /
    // putEvent / computeUpcomingReminders concurrently, so the reconcile can
    // read before the writes commit and miss the just-saved reminders.
    if (db) {
      ;(async () => {
        // Tombstone old occurrences from a frequency-change regeneration
        // (TODO #80) BEFORE putting the new ones, so peers process the deletes
        // first. The new occurrences live under versioned ids that don't
        // collide with the tombstoned old ones.
        for (const occ of toDelete) {
          await db.deleteEvent(occ.date, occ.id).catch(e => console.warn('[REGEN-DEL-ERR]', e?.message))
          for (const gid of occ.groups ?? []) {
            sync?.deleteEvent(gid, occ.id, occ.date, profile?.name ?? 'Someone', profile?.id ?? '', occ.recurrenceId ?? '', occ.title ?? '').catch(() => {})
          }
        }
        // A date change is handed to putEvent as `_prevDate` and relocates the
        // row there. It used to be a deleteEvent(_prevDate) before the put, but
        // deleteEvent cleans up by event id, so it tombstoned the id and wiped
        // the reminders, private note and RSVPs of the row being written at the
        // new date - and on a paired device the replicated delete beat the put
        // and lost the event for good (issue #264).
        // Reminders are series-keyed (TODO #82 Phase 1) — write once per save
        // instead of per-occurrence. Use the series root id when available so
        // every occurrence resolves to the same record.
        if (withAuthor.length > 0) {
          const reminderId = withAuthor[0].recurrenceId || withAuthor[0].id
          await db.putReminders(reminderId, reminders).catch(() => {})
        }
        for (const occ of withAuthor) {
          // Only the edited occurrence moved. Series siblings keep their own
          // dates, so they must not be told they came from _prevDate.
          const occToPut = (_prevDate && occ.id === ev.id) ? { ...occ, _prevDate } : occ
          await db.putEvent(occToPut).catch(e => console.warn('[PUT-EVENT-ERR]', e?.message))
          // Cancel any pre-Phase-2 alarms scheduled under the legacy notifId
          // range so they don't double-fire alongside the new top-K alarms.
          notifs?.cancelForEvent(occ.id).catch(() => {})
          const evToSync = occToPut
          for (const gid of occ.groups ?? []) {
            sync?.putEvent(gid, evToSync).catch(e => console.warn('[SYNC-ERR]', e?.message))
          }
          const existingOcc = events.find(e => e.id === occ.id)
          const removedGroups = (existingOcc?.groups ?? []).filter(g => !(occ.groups ?? []).includes(g))
          for (const gid of removedGroups) {
            // scope:'group' — the user unshared this event from `gid`, they did
            // not delete it. Without the scope the peer-side tombstone is global
            // and destroys the copy the event was just moved INTO (TODO #122).
            sync?.deleteEvent(gid, occ.id, occ.date, profile?.name ?? 'Someone', profile?.id ?? '', '', '', 'group').catch(() => {})
          }
        }
        // Single global top-K reconcile. Now safe — all local writes have
        // committed, so computeUpcomingReminders will see them.
        notifs?.reconcile?.()
      })()
      // Fan out busy-time shadows for any forwards the modal passed in. Done
      // here (rather than in handleSave) so expanded occurrences from a new
      // recurring series each get shadows.
      if (_myForwards && _myForwards.length > 0 && forwardBusyTimeRef.current) {
        forwardBusyTimeRef.current(withAuthor, _myForwards)
      }
    }
  }, [db, notifs, sync, profile, events, myRsvps])

  // Forward an event as busy-time into other groups the forwarder belongs to.
  // Shadow id: shadow:{sourceId}:{forwarderId}:{targetGroupId}. Works for creator
  // and non-creator alike; shadow.creatorId is the forwarder. Accepts either a
  // single source event (scans events for recurrence siblings) or an explicit
  // array of occurrences (used by saveEvent to cover not-yet-in-state series).
  const forwardBusyTime = useCallback((sourceOrOccs, newTargetGroupIds) => {
    if (!db || !sync || !profile?.id) return
    const myId = profile.id
    const myName = profile?.name ?? 'Someone'
    const occurrences = Array.isArray(sourceOrOccs)
      ? sourceOrOccs
      : (sourceOrOccs.recurrenceId
          ? events.filter(e => !e.isShadow && e.recurrenceId === sourceOrOccs.recurrenceId)
          : [sourceOrOccs])
    for (const occ of occurrences) {
      const targets = (newTargetGroupIds ?? []).filter(g => !(occ.groups ?? []).includes(g))
      const existingShadows = events.filter(e =>
        e.isShadow && e.sourceEventId === occ.id && e.creatorId === myId)
      const existingTargets = existingShadows.map(e => (e.groups ?? [])[0]).filter(Boolean)
      for (const gid of targets) {
        if (existingTargets.includes(gid)) continue
        const shadow = {
          id: 'shadow:' + occ.id + ':' + myId + ':' + gid,
          isShadow: true,
          sourceEventId: occ.id,
          sourceGroupId: (occ.groups ?? [])[0] ?? '',
          title: occ.title,
          date: occ.date,
          endDate: occ.endDate ?? '',
          allDay: !!occ.allDay,
          start: occ.start, end: occ.end,
          recurrence: occ.recurrence ?? 'none',
          recurrenceId: occ.recurrenceId ?? '',
          recurrenceEnd: occ.recurrenceEnd ?? '',
          recurrenceNth: occ.recurrenceNth ?? 0,
          recurrenceWeekday: occ.recurrenceWeekday ?? 0,
          recurrenceInterval: occ.recurrenceInterval ?? 1,
          groups: [gid],
          invitees: [],
          creatorId: myId,
          editPermission: 'creator',
          rsvpEnabled: false,
          color: occ.color,
          updatedByName: myName,
          updatedById: myId,
        }
        sync.putEvent(gid, shadow).catch(e => console.warn('[SHADOW-ERR]', e?.message))
      }
      const removed = existingTargets.filter(g => !targets.includes(g))
      for (const gid of removed) {
        const shadowId = 'shadow:' + occ.id + ':' + myId + ':' + gid
        db.deleteEvent(occ.date, shadowId).catch(() => {})
        sync.deleteEvent(gid, shadowId, occ.date, myName, myId).catch(() => {})
      }
    }
  }, [db, sync, events, profile])
  forwardBusyTimeRef.current = forwardBusyTime

  const deleteEvent = useCallback(async id => {
    const ev = events.find(e => e.id === id)
    if (!ev) return
    const myId = profile?.id
    const isCreator = ev.creatorId && myId && ev.creatorId === myId
    if (db) {
      if (isCreator) {
        // Creator: delete for everyone via Autobase broadcast
        await db.deleteEvent(ev.date, id)
        await notifs?.cancelForEvent(id)
        for (const gid of ev.groups ?? []) {
          await sync?.deleteEvent(gid, id, ev.date, profile?.name ?? 'Someone', myId ?? '', '', ev.title ?? '').catch(() => {})
        }
      }
      // Always clear my own forwards. Other forwarders will cascade on their
      // own clients via the orphaned-shadow effect.
      if (myId) {
        const myShadows = events.filter(e =>
          e.isShadow && e.sourceEventId === id && e.creatorId === myId)
        for (const sh of myShadows) {
          const gid = (sh.groups ?? [])[0]
          if (!gid) continue
          await db.deleteEvent(sh.date, sh.id).catch(() => {})
          await sync?.deleteEvent(gid, sh.id, sh.date, profile?.name ?? 'Someone', myId).catch(() => {})
        }
      }
      if (!isCreator) {
        // Non-creator: local-only delete + tombstone so resync never resurrects it
        await db.localDeleteEvent(ev.date, id)
        await notifs?.cancelForEvent(id)
      }
    }
    setEvents(prev => prev.filter(e =>
      e.id !== id &&
      !(e.isShadow && e.sourceEventId === id && e.creatorId === myId)))
    setModal(null)
    notifs?.reconcile?.()
  }, [db, notifs, sync, events, profile])

  const deleteEventSeries = useCallback(async recurrenceId => {
    if (!recurrenceId || !db) return
    await db.deleteEventSeries(recurrenceId).catch(() => {})
    const myId = profile?.id
    const seriesEvents = events.filter(e => !e.isShadow && e.recurrenceId === recurrenceId)
    const seriesIds = new Set(seriesEvents.map(e => e.id))
    for (const ev of seriesEvents) {
      await notifs?.cancelForEvent(ev.id)
      const isCreator = ev.creatorId && myId && ev.creatorId === myId
      if (isCreator) {
        for (const gid of ev.groups ?? []) {
          await sync?.deleteEvent(gid, ev.id, ev.date, profile?.name ?? 'Someone', myId ?? '', ev.recurrenceId ?? '', ev.title ?? '').catch(() => {})
        }
      }
    }
    // Clear my own forwards for every occurrence in the series.
    if (myId) {
      const myShadows = events.filter(e =>
        e.isShadow && e.creatorId === myId && seriesIds.has(e.sourceEventId))
      for (const sh of myShadows) {
        const gid = (sh.groups ?? [])[0]
        if (!gid) continue
        await db.deleteEvent(sh.date, sh.id).catch(() => {})
        await sync?.deleteEvent(gid, sh.id, sh.date, profile?.name ?? 'Someone', myId).catch(() => {})
      }
    }
    setEvents(prev => prev.filter(e =>
      e.recurrenceId !== recurrenceId &&
      !(e.isShadow && e.creatorId === myId && seriesIds.has(e.sourceEventId))))
    setModal(null)
    notifs?.reconcile?.()
  }, [db, notifs, sync, events, profile])

  // Keep my busy-time shadows in lockstep with their source events. Runs on
  // every events change: (1) deletes my shadows whose source has disappeared
  // locally (cascade on source-delete); (2) rewrites shadows whose snapshot
  // fields no longer match the current source (cascade on source-edit). This
  // is the only cleanup path for *other* users' forwards of an event I created
  // — the deleter can't touch their records, so each forwarder's client fixes
  // its own shadows here.
  useEffect(() => {
    if (!db || !sync || !profile?.id || events.length === 0) return
    const myId = profile.id
    const myName = profile?.name ?? 'Someone'
    const myGroupIds = new Set((groups ?? []).map(g => g.id))
    const sourceById = new Map()
    for (const e of events) if (!e.isShadow) sourceById.set(e.id, e)
    const myShadows = events.filter(e => e.isShadow && e.creatorId === myId)
    for (const sh of myShadows) {
      const gid = (sh.groups ?? [])[0]
      if (!gid) continue
      const src = sourceById.get(sh.sourceEventId)
      // Migrate legacy 2-segment keys (shadow:src:gid) to 3-segment
      // (shadow:src:forwarderId:gid). Only creators could forward in the old
      // model, so any legacy shadow I "own" (creatorId === myId) is mine.
      const idParts = sh.id.split(':')
      if (idParts.length === 3) {
        const newId = 'shadow:' + sh.sourceEventId + ':' + myId + ':' + gid
        const migrated = {
          ...sh,
          id: newId,
          creatorId: myId,
          title: src?.title ?? sh.title,
          date: src?.date ?? sh.date,
          endDate: (src?.endDate ?? sh.endDate ?? ''),
          allDay: !!(src?.allDay ?? sh.allDay),
          start: src?.start ?? sh.start,
          end: src?.end ?? sh.end,
          color: src?.color ?? sh.color,
          updatedByName: myName,
          updatedById: myId,
        }
        sync.putEvent(gid, migrated).catch(() => {})
        db.deleteEvent(sh.date, sh.id).catch(() => {})
        sync.deleteEvent(gid, sh.id, sh.date, myName, myId).catch(() => {})
        continue
      }
      if (!src) {
        // Cascade-delete when the source is definitively gone. Personal events
        // (sourceGroupId === '') have no group replication to wait on — the
        // forwarder is the source of truth, so missing locally means deleted.
        // Group events: wait until we actually belong to the source group,
        // otherwise the source is just unreplicated (e.g. after mnemonic
        // restore, before we've rejoined the source group).
        const srcGid = sh.sourceGroupId
        if (srcGid && !myGroupIds.has(srcGid)) continue
        db.deleteEvent(sh.date, sh.id).catch(() => {})
        sync.deleteEvent(gid, sh.id, sh.date, myName, myId).catch(() => {})
        continue
      }
      const stale = sh.title !== src.title
        || sh.date !== src.date
        || sh.start !== src.start
        || sh.end !== src.end
        || (sh.endDate ?? '') !== (src.endDate ?? '')
        || !!sh.allDay !== !!src.allDay
      if (!stale) continue
      const updated = {
        ...sh,
        title: src.title,
        date: src.date,
        endDate: src.endDate ?? '',
        allDay: !!src.allDay,
        start: src.start,
        end: src.end,
        recurrence: src.recurrence ?? 'none',
        recurrenceEnd: src.recurrenceEnd ?? '',
        recurrenceNth: src.recurrenceNth ?? 0,
        recurrenceWeekday: src.recurrenceWeekday ?? 0,
        recurrenceInterval: src.recurrenceInterval ?? 1,
        color: src.color,
        updatedByName: myName,
        updatedById: myId,
      }
      // Source moved, so the busy-time shadow follows it. Sent as `_prevDate` on
      // the put, which mirrorToLocal turns into a relocation on every device -
      // this one included, since apply runs on the author too. A local
      // deleteEvent here instead would tombstone the shadow id and then block
      // the very mirror meant to re-place it (issue #264), and peers would keep
      // a stale shadow at the old date.
      const shadowToSync = sh.date !== src.date ? { ...updated, _prevDate: sh.date } : updated
      sync.putEvent(gid, shadowToSync).catch(e => console.warn('[SHADOW-RESYNC-ERR]', e?.message))
    }
  }, [events, db, sync, profile, groups])

  function parseGroupIdFromUrl(url) {
    try {
      const u = new URL(url.replace(/^pear:\/\//, 'https://'))
      const raw = u.searchParams.get('group')
      return raw ? atob(raw) : null
    } catch { return null }
  }

  function urlHasEnc(url) {
    try { return !!new URL(url.replace(/^pear:\/\//, 'https://')).searchParams.get('enc') } catch { return false }
  }

  function openPendingJoin(url) {
    const groupName = (() => { try { return new URL(url.replace(/^pear:\/\//, 'https://')).searchParams.get('name') || 'a group' } catch { return 'a group' } })()
    const gid = parseGroupIdFromUrl(url)
    const existing = gid && groupsRef.current.find(g => g.id === gid)
    if (existing) {
      // Already a member — normally just focus the group. BUT a keyless copy of
      // an encrypted group is the one case where re-consuming an invite is the
      // whole point: an invite carrying `enc=` back-fills the missing key and
      // repairs sync (TODO #124). Let it through to the join flow, which routes
      // into handleInviteLink → repairKeylessGroup. Without this the repair path
      // is unreachable, since every invite entry point funnels through here.
      if (existing.keyless && urlHasEnc(url)) { setPendingJoin({ url, groupName }); return }
      setTab('groups'); return
    }
    setPendingJoin({ url, groupName })
  }

  const joinWithNickname = useCallback(async (url, nickname) => {
    const nick = nickname && nickname !== profile?.name ? nickname : null
    let result
    try {
      result = await handleInviteLink(url, db, sync, g => {
        setTab('groups')
      }, nick)
    } catch (e) {
      // A throw in here used to leave the sheet spinning forever with nothing
      // said: handleJoin only reacts to a returned result, so an exception was
      // indistinguishable from a hang (TODO #145).
      result = { ok: false, error: 'join_threw', reason: e?.message }
    }
    if (result?.ok && result.group) {
      setGroups(prev => prev.find(x => x.id === result.group.id) ? prev : [...prev, result.group])
      setReadyGroupKeys(prev => { const s = new Set(prev); s.add(result.group.id); return s })
      // Re-mirror Autobase view → local DB so pre-existing events sync on rejoin
      db.resyncGroup(result.group.id).catch(() => {}).then(async () => {
        const evts = await db.listEvents()
        setEvents(evts)
      })
    }
    if (result?.error === 'blocked_from_group') { setBlockedToast(true); setTimeout(() => setBlockedToast(false), 4000) }
    // TODO #124: the invite repaired a group we already held but could not
    // decrypt. Refresh from the DB so the warning banner clears and the newly
    // reachable events land.
    if (result?.repaired) {
      db.listGroups().then(gs => setGroups(gs)).catch(() => {})
      db.resyncGroup(result.group.id).catch(() => {}).then(async () => {
        const evts = await db.listEvents().catch(() => null)
        if (evts) setEvents(evts)
      })
    }
    // TODO #145 - dismiss ONLY when there is nothing left to say. This used to
    // run unconditionally, which unmounted the sheet before handleJoin could
    // render anything: the inline error path was structurally dead, so every
    // failed join looked silent no matter what the UI tried to show. That, not
    // the wording, is why a dead end was indistinguishable from a clean join.
    // blocked_from_group is dismissed here because it raises its own toast above.
    if (result?.ok || result?.error === 'blocked_from_group' || isBenignJoinOutcome(result ?? {})) {
      setPendingJoin(null)
    }
    return result
  }, [db, sync, profile])

  const addGroup = useCallback(async (g, opts) => {
    if (db) {
      // Owner-create path writes group+members+joins via sync.createGroup on
      // the Bare side; skip the redundant IPC round-trips here.
      if (!opts?.alreadyJoined) {
        await db.putGroup(g)
        for (const m of g.members) await db.putMember(g.id, m)
        await sync?.joinGroup(g).catch(() => {})
      }
    }
    if (!opts?.pendingKey) {
      setReadyGroupKeys(prev => { const s = new Set(prev); s.add(g.id); return s })
    }
    setGroups(prev => prev.some(x => x.id === g.id) ? prev : [...prev, g])
  }, [db, sync])

  const updateGroup = useCallback(async updated => {
    if (db) {
      // Diff members: find removed vs added vs unchanged
      const prev   = groups.find(g => g.id === updated.id)
      const oldIds = new Set((prev?.members ?? []).map(m => m.id))
      const newIds = new Set(updated.members.map(m => m.id))

      // Persist updated group record
      await db.putGroup(updated)

      // Sync member table
      for (const m of updated.members) {
        if (!oldIds.has(m.id)) await db.putMember(updated.id, m)
      }
      for (const m of (prev?.members ?? [])) {
        if (!newIds.has(m.id)) await db.removeMember(updated.id, m.id)
      }

      // Broadcast updated group record to peers
      await sync?.putGroup(updated).catch(() => {})
    }
    setGroups(prev => prev.map(g => g.id === updated.id ? mergeGroupState(g, updated) : g))
    setSettingsGroup(prev => prev?.id === updated.id ? updated : prev)
  }, [db, sync, groups])

  const deleteGroup = useCallback(async (id, action = 'delete') => {
    if (db) {
      const g = groups.find(x => x.id === id)
      const isOwner = g?.ownerId === profile?.id
      if (action === 'delete' && isOwner) {
        // Owner: broadcast delete to all members
        await sync?.deleteGroup(id).catch(() => {})
      } else if (action === 'leave' && !isOwner) {
        // Non-owner leaving: update local DB then broadcast via Protomux (bypasses Autobase writability)
        const updatedMembers = (g?.members ?? []).filter(m => m.id !== profile?.id)
        const updatedGroup = { ...g, members: updatedMembers, updatedAt: Date.now() }
        await db.putGroup(updatedGroup).catch(() => {})
        await sync?.memberLeft(id, profile.id).catch(() => {})
      }
      await db.deleteGroup(id)
      await sync?.leaveGroup(id).catch(() => {})
    }
    setGroups(prev => prev.filter(g => g.id !== id))
    // Scrub group from events; remove events that now belong to no group
    setEvents(prev => prev
      .map(e => ({ ...e, groups: e.groups.filter(gid => gid !== id) }))
      .filter(e => e.groups.length > 0))
    setSettingsGroup(null)
  }, [db, sync, groups, profile])

  const removeBrokenGroup = useCallback(async (id) => {
    if (sync?.removeBrokenGroup) await sync.removeBrokenGroup(id).catch(() => {})
    setGroups(prev => prev.filter(g => g.id !== id))
    setEvents(prev => prev
      .map(e => ({ ...e, groups: e.groups.filter(gid => gid !== id) }))
      .filter(e => e.groups.length > 0))
    setSettingsGroup(null)
  }, [sync])

  const removeMember = useCallback(async (g, uid) => {
    const removedMember = g.members.find(m => m.id === uid)
    const removedEntry = removedMember
      ? { ...removedMember }
      : { id: uid, name: 'Member', avatar: '?' }
    const removedMembers = [...(g.removedMembers ?? []), removedEntry]
    const updatedGroup = { ...g, members: g.members.filter(m => m.id !== uid), removedMembers, updatedAt: Date.now() }
    await updateGroup(updatedGroup)
    await sync?.memberLeft(g.id, uid).catch(() => {})
  }, [updateGroup, sync])

  const purgeMember = useCallback(async (g, memberId) => {
    const updated = {
      ...g,
      removedMembers: (g.removedMembers ?? []).filter(m => (m.id ?? m) !== memberId),
    }
    await updateGroup(updated)
    await sync?.purgeMember(g.id, memberId).catch(() => {})
  }, [updateGroup, sync])

  const updateProfile = useCallback(async updates => {
    if (db) {
      // Only generate initials if: (a) name changed AND (b) no photo is being set AND (c) no photo already stored
      const hasPhoto = updates.avatar?.startsWith?.('data:') || profile?.avatar?.startsWith?.('data:')
      const settingPhoto = updates.avatar?.startsWith?.('data:')
      if (updates.name && !hasPhoto) {
        updates = { ...updates, avatar: (updates.name ?? '').trim().split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0,2) || '?' }
      }
      await db.updateProfile(updates)
      // Update member record in all groups where we appear
      const updatedProfile = { ...profile, ...updates }
      for (const g of groups) {
        const isMember = g.members?.some(m => m.id === updatedProfile.id)
        if (isMember) {
          // For member avatar: use photo if set, otherwise regenerate initials from current name
          const memberAvatar = settingPhoto
            ? updatedProfile.avatar
            : (updatedProfile.avatar?.startsWith?.('data:') ? updatedProfile.avatar
                : (updatedProfile.name ?? '').trim().split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0,2) || '?')
          // Null avatarHash so a prior dedup ref doesn't outlive the avatar change.
          // On a new photo, appendGroupWithAvatarSplit repopulates the hash via sync.
          const updatedMember = { id: updatedProfile.id, name: updatedProfile.name, avatar: memberAvatar, avatarHash: null }
          await db.putMember(g.id, updatedMember).catch(() => {})
          const updatedGroup = { ...g, members: g.members.map(m => m.id === updatedProfile.id ? { ...m, ...updatedMember, avatarHash: null } : m), updatedAt: Date.now() }
          // Write updated group to local DB so sync reload gets correct data
          await db.putGroup(updatedGroup).catch(() => {})
          // Retry sync a few times in case Autobase isn't writable yet
          const trySyncGroup = async (attempts = 0) => {
            try {
              await sync?.putGroup(updatedGroup)
}
            catch(e) {
              if (attempts < 5) setTimeout(() => trySyncGroup(attempts + 1), 2000)
            }
          }
          trySyncGroup()
        }
      }
    }
    const updatedProfile2 = { ...profile, ...updates }
    setProfile(prev => ({ ...prev, ...updates }))
    const memberAvatarForState = updatedProfile2.avatar?.startsWith?.('data:')
      ? updatedProfile2.avatar
      : (updatedProfile2.name ?? '').trim().split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0,2) || '?'
    setGroups(prev => prev.map(g => ({
      ...g,
      members: g.members?.map(m => m.id === updatedProfile2.id ? { ...m, name: updatedProfile2.name, avatar: memberAvatarForState, avatarHash: null } : m) ?? []
    })))
  }, [db, profile, groups, sync])
  const updateProfileRef = useRef(updateProfile)
  updateProfileRef.current = updateProfile

  // ─── Calendar helpers ───────────────────────────────────────────────────────
  const calDays = useMemo(() => {
    const { y, m } = viewDate
    const first    = new Date(y, m, 1).getDay()
    const firstAdj = (first - weekStart + 7) % 7
    const last     = new Date(y, m + 1, 0).getDate()
    const prevLast = new Date(y, m, 0).getDate()
    const cells = []
    const prevM = m === 0 ? 11 : m - 1
    const prevY = m === 0 ? y - 1 : y
    const nextM = m === 11 ? 0 : m + 1
    const nextY = m === 11 ? y + 1 : y
    for (let i = 0; i < firstAdj; i++)
      cells.push({ d: prevLast - firstAdj + 1 + i, y: prevY, m: prevM, type: 'prev' })
    for (let d = 1; d <= last; d++)
      cells.push({ d, y, m, type: 'cur' })
    let nextD = 1
    while (cells.length < 42)
      cells.push({ d: nextD++, y: nextY, m: nextM, type: 'next' })
    return cells
  }, [viewDate, weekStart])

  const hiddenShadowIds = useMemo(() => {
    const haveSource = new Set(events.filter(e => !e.isShadow).map(e => e.id))
    const hidden = new Set()
    for (const e of events) {
      if (!e.isShadow) continue
      // Hide a shadow only when the underlying source event is locally
      // present. A restored owner may not have rejoined the source group yet —
      // their forwarder-shadow is the only proxy for the event, so keep it
      // visible until the source actually shows up. See TODO #86.
      if (e.sourceEventId && haveSource.has(e.sourceEventId)) hidden.add(e.id)
    }
    return hidden
  }, [events])
  const eventsOnDate = d => events.filter(e => e.date <= d && (e.endDate || e.date) >= d && !hiddenShadowIds.has(e.id))

  function openCreate (date, startTime) {
    let defaultStart, defaultEnd
    if (startTime) {
      defaultStart = startTime
      const h = parseInt(startTime.split(':')[0])
      defaultEnd = String((h + 1) % 24).padStart(2, '0') + ':00'
    } else {
      const now = new Date()
      const nextHour = new Date(now.getTime() + (60 - now.getMinutes()) * 60000)
      nextHour.setSeconds(0, 0)
      const hh = String(nextHour.getHours()).padStart(2, '0')
      defaultStart = hh + ':00'
      defaultEnd = String((nextHour.getHours() + 1) % 24).padStart(2, '0') + ':00'
    }
    setModal({ mode:'create', event:{
      id: 'e' + Date.now(), title:'', date: date || selectedDate,
      allDay:false, start:defaultStart, end:defaultEnd, reminder: 0,
      groups:[], invitees:[], color:'#6C9BF5', desc:'', location:'', meetingLink:'', creatorId: profile?.id ?? 'unknown', recurrence:'none', recurrenceId:'', recurrenceEnd:'', recurrenceNth:0, recurrenceWeekday:0, recurrenceInterval:1, editPermission:'creator', endDate:'', rsvpEnabled:false,
    }})
  }

  // ─── Loading / error states ─────────────────────────────────────────────────
  if (error) return (
    <div style={{ fontFamily:FONT, display:'flex', alignItems:'center', justifyContent:'center',
      minHeight:'100dvh', background:'#111', color:'#D45F7A', flexDirection:'column', gap:12, padding:24 }}>
      <span style={{ fontSize:32 }}>⚠️</span>
      <span style={{ fontSize:16 }}>Failed to load PearCal</span>
      <span style={{ fontSize:12, color:'#888', fontFamily:'monospace' }}>{error}</span>
    </div>
  )

  useEffect(() => {
    if (!ready || !profile || !profile.onboardingComplete) return
    if (profile.donationReminderShown) return
    const TWO_WEEKS = 14 * 24 * 60 * 60 * 1000
    if (Date.now() - (profile.createdAt ?? Date.now()) >= TWO_WEEKS) {
      setShowDonationReminder(true)
    }
  }, [ready, profile?.onboardingComplete, profile?.donationReminderShown])

  // One-time notice after updating to the version that made new groups
  // encrypted (proposal 2026-07-15-pearcal-seeder-port). Existing users need to
  // know new groups require everyone on this version+, so an older member won't
  // see a new group until they update (or it's recreated). New onboarders get
  // the flag pre-set at onboarding complete, so they never see it.
  useEffect(() => {
    if (!ready || !profile || !profile.onboardingComplete) return
    if (profile.encryptionNoticeSeen) return
    setShowEncryptionNotice(true)
  }, [ready, profile?.onboardingComplete, profile?.encryptionNoticeSeen])

  // Plain dark screen while the WebView data loads. Matches the RN loading
  // screen background (#111) so the handoff is seamless, with no second icon
  // flashing between the native loading screen and the calendar.
  if (!ready) return (
    <div style={{ minHeight:'100dvh', background:'#111' }} />
  )

  // ─── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{ fontFamily:FONT, height:'100dvh', background: colors.surface.base,
      display:'flex', flexDirection:'column', alignItems:'center', overflow:'hidden' }}>
      <div style={{ width:'100%', maxWidth:430, height:'100dvh', display:'flex', flexDirection:'column', background: colors.surface.base,
        paddingTop:'var(--sat)', paddingBottom:'var(--sab)' }}>

        {/* Content */}
        <div style={{ flex:1, overflowY: tab === 'calendar' ? 'hidden' : 'auto', paddingBottom: tab === 'calendar' ? 0 : 72, minHeight:0, WebkitOverflowScrolling: 'touch' }}>
          <div key={tab} style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden',
            animation: 'pearFadeIn 100ms var(--easing) both', height: tab === 'calendar' ? '100%' : 'auto' }}>
          {tab === 'calendar' && (
            <CalendarTab viewDate={viewDate} setViewDate={setViewDate}
              calDays={calDays} selectedDate={selectedDate} setSelectedDate={setSelectedDate}
              eventsOnDate={eventsOnDate} todayStr={todayStr()} dateStr={dateStr}
              selectedEvents={eventsOnDate(selectedDate)} openCreate={openCreate}
              setModal={setModal} events={events} groups={groups} use24h={use24h} weekStart={weekStart} eventsReady={eventsReady}
              saveEvent={saveEvent} profile={profile} sync={sync} myRsvps={myRsvps} myProfileId={profile?.id}
              closeFullGridRef={closeFullGridRef} />
          )}
          {blockedToast && (
            <div style={{ position:'fixed', bottom:'calc(53px + var(--safe-area-bottom) + 16px)',
              left:'50%', transform:'translateX(-50%)',
              width:'calc(100% - 32px)', maxWidth:398,
              background:'var(--color-destructive)', color:'#fff', borderRadius:'var(--radius-lg)',
              padding:'12px 16px', fontSize:13, zIndex:400,
              textAlign:'center', lineHeight:1.5 }}>
              You were removed from this group and cannot rejoin with this link.
            </div>
          )}
          {joinToast && (
            <div style={{ position:'fixed', bottom:'calc(53px + var(--safe-area-bottom) + 16px)',
              left:'50%', transform:'translateX(-50%)',
              width:'calc(100% - 32px)', maxWidth:398,
              background: joinToast.tone === 'error' ? 'var(--color-destructive)' : 'var(--color-surface-card)',
              color: joinToast.tone === 'error' ? '#fff' : 'var(--color-text)',
              border: joinToast.tone === 'error' ? 'none' : `1px solid ${colors.border}`,
              borderRadius:'var(--radius-lg)',
              padding:'12px 16px', fontSize:13, zIndex:400,
              textAlign:'center', lineHeight:1.5 }}>
              {joinToast.message}
            </div>
          )}
          {syncingGroups.size > 0 && (
            <div style={{ position:'fixed', top:'calc(var(--safe-area-top) + 8px)',
              left:'50%', transform:'translateX(-50%)',
              background:colors.surface.card ?? 'var(--color-surface-card)',
              border:`1px solid ${colors.border}`,
              borderRadius:'var(--radius-lg)',
              padding:'6px 12px', fontSize:12, zIndex:400,
              display:'flex', alignItems:'center', gap:8,
              color: colors.text.primary }}>
              <Spinner size={12} /> Syncing…
            </div>
          )}
          {tab === 'groups' && (
            <GroupsTab groups={groups} profile={profile} sync={sync} db={db} readyGroupKeys={readyGroupKeys}
              pendingApprovalGroups={pendingApprovalGroups}
              onNewGroup={() => setNewGroupOpen(true)}
              onSettings={g => setSettingsGroup({ ...g })}
              onQrGroup={g => setQrGroup(g)}
              closeInviteSheetRef={closeInviteSheetRef}
              onJoined={g => {
                setGroups(prev => prev.find(x => x.id === g.id) ? prev : [...prev, g])
                setReadyGroupKeys(prev => { const s = new Set(prev); s.add(g.id); return s })
              }}
              joinOpen={joinOpen} setJoinOpen={setJoinOpen} />
          )}
          {tab === 'profile' && (
            <ProfileTab profile={profile} groups={groups} onUpdateProfile={updateProfile}
              db={db} events={events} setEvents={setEvents} dark={dark} sync={sync} saveEvent={saveEvent}
              blindPeerKey={blindPeerKey} setBlindPeerKey={setBlindPeerKey}
              qrScanModeRef={qrScanModeRef}
              onToggleDark={() => { const nd = !dark; setDark(nd); updateProfile({ dark: nd }) }} />
          )}
          {tab === 'about' && (
            <AboutTab sync={sync} closeSheetRef={closeAboutSheetRef} onReplayTour={() => { updateProfile({ tourPending: true }); goTab('calendar') }} />
          )}
          </div>
        </div>

        {/* Bottom Nav */}
        <div style={{
          position: 'fixed', bottom: 0, left: '50%', transform: 'translateX(-50%)',
          width: '100%', maxWidth: 430,
          background: 'var(--color-bg)',
          display: 'flex',
          borderTop: '1px solid var(--color-border)',
          paddingBottom: 'var(--safe-area-bottom)',
          zIndex: 50,
        }}>
          {[
            { key: 'calendar', Icon: CalendarBlank, label: 'Calendar' },
            { key: 'groups',   Icon: Users,         label: 'Groups'   },
            { key: 'profile',  Icon: User,          label: 'Profile'  },
            { key: 'about',    Icon: Info,          label: 'About'    },
          ].map(t => {
            const isActive = tab === t.key
            return (
              <button key={t.key} onClick={() => goTab(t.key)}
                data-tour={'nav-' + t.key}
                style={{
                  flex: 1, padding: '10px 0 8px', border: 'none', cursor: 'pointer',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
                  fontFamily: FONT, background: 'none', position: 'relative',
                }}>
                {isActive && (
                  <div style={{
                    position: 'absolute', top: 0, left: '50%', transform: 'translateX(-50%)',
                    width: 24, height: 2, borderRadius: 1,
                    background: 'var(--color-accent)',
                  }} />
                )}
                <t.Icon
                  size={20}
                  weight="thin"
                  color={isActive ? 'var(--color-accent)' : 'var(--color-muted)'}
                />
                <span style={{
                  fontSize: 10, fontWeight: 400,
                  color: isActive ? 'var(--color-accent)' : 'var(--color-muted)',
                }}>
                  {t.label}
                </span>
              </button>
            )
          })}
        </div>



        {confirmSheet && (
          <ConfirmSheet
           
            title={confirmSheet.title}
            message={confirmSheet.message}
            icon={confirmSheet.icon}
            confirmLabel={confirmSheet.confirmLabel}
            dangerous={confirmSheet.dangerous}
            onConfirm={confirmSheet.onConfirm}
            onDismiss={() => setConfirmSheet(null)}
            closeRef={closeConfirmSheetRef}
          />
        )}

        {infoSheet && (
          <InfoSheet
           
            title={infoSheet.title}
            message={infoSheet.message}
            icon={infoSheet.icon}
            onDismiss={() => setInfoSheet(null)}
            closeRef={closeInfoSheetRef}
          />
        )}

        {scopeSheet && (
          <ScopeSheet ev={scopeSheet.ev}
            onSave={(ev, scope, opts) => saveEvent(ev, scope, opts, scopeSheet.reminders ?? [])}
            onDismiss={() => setScopeSheet(null)}
            closeRef={closeScopeSheetRef} />
        )}

        {deleteScopeSheet && (
          <DeleteScopeSheet
            onChoose={scope => {
              const { ev, isCreator } = deleteScopeSheet
              setDeleteScopeSheet(null)
              if (scope === 'one') {
                if (isCreator) {
                  setConfirmSheet({
                    title: 'Delete Event?',
                    message: 'This event will be permanently deleted for everyone. This cannot be undone.',
                    icon: <Trash size={36} weight="thin" color="var(--color-destructive)" />,
                    confirmLabel: 'Delete',
                    dangerous: true,
                    onConfirm: () => deleteEvent(ev.id),
                  })
                } else {
                  deleteEvent(ev.id)
                }
              } else {
                if (isCreator) {
                  setConfirmSheet({
                    title: 'Delete All in Series?',
                    message: 'All events in this series will be permanently deleted for everyone. This cannot be undone.',
                    icon: <Trash size={36} weight="thin" color="var(--color-destructive)" />,
                    confirmLabel: 'Delete All',
                    dangerous: true,
                    onConfirm: () => deleteEventSeries(ev.recurrenceId),
                  })
                } else {
                  deleteEventSeries(ev.recurrenceId)
                }
              }
            }}
            onDismiss={() => setDeleteScopeSheet(null)}
            closeRef={closeDeleteScopeSheetRef} />
        )}

        {/* Modals */}
        {showOnboarding && <OnboardingModal step={onboardStep} setStep={setOnboardStep}
          profile={profile} onUpdateProfile={updateProfile} db={db} sync={sync}
          qrScanModeRef={qrScanModeRef}
          closeOnboardSubModeRef={closeOnboardSubModeRef}
          onComplete={async () => { await db.updateProfile({ onboardingComplete: true, tourPending: true, encryptionNoticeSeen: true }); const p = await db.getProfile(); setProfile(p) }} />}
        {profile?.tourPending && !showOnboarding && (
          <Tour
            tokens={{
              text: 'var(--color-text)', bg: 'var(--color-bg)',
              surface: 'var(--color-surface)', border: 'var(--color-border)',
              accent: 'var(--color-accent)', muted: 'var(--color-muted)',
              font: FONT,
            }}
            steps={MOBILE_TOUR_STEPS}
            onDone={() => updateProfile({ tourPending: false })}
            onSkip={() => updateProfile({ tourPending: false })}
          />
        )}
        {showDonationReminder && !showOnboarding && (
          <DonationReminderModal sync={sync}
            onDonate={() => {
              updateProfile({ donationReminderShown: true })
              setShowDonationReminder(false)
              goTab('about')
            }}
            onDismiss={() => {
              updateProfile({ donationReminderShown: true })
              setShowDonationReminder(false)
            }}
          />
        )}
        {showEncryptionNotice && !showOnboarding && !showDonationReminder && (
          <EncryptionNoticeModal onDismiss={() => {
            updateProfile({ encryptionNoticeSeen: true })
            setShowEncryptionNotice(false)
          }} />
        )}
        {qrGroup && <QRModal link={qrGroup.link} onClose={() => setQrGroup(null)} />}
        {modal && (
          <EventModal modal={modal} setModal={setModal} groups={groups} profile={profile} db={db}
            events={events} onForward={forwardBusyTime}
            onSave={saveEvent} onDelete={deleteEvent} onDeleteSeries={deleteEventSeries} REMINDER_OPTIONS={REMINDER_OPTIONS}
            closeRef={closeEventModalRef} notifs={notifs} setMyRsvps={setMyRsvps}
            onRequestConfirm={req => {
              if (req.type === 'editScope') {
                setModal(null)
                setScopeSheet({ ev: req.ev, reminders: req.reminders ?? [] })
              } else if (req.type === 'deleteEvent') {
                setModal(null)
                setConfirmSheet({
                  title: 'Delete Event?',
                  message: 'This event will be permanently deleted for everyone. This cannot be undone.',
                  icon: <Trash size={36} weight="thin" color="var(--color-destructive)" />,
                  confirmLabel: 'Delete',
                  dangerous: true,
                  onConfirm: () => deleteEvent(req.ev.id),
                })
              } else if (req.type === 'deleteSeries') {
                setModal(null)
                setConfirmSheet({
                  title: 'Delete All in Series?',
                  message: 'All events in this series will be permanently deleted for everyone. This cannot be undone.',
                  icon: <Trash size={36} weight="thin" color="var(--color-destructive)" />,
                  confirmLabel: 'Delete All',
                  dangerous: true,
                  onConfirm: () => deleteEventSeries(req.ev.recurrenceId),
                })
              } else if (req.type === 'deleteScope') {
                setModal(null)
                setDeleteScopeSheet({ ev: req.ev, isCreator: !!req.isCreator })
              }
            }}
          />
        )}
        {joinOpen && (
          <JoinGroupModal onClose={() => setJoinOpen(false)}
            closeRef={closeJoinSheetRef} db={db} sync={sync}
            onPendingJoin={pj => { setJoinOpen(false); openPendingJoin(pj.url) }}
            onJoined={g => {
              setGroups(prev => prev.find(x => x.id === g.id) ? prev : [...prev, g])
              setReadyGroupKeys(prev => { const s = new Set(prev); s.add(g.id); return s })
            }} />
        )}
        {pendingJoin && (
          <NicknameBeforeJoinSheet groupName={pendingJoin.groupName}
            defaultName={profile?.name ?? ''} closeRef={closePendingJoinRef}
            onConfirm={nickname => joinWithNickname(pendingJoin.url, nickname)}
            onOutcome={o => { setJoinToast(o); setTimeout(() => setJoinToast(null), 8000) }}
            onClose={() => setPendingJoin(null)} />
        )}
        {newGroupOpen && (
          <NewGroupModal onClose={() => setNewGroupOpen(false)}
            onAdd={addGroup} onUpdate={updateGroup} me={profile} sync={sync}
            onCreated={group => setGroupCreatedToast({ group })}
            closeRef={closeNewGroupSheetRef} />
        )}
        {settingsGroup && (
          <GroupSettingsModal group={groups.find(g => g.id === settingsGroup.id) ?? settingsGroup} me={profile} db={db} sync={sync}
            totalGroupsCount={groups.length}
            pendingApproval={pendingApprovalGroups.has(settingsGroup.id)}
            onMemberLeft={async (gid, uid) => sync?.memberLeft(gid, uid).catch(() => {})}
            onClose={() => setSettingsGroup(null)}
            onUpdate={updateGroup} onDelete={deleteGroup}
            onNicknameChange={async (groupId, nick) => {
              await db.setMemberNickname(groupId, nick).catch(() => {})
              setGroups(prev => prev.map(g => g.id === groupId
                ? { ...g, members: (g.members ?? []).map(m => m.id === profile?.id ? { ...m, nickname: nick } : m) }
                : g))
            }}
            closeRef={closeGroupSettingsRef}
            onRequestConfirm={req => {
              // The confirm layers over the settings sheet (it already sits at a higher
              // z-index), so Cancel and Back return you to settings rather than dropping
              // you on the group list. The sheet is dismissed when the action is actually
              // confirmed — the point at which it stops being valid — instead of up front
              // when the confirm is merely raised.
              const raise = (cfg) => setConfirmSheet({
                ...cfg,
                onConfirm: async () => { setSettingsGroup(null); return cfg.onConfirm?.() },
              })
              if (req.type === 'deleteGroup') {
                const otherCount = req.g.members.length - 1
                raise({
                  title: 'Delete Group?',
                  message: otherCount > 0
                    ? `"${req.g.name}" and all shared events will be permanently deleted for you and all ${otherCount} other member${otherCount === 1 ? '' : 's'}. This cannot be undone.`
                    : `"${req.g.name}" and all its events will be permanently deleted. This cannot be undone.`,
                  icon: <Trash size={36} weight="thin" color="var(--color-destructive)" />,
                  confirmLabel: 'Delete',
                  dangerous: true,
                  onConfirm: () => deleteGroup(req.g.id),
                })
              } else if (req.type === 'leaveGroup') {
                raise({
                  title: 'Leave Group?',
                  message: `You'll be removed from "${req.g.name}" and lose access to shared events.`,
                  icon: <SignOut size={36} weight="thin" color="var(--color-destructive)" />,
                  confirmLabel: 'Leave',
                  dangerous: true,
                  onConfirm: () => deleteGroup(req.g.id, 'leave'),
                })
              } else if (req.type === 'removeBrokenGroup') {
                raise({
                  title: 'Remove Broken Group?',
                  message: `"${req.g.name}" will be removed from this device. Local data for this group is already unrecoverable. ${req.g.ownerId === profile?.id ? 'As the owner you will need to recreate the group to continue.' : 'You can rejoin from a fresh invite link.'}`,
                  icon: <Trash size={36} weight="thin" color="var(--color-destructive)" />,
                  confirmLabel: 'Remove',
                  dangerous: true,
                  onConfirm: () => removeBrokenGroup(req.g.id),
                })
              } else if (req.type === 'removeMember') {
                const member = req.g.members.find(m => m.id === req.memberId)
                raise({
                  title: `Remove ${member?.name ?? 'Member'}?`,
                  message: `They will be removed from "${req.g.name}" and lose access to shared events.`,
                  icon: <User size={36} weight="thin" color="var(--color-muted)" />,
                  confirmLabel: 'Remove',
                  dangerous: true,
                  onConfirm: () => removeMember(req.g, req.memberId),
                })
              } else if (req.type === 'purgeMember') {
                const member = (req.g.removedMembers ?? []).find(m => (m.id ?? m) === req.memberId)
                raise({
                  title: `Permanently delete ${member?.name ?? 'member'}?`,
                  message: `This will remove all traces of this member ID from all devices. They can still rejoin with a new invite.`,
                  icon: <Trash size={36} weight="thin" color="#D45F7A" />,
                  confirmLabel: 'Delete',
                  dangerous: true,
                  onConfirm: () => purgeMember(req.g, req.memberId),
                })
              } else if (req.type === 'makeAdmin') {
                setConfirmSheet({
                  title: `Make ${req.memberName ?? 'Member'} Admin?`,
                  message: `They will be able to remove members and manage reinvites in "${req.g.name}".`,
                  icon: <ShieldCheck size={36} weight="thin" color="var(--color-accent)" />,
                  confirmLabel: 'Make Admin',
                  dangerous: false,
                  onConfirm: async () => {
                    const updated = { ...req.g, admins: [...(req.g.admins ?? []), req.memberId], updatedAt: Date.now() }
                    await updateGroup(updated)
                  },
                })
              } else if (req.type === 'rekeyGroup') {
                raise({
                  title: 'Rekey Group?',
                  message: `Rotates "${req.g.name}" onto a fresh group key to reclaim shared history storage. Members auto-migrate on their next sync. Old storage is retained for 14 days, then deleted automatically.`,
                  icon: <Trash size={36} weight="thin" color="var(--color-muted)" />,
                  confirmLabel: 'Rekey',
                  dangerous: true,
                  onConfirm: async () => {
                    try {
                      await sync.rekeyGroup(req.g.id)
                      await sync.commitRekey(req.g.id)
                      const fresh = await db.listGroups()
                      setGroups(fresh)
                      const evts = await db.listEvents()
                      setEvents(evts)
                      setInfoSheet({
                        title: 'Rekey successful',
                        message: 'Other members will automatically migrate on their next sync.',
                        icon: <Check size={36} weight="thin" color="var(--color-accent)" />,
                      })
                    } catch (e) {
                      setInfoSheet({
                        title: 'Rekey failed',
                        message: e?.message ?? String(e),
                        icon: <Warning size={36} weight="thin" color="var(--color-destructive)" />,
                      })
                    }
                  },
                })
              } else if (req.type === 'removeAdmin') {
                setConfirmSheet({
                  title: `Revoke Admin for ${req.memberName ?? 'Member'}?`,
                  message: `They will return to regular member status in "${req.g.name}".`,
                  icon: <ShieldCheck size={36} weight="thin" color="var(--color-muted)" />,
                  confirmLabel: 'Revoke',
                  dangerous: false,
                  onConfirm: async () => {
                    const updated = { ...req.g, admins: (req.g.admins ?? []).filter(id => id !== req.memberId), updatedAt: Date.now() }
                    await updateGroup(updated)
                  },
                })
              } else if (req.type === 'transferOwnership') {
                raise({
                  title: `Transfer ownership to ${req.targetName ?? 'this member'}?`,
                  message: `They will gain the ability to remove members and approve rejoins in "${req.g.name}". You will lose these privileges.`,
                  icon: <Crown size={36} weight="thin" color="var(--color-accent)" />,
                  confirmLabel: 'Transfer',
                  dangerous: true,
                  onConfirm: async () => {
                    try {
                      await sync.transferOwnership(req.g.id, req.targetId)
                    } catch (e) {
                      setInfoSheet({
                        title: 'Transfer failed',
                        message: e?.message ?? String(e),
                        icon: <Warning size={36} weight="thin" color="var(--color-destructive)" />,
                      })
                    }
                  },
                })
              } else if (req.type === 'claimOwnership') {
                const lastTs = req.g.lastOwnerActivityTs ?? req.g.updatedAt ?? 0
                const days = Math.max(0, Math.floor((Date.now() - lastTs) / 86_400_000))
                raise({
                  title: 'Claim ownership?',
                  message: `The current owner of "${req.g.name}" has been inactive for ${days} day${days === 1 ? '' : 's'}. Claiming ownership will give you the ability to remove members and approve rejoins. If the owner returns and writes again before your claim is accepted by other peers, the claim may be rejected.`,
                  icon: <Crown size={36} weight="thin" color="#E5864A" />,
                  confirmLabel: 'Claim',
                  dangerous: true,
                  onConfirm: async () => {
                    try {
                      await sync.claimOwnership(req.g.id)
                    } catch (e) {
                      setInfoSheet({
                        title: 'Claim failed',
                        message: e?.message ?? String(e),
                        icon: <Warning size={36} weight="thin" color="var(--color-destructive)" />,
                      })
                    }
                  },
                })
              }
            }}
          />
        )}
      </div>
    </div>
  )
}

// ─── Utilities ────────────────────────────────────────────────────────────────
// ─── Shared sub-components ────────────────────────────────────────────────────
function Label ({ children }) {
  return <div style={{ fontSize:12, color:colors.text.muted, marginBottom:4, letterSpacing:'0.04em' }}>{children}</div>
}

function Toggle ({ val, onChange, accent }) {
  return (
    <div onClick={() => { window.__pearSync?.haptic('light'); onChange(!val) }}
      style={{ width:44, height:24, borderRadius:'var(--radius-full)', background: val ? accent : colors.track,
        cursor:'pointer', position:'relative', transition:'background 0.2s' }}>
      <div style={{ position:'absolute', top:2, left:val?22:2, width:20, height:20,
        borderRadius:'50%', background:'#fff', transition:'left 0.2s' }} />
    </div>
  )
}

function InfoRow ({ label, val }) {
  return (
    <div style={{ display:'flex', justifyContent:'space-between', padding:'5px 0', borderBottom:`1px solid ${colors.border}` }}>
      <span style={{ fontSize:13, color:colors.text.muted }}>{label}</span>
      <span style={{ fontSize:13, color: colors.text.primary }}>{val}</span>
    </div>
  )
}

function GroupIcon ({ group, size = 42, radius = 12 }) {
  return (
    <div style={{ width:size, height:size, borderRadius:radius, background:group.color,
      overflow:'hidden', display:'flex', alignItems:'center', justifyContent:'center',
      fontSize:size * 0.5, flexShrink:0 }}>
      {group.icon
        ? <img src={group.icon} alt="" style={{ width:'100%', height:'100%', objectFit:'cover' }} />
        : group.emoji}
    </div>
  )
}

/**
 * MemberAvatar — renders a member's avatar circle.
 * If avatar is a base64/data URL, renders as an <img>.
 * Otherwise renders initials text.
 */
function MemberAvatar ({ avatar, avatarHash, name = '?', color = '#6C9BF5', size = 34, fontSize = 13 }) {
  const isPhoto = typeof avatar === 'string' && avatar.startsWith('data:')
  if (isPhoto || !avatarHash) {
    return (
      <div style={{ width:size, height:size, borderRadius:'50%', background:color,
        display:'flex', alignItems:'center', justifyContent:'center',
        overflow:'hidden', flexShrink:0 }}>
        {isPhoto
          ? <img src={avatar} alt={name} style={{ width:'100%', height:'100%', objectFit:'cover' }} />
          : <span style={{ color:'#fff', fontSize, lineHeight:1 }}>{avatar || '?'}</span>
        }
      </div>
    )
  }
  return <MemberAvatarByHash avatarHash={avatarHash} fallback={avatar} name={name} color={color} size={size} fontSize={fontSize} />
}

function MemberAvatarByHash ({ avatarHash, fallback, name, color, size, fontSize }) {
  const [resolved, setResolved] = useState(null)
  useEffect(() => {
    if (!window.__pearResolveAvatar) return
    let cancelled = false
    window.__pearResolveAvatar(avatarHash).then(d => { if (!cancelled) setResolved(d) })
    return () => { cancelled = true }
  }, [avatarHash])
  const isPhoto = typeof resolved === 'string' && resolved.startsWith('data:')
  return (
    <div style={{ width:size, height:size, borderRadius:'50%', background:color,
      display:'flex', alignItems:'center', justifyContent:'center',
      overflow:'hidden', flexShrink:0 }}>
      {isPhoto
        ? <img src={resolved} alt={name} style={{ width:'100%', height:'100%', objectFit:'cover' }} />
        : <span style={{ color:'#fff', fontSize, lineHeight:1 }}>{fallback || '?'}</span>
      }
    </div>
  )
}

/**
 * downscaleAvatarDataUrl — centre-crop + shrink an image data URL to 96×96 webp.
 * Target: <10 KB per avatar. Falls back to JPEG on WebKit < 16 (webp encoding
 * only supported in Safari 16+; older WebViews silently emit PNG which is
 * larger than JPEG for photos).
 */
function downscaleAvatarDataUrl (dataUrl) {
  return new Promise((resolve, reject) => {
    const img = document.createElement('img')
    const timeout = setTimeout(() => reject(new Error('Image load timed out')), 15000)
    img.onload = () => {
      clearTimeout(timeout)
      const SIZE = 96
      const canvas = document.createElement('canvas')
      canvas.width = SIZE
      canvas.height = SIZE
      const ctx = canvas.getContext('2d')
      const side = Math.min(img.width, img.height)
      const sx = (img.width - side) / 2
      const sy = (img.height - side) / 2
      ctx.drawImage(img, sx, sy, side, side, 0, 0, SIZE, SIZE)
      let out = canvas.toDataURL('image/webp', 0.82)
      if (!out.startsWith('data:image/webp')) out = canvas.toDataURL('image/jpeg', 0.82)
      resolve(out)
    }
    img.onerror = () => { clearTimeout(timeout); reject(new Error('Image load failed')) }
    img.src = dataUrl
  })
}

function compressAvatar (file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    // Pass animated formats through unchanged — canvas flattens to a static
    // first frame, so downscaling a gif/webp would strip animation.
    const passThrough = file.type === 'image/gif' || file.type === 'image/webp'
    reader.onload = ev => {
      if (passThrough) resolve(ev.target.result)
      else downscaleAvatarDataUrl(ev.target.result).then(resolve, reject)
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

// ─── Calendar Tab ─────────────────────────────────────────────────────────────

// ─── Week View ───────────────────────────────────────────────────────────────
function WeekView ({ selectedDate, setSelectedDate, weekStart, eventsOnDate, todayStr, dateStr,
  openCreate, setModal, use24h, events, groups, filterGroupIds, setFilterGroupIds,
  onTouchStart, onTouchEnd, slideDir, isSliding, myRsvps = {}, myProfileId }) {

  const weekDays = useMemo(() => {
    const d = new Date(selectedDate + 'T12:00:00')
    const dow = d.getDay()
    const off = (dow - weekStart + 7) % 7
    const start = new Date(d)
    start.setDate(d.getDate() - off)
    return Array.from({ length: 7 }, (_, i) => {
      const day = new Date(start)
      day.setDate(start.getDate() + i)
      return dateStr(day.getFullYear(), day.getMonth(), day.getDate())
    })
  }, [selectedDate, weekStart, dateStr])

  const weekScrollRef = useRef(null)

  useEffect(() => {
    if (!weekScrollRef.current) return
    const el = weekScrollRef.current.querySelector('[data-weekday="' + selectedDate + '"]')
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [weekDays])

  return (
    <div onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}
      style={{ display:'flex', flexDirection:'column', flex:1, minHeight:0, overflow:'hidden' }}>
    <div style={{
      transform: slideDir === -1 ? 'translateX(-8%)' : slideDir === 1 ? 'translateX(8%)' : 'translateX(0)',
      opacity: isSliding ? 0 : 1,
      transition: isSliding ? 'transform 0.22s ease, opacity 0.22s ease' : 'none',
      display:'flex', flexDirection:'column', flex:1, minHeight:0,
    }}>
      {/* Day chip strip */}
      <div style={{ display:'flex', gap:4, padding:'0 16px 10px', justifyContent:'space-between' }}>
        {weekDays.map(ds => {
          const d = new Date(ds + 'T12:00:00')
          const isSel = ds === selectedDate
          const isToday = ds === todayStr
          return (
            <button key={ds} onClick={() => { setSelectedDate(ds) }}
              style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', gap:2,
                padding:'6px 0', borderRadius:10, border:'none', cursor:'pointer', fontFamily:FONT,
                background: isSel ? colors.primary : isToday ? colors.accentFaint : 'transparent' }}>
              <span style={{ fontSize:11, 
                color: isSel ? '#fff' : colors.text.muted }}>{DAYS[d.getDay()].slice(0,1)}</span>
              <span style={{ fontSize:14, fontWeight: isSel || isToday ? 400 : 300,
                color: isSel ? '#fff' : isToday ? colors.primary : colors.text.primary }}>{d.getDate()}</span>
            </button>
          )
        })}
      </div>

      {/* Group filter pills */}
      {groups && groups.length > 0 && (
        <div style={{ display:'flex', gap:6, overflowX:'auto', padding:'0 16px 10px',
          scrollbarWidth:'none', flexShrink:0, alignItems:'center' }}>
          <span style={{ flexShrink:0, display:'flex', alignItems:'center', gap:3,
            fontSize:11, color:colors.text.muted, letterSpacing:'0.03em' }}>
            <FunnelSimple size={12} weight="bold" /> Group Filter
          </span>
          <button onClick={() => setFilterGroupIds(new Set())} style={{
            flexShrink:0, fontSize:12, padding:'4px 12px',
            borderRadius:20, border:'1.5px solid ' + (filterGroupIds.size === 0 ? colors.primary : colors.border),
            background: filterGroupIds.size === 0 ? colors.primary : 'transparent',
            color: filterGroupIds.size === 0 ? '#fff' : colors.text.muted, cursor:'pointer' }}>
            All
          </button>
          {groups.map(g => (
            <button key={g.id} onClick={() => setFilterGroupIds(prev => {
              const next = new Set(prev)
              next.has(g.id) ? next.delete(g.id) : next.add(g.id)
              return next
            })} style={{
              flexShrink:0, fontSize:12, padding:'4px 12px',
              borderRadius:20, border:'1.5px solid ' + (filterGroupIds.has(g.id) ? g.color : colors.border),
              background: filterGroupIds.has(g.id) ? g.color : 'transparent',
              color: filterGroupIds.has(g.id) ? '#fff' : colors.text.muted, cursor:'pointer' }}>
              {g.name}
            </button>
          ))}
        </div>
      )}

      {/* Add event button */}
      <div style={{ display:'flex', justifyContent:'flex-end', padding:'0 16px 8px' }}>
        <button onClick={() => openCreate(selectedDate)} data-tour="mobile-create" style={{
          width: 36, height: 36, borderRadius: 10,
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: 'pointer',
        }}>
          <Plus size={18} weight="thin" color="var(--color-text)" />
        </button>
      </div>

      {/* Day sections */}
      <div ref={weekScrollRef} style={{ flex:1, overflowY:'auto', padding:'0 16px calc(72px + var(--safe-area-bottom))', minHeight:0 }}>
        {weekDays.map(ds => {
          const d = new Date(ds + 'T12:00:00')
          const isSel = ds === selectedDate
          let dayEvents = eventsOnDate(ds)
          if (filterGroupIds.size > 0) dayEvents = dayEvents.filter(e => (e.groups ?? []).some(gid => filterGroupIds.has(gid)))
          dayEvents.sort((a, b) => {
            if (a.allDay && !b.allDay) return -1
            if (!a.allDay && b.allDay) return 1
            return (a.start || '').localeCompare(b.start || '')
          })
          return (
            <div key={ds} data-weekday={ds} style={{ marginBottom:16 }}>
              <div style={{ fontSize:12, fontWeight: isSel ? 400 : 300, color: ds === todayStr ? colors.primary : colors.text.muted,
                letterSpacing:'0.05em', marginBottom:8, paddingBottom:4,
                borderBottom:'1px solid ' + colors.border }}>
                {ds === todayStr ? 'TODAY' : d.toLocaleDateString('en-US',
                  { weekday:'long', month:'short', day:'numeric' }).toUpperCase()}
              </div>
              {dayEvents.length === 0 ? (
                <div style={{ fontSize:13, color:colors.text.muted, padding:'8px 0', fontStyle:'italic' }}>
                  No events
                </div>
              ) : dayEvents.map((ev, i) => (
                <div key={ev.id} style={{ animation: `pearFadeUp 150ms var(--easing) ${i * 30}ms both` }}>
                  <EventCard ev={ev} isPast={ds < todayStr} myRsvpStatus={myRsvps[ev.id]} myProfileId={myProfileId}
                    use24h={use24h} groups={groups} onClick={() => setModal({ mode:'edit', event:{ ...ev } })} />
                </div>
              ))}
            </div>
          )
        })}
      </div>
    </div>
    </div>
  )
}

// ─── Day View ────────────────────────────────────────────────────────────────
function DayView ({ selectedDate, setSelectedDate, weekStart, eventsOnDate, todayStr, dateStr,
  openCreate, setModal, use24h, groups, filterGroupIds, setFilterGroupIds,
  onTouchStart, onTouchEnd, slideDir, isSliding, myRsvps = {}, myProfileId }) {

  const HOUR_H = 60
  const hourGridRef = useRef(null)

  const adjacentDays = useMemo(() => {
    const d = new Date(selectedDate + 'T12:00:00')
    return Array.from({ length: 7 }, (_, i) => {
      const day = new Date(d)
      day.setDate(d.getDate() + (i - 3))
      return dateStr(day.getFullYear(), day.getMonth(), day.getDate())
    })
  }, [selectedDate, dateStr])

  const dayEvents = useMemo(() => {
    let evs = eventsOnDate(selectedDate)
    if (filterGroupIds.size > 0) evs = evs.filter(e => (e.groups ?? []).some(gid => filterGroupIds.has(gid)))
    evs = evs.filter(e => isInAgenda(e, myProfileId))
    // Hour-grid/Day view: hide shadows I didn't forward — other peers' busy-time
    // forwards clutter my own hourly schedule. Matches the widget rule in
    // src/widget-cache.js (widget drops all shadows). My own shadows are
    // already suppressed by isShadowHidden when the source is local.
    evs = evs.filter(e => !e.isShadow || e.creatorId === myProfileId)
    return evs
  }, [selectedDate, eventsOnDate, filterGroupIds, myProfileId])
  const allDayEvents = dayEvents.filter(e => e.allDay)
  const timedEvents = dayEvents.filter(e => !e.allDay && e.start)

  const timeToY = (t) => {
    if (!t) return 0
    const [h, m] = t.split(':').map(Number)
    return (h + m / 60) * HOUR_H
  }

  const positioned = useMemo(() => {
    const sorted = [...timedEvents].sort((a, b) => (a.start || '').localeCompare(b.start || ''))
    const cols = []
    return sorted.map(ev => {
      const top = timeToY(ev.start)
      const bot = timeToY(ev.end || ev.start)
      const height = Math.max(bot - top, 30)
      let col = 0
      while (cols[col] && cols[col] > top) col++
      cols[col] = top + height
      const totalCols = cols.length
      return { ev, top, height, col, totalCols }
    })
  }, [dayEvents])

  useEffect(() => {
    if (!hourGridRef.current) return
    const isToday = selectedDate === todayStr
    let scrollTarget
    if (isToday) {
      const now = new Date()
      scrollTarget = Math.max(0, (now.getHours() - 1) * HOUR_H)
    } else if (timedEvents.length > 0) {
      const earliest = timedEvents.reduce((a, b) => (a.start || '99') < (b.start || '99') ? a : b)
      scrollTarget = Math.max(0, timeToY(earliest.start) - HOUR_H)
    } else {
      scrollTarget = 8 * HOUR_H
    }
    hourGridRef.current.scrollTop = scrollTarget
  }, [selectedDate])

  const formatHour = (h) => {
    if (use24h) return String(h).padStart(2, '0') + ':00'
    if (h === 0) return '12 AM'
    if (h === 12) return '12 PM'
    return h > 12 ? (h - 12) + ' PM' : h + ' AM'
  }

  return (
    <div onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}
      style={{ display:'flex', flexDirection:'column', flex:1, minHeight:0, overflow:'hidden' }}>
    <div style={{
      transform: slideDir === -1 ? 'translateX(-8%)' : slideDir === 1 ? 'translateX(8%)' : 'translateX(0)',
      opacity: isSliding ? 0 : 1,
      transition: isSliding ? 'transform 0.22s ease, opacity 0.22s ease' : 'none',
      display:'flex', flexDirection:'column', flex:1, minHeight:0,
    }}>
      {/* Day scroller strip */}
      <div style={{ display:'flex', gap:4, padding:'0 16px 10px', justifyContent:'space-between' }}>
        {adjacentDays.map(ds => {
          const d = new Date(ds + 'T12:00:00')
          const isSel = ds === selectedDate
          const isToday = ds === todayStr
          return (
            <button key={ds} onClick={() => { setSelectedDate(ds) }}
              style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', gap:2,
                padding:'6px 0', borderRadius:10, border:'none', cursor:'pointer', fontFamily:FONT,
                background: isSel ? colors.primary : isToday ? colors.accentFaint : 'transparent' }}>
              <span style={{ fontSize:11, 
                color: isSel ? '#fff' : colors.text.muted }}>{DAYS[d.getDay()].slice(0,1)}</span>
              <span style={{ fontSize:14, fontWeight: isSel || isToday ? 400 : 300,
                color: isSel ? '#fff' : isToday ? colors.primary : colors.text.primary }}>{d.getDate()}</span>
            </button>
          )
        })}
      </div>

      {/* Group filter pills */}
      {groups && groups.length > 0 && (
        <div style={{ display:'flex', gap:6, overflowX:'auto', padding:'0 16px 10px',
          scrollbarWidth:'none', flexShrink:0, alignItems:'center' }}>
          <span style={{ flexShrink:0, display:'flex', alignItems:'center', gap:3,
            fontSize:11, color:colors.text.muted, letterSpacing:'0.03em' }}>
            <FunnelSimple size={12} weight="bold" /> Group Filter
          </span>
          <button onClick={() => setFilterGroupIds(new Set())} style={{
            flexShrink:0, fontSize:12, padding:'4px 12px',
            borderRadius:20, border:'1.5px solid ' + (filterGroupIds.size === 0 ? colors.primary : colors.border),
            background: filterGroupIds.size === 0 ? colors.primary : 'transparent',
            color: filterGroupIds.size === 0 ? '#fff' : colors.text.muted, cursor:'pointer' }}>
            All
          </button>
          {groups.map(g => (
            <button key={g.id} onClick={() => setFilterGroupIds(prev => {
              const next = new Set(prev)
              next.has(g.id) ? next.delete(g.id) : next.add(g.id)
              return next
            })} style={{
              flexShrink:0, fontSize:12, padding:'4px 12px',
              borderRadius:20, border:'1.5px solid ' + (filterGroupIds.has(g.id) ? g.color : colors.border),
              background: filterGroupIds.has(g.id) ? g.color : 'transparent',
              color: filterGroupIds.has(g.id) ? '#fff' : colors.text.muted, cursor:'pointer' }}>
              {g.name}
            </button>
          ))}
        </div>
      )}

      {/* All-day events */}
      {allDayEvents.length > 0 && (
        <div style={{ padding:'0 16px 8px', maxHeight:80, overflowY:'auto' }}>
          {allDayEvents.slice(0, 3).map(ev => {
            const isShadow = !!ev.isShadow
            const shadowEditable = isShadow && ev.creatorId && ev.creatorId === myProfileId
            const creatorName = isShadow ? shadowCreatorName(ev, groups) : null
            const cs = derivedEventColors(ev, groups)
            return (
            <div key={ev.id} onClick={() => { if (isShadow && !shadowEditable) return; window.__pearSync?.haptic('light'); setModal({ mode:'edit', event:{ ...ev } }) }}
              style={{ padding:'4px 10px 4px 14px', borderRadius:8, marginBottom:4,
                cursor: (isShadow && !shadowEditable) ? 'default' : 'pointer',
                opacity: isShadow ? 0.6 : 1, fontStyle: isShadow ? 'italic' : 'normal',
                backgroundColor: (cs[0] ?? ev.color) + '22',
                ...leftStripeStyle(cs, 3) }}>
              <span style={{ fontSize:13, color: colors.text.primary }}>{ev.title}
                {isShadow && creatorName ? <span style={{ color:colors.text.muted }}> — {creatorName}</span> : null}
              </span>
            </div>
          )})}
          {allDayEvents.length > 3 && (
            <span style={{ fontSize:12, color:colors.text.muted }}>+{allDayEvents.length - 3} more</span>
          )}
        </div>
      )}

      {/* Hour grid */}
      <div ref={hourGridRef} style={{ flex:1, overflowY:'auto', position:'relative', minHeight:0 }}>
        <div style={{ position:'relative', height: 24 * HOUR_H }}>
          {Array.from({ length: 24 }, (_, h) => (
            <div key={h} onClick={() => openCreate(selectedDate, String(h).padStart(2, '0') + ':00')}
              style={{ position:'absolute', top: h * HOUR_H, left:0, right:0, height: HOUR_H,
                borderBottom: `1px solid ${colors.border}`, cursor:'pointer',
                display:'flex', alignItems:'flex-start' }}>
              <span style={{ fontSize:11, color:colors.text.muted, width:48,
                textAlign:'right', paddingRight:8, paddingTop:2, flexShrink:0 }}>
                {formatHour(h)}
              </span>
            </div>
          ))}

          {/* Event blocks */}
          {positioned.map(({ ev, top, height, col, totalCols }) => {
            const gutterPx = 56
            const colWidth = `calc((100% - ${gutterPx}px) / ${totalCols})`
            const colLeft = `calc(${gutterPx}px + ${col} * (100% - ${gutterPx}px) / ${totalCols})`
            const isShadow = !!ev.isShadow
            const shadowEditable = isShadow && ev.creatorId && ev.creatorId === myProfileId
            const creatorName = isShadow ? shadowCreatorName(ev, groups) : null
            const cs = derivedEventColors(ev, groups)
            return (
              <div key={ev.id}
                onClick={(e) => { e.stopPropagation(); if (isShadow && !shadowEditable) return; window.__pearSync?.haptic('light'); setModal({ mode:'edit', event:{ ...ev } }) }}
                style={{ position:'absolute', top, height: Math.max(height, 30),
                  left: colLeft, width: `calc(${colWidth} - 4px)`,
                  borderRadius:8, cursor: (isShadow && !shadowEditable) ? 'default' : 'pointer', overflow:'hidden',
                  opacity: isShadow ? 0.6 : 1, fontStyle: isShadow ? 'italic' : 'normal',
                  backgroundColor: (cs[0] ?? ev.color) + '22',
                  ...leftStripeStyle(cs, 3),
                  zIndex:10, display:'flex', gap:0 }}>
                <div style={{ flex:1, minWidth:0, padding:'4px 8px 4px 12px' }}>
                  <div style={{ fontSize:12, fontWeight:400, color: colors.text.primary, lineHeight:'1.3' }}>{ev.title}
                    {isShadow && creatorName ? <span style={{ color:colors.text.muted, fontWeight:300 }}> — {creatorName}</span> : null}
                  </div>
                  <div style={{ fontSize:11, color:colors.text.muted }}>
                    {formatTime(ev.start, use24h)}{ev.end ? ` – ${formatTime(ev.end, use24h)}` : ''}
                  </div>
                  {ev.meetingLink && (
                    <div onClick={e2 => { e2.stopPropagation(); window.__pearSync?.openURL(ev.meetingLink.trim()) }}
                      style={{ display:'flex', alignItems:'center', gap:3, marginTop:2, cursor:'pointer', minWidth:0 }}>
                      <ArrowSquareOut size={10} weight="thin" color="var(--color-accent)" style={{ flexShrink:0 }} />
                      <span style={{ fontSize:10, color:colors.primary, textDecoration:'underline',
                        overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                        {ev.meetingLink.trim().replace(/^https?:\/\//, '')}
                      </span>
                    </div>
                  )}
                </div>
                {ev.location && (
                  <>
                    <div style={{ width:1, background:colors.border, flexShrink:0, marginTop:4, marginBottom:4 }} />
                    <div onClick={e2 => { e2.stopPropagation(); window.__pearSync?.openURL('geo:0,0?q=' + encodeURIComponent(ev.location)) }}
                      style={{ width:56, display:'flex', alignItems:'center', justifyContent:'center',
                        cursor:'pointer', flexShrink:0, padding:'0 4px' }}>
                      <MapPin size={11} weight="thin" color="var(--color-muted)" style={{ flexShrink:0 }} />
                    </div>
                  </>
                )}
              </div>
            )
          })}

          {/* Current time indicator */}
          {selectedDate === todayStr && (() => {
            const now = new Date()
            const y = (now.getHours() + now.getMinutes() / 60) * HOUR_H
            return (
              <div style={{ position:'absolute', top:y, left:48, right:0, height:2,
                background:'#ef4444', borderRadius:1, zIndex:20, pointerEvents:'none' }}>
                <div style={{ position:'absolute', left:-4, top:-3, width:8, height:8,
                  borderRadius:'50%', background:'#ef4444' }} />
              </div>
            )
          })()}
        </div>
      </div>
    </div>
    </div>
  )
}

function FullGridView ({ weekStart, events, todayStr, filterGroupIds, closeFullGridRef, onExit, onDayTap, onEventTap, myProfileId, groups }) {
  useBackHandler(true, onExit)
  useEffect(() => {
    if (!closeFullGridRef) return
    closeFullGridRef.current = () => { onExit(); return true }
    return () => { closeFullGridRef.current = null }
  }, [closeFullGridRef, onExit])
  const MAX_LANES = 3
  const filtered = ((filterGroupIds && filterGroupIds.size > 0)
    ? events.filter(e => (e.groups ?? []).some(gid => filterGroupIds.has(gid)))
    : events).filter(e => !isShadowHidden(e, events, myProfileId))
  const toDate = s => new Date(s + 'T12:00:00')
  const fromDate = d => d.toISOString().slice(0, 10)
  const addDays = (d, n) => { const r = new Date(d); r.setDate(d.getDate() + n); return r }
  const diffDays = (a, b) => Math.round((toDate(b) - toDate(a)) / 86400000)

  // Starting week: the week containing today, aligned to weekStart
  const today = toDate(todayStr)
  const dow = today.getDay()
  const startOffset = (dow - weekStart + 7) % 7
  const initialWeekStart = addDays(today, -startOffset)

  const [range, setRange] = useState({ before: 40, after: 40 })
  const [todayVisible, setTodayVisible] = useState(true)
  const scrollRef = useRef(null)
  const didInitialScroll = useRef(false)

  const totalWeeks = range.before + range.after + 1
  const firstWeek = addDays(initialWeekStart, -range.before * 7)

  const weeks = useMemo(() => {
    const out = []
    for (let i = 0; i < totalWeeks; i++) {
      const ws = addDays(firstWeek, i * 7)
      const we = addDays(ws, 6)
      out.push({ start: fromDate(ws), end: fromDate(we), startDate: ws })
    }
    return out
  }, [totalWeeks, firstWeek.getTime()])

  const layoutWeek = (ws, we) => {
    const candidates = filtered.filter(e => {
      const s = e.date
      const en = e.endDate || e.date
      return en >= ws && s <= we
    }).sort((a, b) => {
      const aDur = diffDays(a.date, a.endDate || a.date)
      const bDur = diffDays(b.date, b.endDate || b.date)
      if (bDur !== aDur) return bDur - aDur
      return a.date.localeCompare(b.date)
    })
    const lanes = []
    const placed = []
    for (const e of candidates) {
      const s = e.date < ws ? ws : e.date
      const en = (e.endDate || e.date) > we ? we : (e.endDate || e.date)
      const startCol = diffDays(ws, s)
      const endCol = diffDays(ws, en)
      let laneIdx = 0
      while (lanes[laneIdx] && lanes[laneIdx].some(x => !(endCol < x.startCol || startCol > x.endCol))) {
        laneIdx++
      }
      if (!lanes[laneIdx]) lanes[laneIdx] = []
      lanes[laneIdx].push({ startCol, endCol, event: e })
      placed.push({ lane: laneIdx, startCol, endCol, event: e, continuesLeft: e.date < ws, continuesRight: (e.endDate || e.date) > we })
    }
    const overflow = new Array(7).fill(0)
    for (const p of placed) {
      if (p.lane >= MAX_LANES) {
        for (let c = p.startCol; c <= p.endCol; c++) overflow[c] += 1
      }
    }
    return { placed: placed.filter(p => p.lane < MAX_LANES), overflow }
  }

  useEffect(() => {
    if (didInitialScroll.current || !scrollRef.current) return
    const container = scrollRef.current
    const el = container.querySelector(`[data-weekindex="${range.before}"]`)
    if (el) {
      const containerTop = container.getBoundingClientRect().top
      const elTop = el.getBoundingClientRect().top
      container.scrollTop += (elTop - containerTop) - 8
      didInitialScroll.current = true
    }
  }, [])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    if (el.scrollTop < 400) setRange(r => ({ ...r, before: r.before + 20 }))
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 400) setRange(r => ({ ...r, after: r.after + 20 }))
    const cw = el.querySelector(`[data-weekindex="${range.before}"]`)
    if (cw) {
      const cTop = el.getBoundingClientRect().top
      const cBot = el.getBoundingClientRect().bottom
      const rTop = cw.getBoundingClientRect().top
      const rBot = cw.getBoundingClientRect().bottom
      const vis = rBot > cTop && rTop < cBot
      if (vis !== todayVisible) setTodayVisible(vis)
    }
  }

  const dayHeaders = [...DAYS.slice(weekStart), ...DAYS.slice(0, weekStart)]

  let lastMonthKey = null

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100%', position:'relative', background: colors.surface.base }}>
      <div style={{ padding:'12px 16px 8px', display:'flex', alignItems:'center', gap:8,
        borderBottom:`1px solid ${colors.border}`, flexShrink:0 }}>
        <button onClick={onExit} style={iconBtn}><ArrowLeft size={18} weight="thin" /></button>
        <span style={{ fontSize:15, color: colors.text.primary }}>Full-Month Grid</span>
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(7,1fr)', padding:'6px 8px',
        borderBottom:`1px solid ${colors.border}`, flexShrink:0 }}>
        {dayHeaders.map(d => (
          <div key={d} style={{ textAlign:'center', fontSize:11, color:colors.text.muted }}>{d}</div>
        ))}
      </div>
      <div ref={scrollRef} onScroll={onScroll}
        style={{ flex:1, overflowY:'auto', WebkitOverflowScrolling:'touch',
          paddingBottom:'calc(72px + var(--safe-area-bottom))' }}>
        {weeks.map((wk, idx) => {
          const { placed, overflow } = layoutWeek(wk.start, wk.end)
          const firstDay = wk.startDate
          const monthKey = `${firstDay.getFullYear()}-${firstDay.getMonth()}`
          const monthLabel = (() => {
            if (monthKey === lastMonthKey) return null
            lastMonthKey = monthKey
            return firstDay.toLocaleDateString('en-US', { month:'long', year:'numeric' }).toUpperCase()
          })()
          return (
            <div key={idx} data-weekindex={idx}>
              {monthLabel && (
                <div style={{ padding:'12px 16px 8px', fontSize:13, fontWeight:500, letterSpacing:'0.12em',
                  color:colors.text.primary, background:colors.surface.base, textAlign:'center',
                  borderTop:`1px solid ${colors.border}` }}>{monthLabel}</div>
              )}
              <div style={{ position:'relative', display:'grid', gridTemplateColumns:'repeat(7,1fr)',
                minHeight:92, borderBottom:`1px solid ${colors.border}`,
                borderLeft: idx === range.before ? `3px solid ${colors.primary}` : '3px solid transparent' }}>
                {Array.from({ length:7 }).map((_, col) => {
                  const cellDate = fromDate(addDays(firstDay, col))
                  const isToday = cellDate === todayStr
                  const isPast = cellDate < todayStr
                  return (
                    <button key={col} onClick={() => { onDayTap(cellDate) }}
                      style={{ border:'none', borderLeft: col === 0 ? 'none' : `1px solid ${colors.border}`,
                        background:'transparent', padding:'4px 2px 2px', cursor:'pointer',
                        display:'flex', flexDirection:'column', alignItems:'stretch',
                        opacity: isPast ? 0.55 : 1, minWidth:0 }}>
                      <span style={{ fontSize:11, fontWeight: isToday ? 500 : 300,
                        color: isToday ? '#fff' : colors.text.primary,
                        background: isToday ? colors.primary : 'transparent',
                        borderRadius: 10, padding: isToday ? '1px 6px' : '1px 0',
                        alignSelf:'flex-start', marginLeft:4 }}>
                        {addDays(firstDay, col).getDate()}
                      </span>
                    </button>
                  )
                })}
                {/* Event bars layer */}
                <div style={{ position:'absolute', top:22, left:0, right:0, bottom:0,
                  pointerEvents:'none' }}>
                  {placed.map((p, i) => {
                    const cs = derivedEventColors(p.event, groups)
                    const color = cs[0] ?? colors.primary
                    const bg = dotBackground(cs) ?? color
                    return (
                      <div key={p.event.id + '_' + i}
                        onClick={e => { e.stopPropagation(); window.__pearSync?.haptic('light'); onEventTap(p.event) }}
                        style={{ position:'absolute',
                          left: `calc(${(p.startCol / 7) * 100}% + 2px)`,
                          width: `calc(${((p.endCol - p.startCol + 1) / 7) * 100}% - 4px)`,
                          top: p.lane * 18,
                          height: 16, borderRadius: 4,
                          background: bg, color:'#fff',
                          fontSize: 10, fontWeight: 400, lineHeight:'16px',
                          padding:'0 5px', overflow:'hidden', whiteSpace:'nowrap', textOverflow:'ellipsis',
                          pointerEvents:'auto', cursor:'pointer',
                          borderTopLeftRadius: p.continuesLeft ? 0 : 4,
                          borderBottomLeftRadius: p.continuesLeft ? 0 : 4,
                          borderTopRightRadius: p.continuesRight ? 0 : 4,
                          borderBottomRightRadius: p.continuesRight ? 0 : 4,
                        }}>
                        {p.continuesLeft ? '‹ ' : ''}{p.event.title}
                      </div>
                    )
                  })}
                  {overflow.map((n, col) => n > 0 ? (
                    <div key={'ov_' + col} style={{ position:'absolute',
                      left: `${(col / 7) * 100}%`, width: `${100 / 7}%`,
                      top: MAX_LANES * 18, height: 14,
                      fontSize: 9, fontWeight: 400, color: colors.text.muted, textAlign:'center',
                      pointerEvents:'none' }}>
                      +{n}
                    </div>
                  ) : null)}
                </div>
              </div>
            </div>
          )
        })}
      </div>
      <div style={{ position:'absolute', bottom:'calc(30px + var(--safe-area-bottom) + 12px)',
        left:'50%',
        transform: `translateX(-50%) translateY(${todayVisible ? 120 : 0}px)`,
        opacity: todayVisible ? 0 : 1,
        transition: 'transform 260ms var(--easing), opacity 200ms var(--easing)',
        pointerEvents: todayVisible ? 'none' : 'auto',
        display:'flex', justifyContent:'center' }}>
        <button onClick={() => {
          const el = scrollRef.current?.querySelector(`[data-weekindex="${range.before}"]`)
          if (el && scrollRef.current) {
            const containerTop = scrollRef.current.getBoundingClientRect().top
            const elTop = el.getBoundingClientRect().top
            scrollRef.current.scrollTo({ top: scrollRef.current.scrollTop + (elTop - containerTop) - 8, behavior:'smooth' })
          }
        }} style={{ height:44, padding:'0 24px', borderRadius:22,
          background: colors.primary, border:'none',
          boxShadow:'0 4px 16px rgba(0,0,0,0.28)',
          display:'flex', alignItems:'center', gap:8, cursor:'pointer' }}>
          <CalendarDot size={18} weight="bold" color="#fff" />
          <span style={{ fontSize:14, fontWeight:500, color:'#fff', fontFamily:FONT }}>Today</span>
        </button>
      </div>
    </div>
  )
}

function CalendarTab ({ viewDate, setViewDate, calDays, selectedDate, setSelectedDate,
  eventsOnDate, todayStr, dateStr, selectedEvents, openCreate, setModal, events, groups, use24h, weekStart, eventsReady,
  saveEvent, profile, sync, myRsvps = {}, myProfileId, closeFullGridRef }) {
  const { y, m } = viewDate
  const [showMonthPicker, setShowMonthPicker] = useState(false)
  const [showYearPicker,  setShowYearPicker]  = useState(false)
  const [slideDir,        setSlideDir]        = useState(0)
  const [isSliding,       setIsSliding]       = useState(false)
  const touchStartX = useRef(null)
  const scrollRef = useRef(null)
  const isProgrammaticScroll = useRef(false)
  const isUserScrolling = useRef(false)
  const userScrollTimer = useRef(null)
  const scrollToDateRef = useRef(null)
  const [filterGroupIds, setFilterGroupIds] = useState(new Set())
  const [calView, setCalView] = useState(() => {
    const s = typeof window !== 'undefined' ? window.__pearScreenshotScene : null
    return s?.calendarView || 'month'
  }) // 'month' | 'week' | 'day'
  const [fullGrid, setFullGrid] = useState(() => {
    try { return typeof localStorage !== 'undefined' && localStorage.getItem('pearcal:fullGrid') === '1' } catch { return false }
  })
  useEffect(() => {
    try { localStorage.setItem('pearcal:fullGrid', fullGrid ? '1' : '0') } catch {}
  }, [fullGrid])


  const handleScroll = () => {
    if (isProgrammaticScroll.current) return
    isUserScrolling.current = true
    clearTimeout(userScrollTimer.current)
    userScrollTimer.current = setTimeout(() => { isUserScrolling.current = false }, 400)
    const container = scrollRef.current
    if (!container) return
    const containerTop = container.getBoundingClientRect().top
    const sections = [...container.querySelectorAll('[data-date]')]
    let active = null
    for (const el of sections) {
      if (el.getBoundingClientRect().top - containerTop <= 40) active = el.dataset.date
    }
    if (active && active !== selectedDate) {
      setSelectedDate(active)
      const d = new Date(active + 'T12:00:00')
      const newY = d.getFullYear(); const newM = d.getMonth()
      setViewDate(prev => {
        if (prev.y === newY && prev.m === newM) return prev
        setSlideDir(0); setIsSliding(true)
        setTimeout(() => setIsSliding(false), 220)
        return { y: newY, m: newM }
      })
    }
  }
  const years = Array.from({ length:16 }, (_, i) => 2020 + i)
  const scrollToDate = (date, smooth = true) => {
    const container = scrollRef.current
    if (!container) return
    const el = container.querySelector('[data-date="' + date + '"]')
    if (!el) return
    isProgrammaticScroll.current = true
    const top = el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
    container.scrollTo({ top, behavior: smooth ? 'smooth' : 'instant' })
    setTimeout(() => { isProgrammaticScroll.current = false }, smooth ? 600 : 50)
  }

  // Scroll to today on initial render once events are loaded
  const didInitialScroll = useRef(false)
  useEffect(() => {
    if (!eventsReady.current || didInitialScroll.current) return
    didInitialScroll.current = true
    // Defer to next frame so the DOM has rendered the date sections
    requestAnimationFrame(() => scrollToDate(todayStr, false))
  }, [events])

  // When (re)entering month view, scroll list back to today — list re-mounts so scrollRef resets
  useEffect(() => {
    if (calView !== 'month' || !eventsReady.current) return
    requestAnimationFrame(() => scrollToDate(todayStr, false))
  }, [calView])

  function navigate (dir) {
    if (isSliding) return
    setSlideDir(dir)
    setIsSliding(true)
    setTimeout(() => {
      if (calView === 'month') {
        if (dir === -1) setViewDate(v => v.m === 11 ? { y:v.y+1, m:0 } : { y:v.y, m:v.m+1 })
        else            setViewDate(v => v.m === 0  ? { y:v.y-1, m:11 } : { y:v.y, m:v.m-1 })
      } else {
        const shift = calView === 'week' ? 7 : 1
        const sign = dir === -1 ? 1 : -1
        setSelectedDate(prev => {
          const d = new Date(prev + 'T12:00:00')
          d.setDate(d.getDate() + sign * shift)
          const ns = dateStr(d.getFullYear(), d.getMonth(), d.getDate())
          setViewDate({ y: d.getFullYear(), m: d.getMonth() })
          return ns
        })
      }
      setSlideDir(0)
      setIsSliding(false)
    }, 220)
  }

  function prev () { navigate(1) }
  function next () { navigate(-1) }

  function onTouchStart (e) { touchStartX.current = e.touches[0].clientX }
  function onTouchEnd (e) {
    if (touchStartX.current === null) return
    const dx = e.changedTouches[0].clientX - touchStartX.current
    touchStartX.current = null
    if (Math.abs(dx) < 40) return
    if (dx < 0) next(); else prev()
  }

  const dropStyle = { position:'absolute', top:'calc(100% + 6px)', left:'50%',
    transform:'translateX(-50%)', zIndex:80, borderRadius:12, padding:8,
    boxShadow:'0 8px 24px rgba(0,0,0,0.3)', border:`1px solid ${colors.border}` }

  const pickBtn = active => ({
    padding:'7px 4px', borderRadius:8, border:'none', fontSize:12,
    cursor:'pointer', fontFamily:FONT, fontWeight:active ? 400 : 300,
    background:active ? colors.primary : 'transparent',
    color:active ? '#fff' : colors.text.primary,
  })

  if (fullGrid) {
    return <FullGridView weekStart={weekStart} events={events} todayStr={todayStr}
      filterGroupIds={filterGroupIds} closeFullGridRef={closeFullGridRef} myProfileId={myProfileId} groups={groups}
      onExit={() => setFullGrid(false)}
      onDayTap={ds => { setSelectedDate(ds); setCalView('day'); setFullGrid(false) }}
      onEventTap={ev => setModal({ mode:'edit', event:{ ...ev } })} />
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100%', position:'relative' }}>
    <div style={{ padding:'0 16px 8px', flexShrink:0 }}>
      {/* Nav header */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'12px 0 8px' }}>
        <button onClick={prev} style={iconBtn}><CaretLeft size={18} weight="thin" /></button>
        {calView === 'month' ? (
        <div style={{ display:'flex', gap:4, alignItems:'center' }}>
          {/* Month picker */}
          <div style={{ position:'relative' }}>
            <button onClick={() => { setShowMonthPicker(v => !v); setShowYearPicker(false) }}
              style={{ ...iconBtn, fontSize:17, padding:'4px 8px',
                border:`1px solid ${showMonthPicker ? colors.primary : colors.border}`, borderRadius:8 }}>
              {MONTHS[m]} ▾
            </button>
            {showMonthPicker && (
              <div style={{ ...dropStyle, background: colors.surface.base, display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:4, width:216 }}>
                {MONTHS.map((mn, i) => (
                  <button key={mn} style={pickBtn(m === i)}
                    onClick={() => { setViewDate(v => ({ ...v, m:i })); setShowMonthPicker(false) }}>
                    {mn.slice(0,3)}
                  </button>
                ))}
              </div>
            )}
          </div>
          {/* Year picker */}
          <div style={{ position:'relative' }}>
            <button onClick={() => { setShowYearPicker(v => !v); setShowMonthPicker(false) }}
              style={{ ...iconBtn, fontSize:17, padding:'4px 8px',
                border:`1px solid ${showYearPicker ? colors.primary : colors.border}`, borderRadius:8 }}>
              {y} ▾
            </button>
            {showYearPicker && (
              <div style={{ ...dropStyle, background: colors.surface.base, display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:4, width:224 }}>
                {years.map(yr => (
                  <button key={yr} style={pickBtn(y === yr)}
                    onClick={() => { setViewDate(v => ({ ...v, y:yr })); setShowYearPicker(false) }}>
                    {yr}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        ) : (
        <span style={{ fontSize:17, color: colors.text.primary }}>
          {calView === 'day'
            ? new Date(selectedDate + 'T12:00:00').toLocaleDateString('en-US', { weekday:'long', month:'short', day:'numeric' })
            : (() => {
                const d = new Date(selectedDate + 'T12:00:00')
                const dow = d.getDay()
                const off = (dow - weekStart + 7) % 7
                const wk0 = new Date(d); wk0.setDate(d.getDate() - off)
                const wk6 = new Date(wk0); wk6.setDate(wk0.getDate() + 6)
                const fmt = (dt) => dt.toLocaleDateString('en-US', { month:'short', day:'numeric' })
                return `${fmt(wk0)} – ${fmt(wk6)}, ${wk6.getFullYear()}`
              })()}
        </span>
        )}
        <button onClick={next} style={iconBtn}><CaretRight size={18} weight="thin" /></button>
      </div>

      {/* View toggle */}
      <div style={{ display:'flex', margin:'0 0 10px', borderRadius:10,
        border:`1px solid ${colors.border}`, overflow:'hidden' }}>
        {['month','week','day'].map(v => (
          <button key={v} onClick={() => setCalView(v)} style={{
            flex:1, padding:'6px 0', fontSize:13, fontWeight:calView === v ? 400 : 300,
            fontFamily:FONT, border:'none', cursor:'pointer',
            background: calView === v ? colors.primary : 'transparent',
            color: calView === v ? '#fff' : colors.text.muted,
            transition: 'background 0.15s, color 0.15s',
          }}>{v.charAt(0).toUpperCase() + v.slice(1)}</button>
        ))}
      </div>

      {calView === 'month' && (
      <div onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}
        style={{ overflow:'hidden', position:'relative' }}>
      <div style={{
        transform: slideDir === -1 ? 'translateX(-8%)' : slideDir === 1 ? 'translateX(8%)' : 'translateX(0)',
        opacity: isSliding ? 0 : 1,
        transition: isSliding ? 'transform 0.22s ease, opacity 0.22s ease' : 'none',
      }}>
      {/* Day headers */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(7,1fr)', marginBottom:4 }}>
        {[...DAYS.slice(weekStart), ...DAYS.slice(0, weekStart)].map(d => (
          <div key={d} style={{ textAlign:'center', fontSize:12, color:colors.text.muted, padding:'4px 0' }}>{d}</div>
        ))}
      </div>

      {/* Calendar grid */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(7,1fr)', gap:2 }}>
        {calDays.map((cell, i) => {
          const ds  = dateStr(cell.y, cell.m, cell.d)
          const evs = eventsOnDate(ds)
          const isToday = ds === todayStr
          const isSel   = ds === selectedDate
          const isPast  = ds < todayStr
          const isCur   = cell.type === 'cur'
          return (
            <button key={ds + i} onClick={() => { setSelectedDate(ds); scrollToDate(ds) }}
              style={{ background:isSel ? colors.primary : isToday ? colors.accentFaint : 'none',
                border:'none', borderRadius:10, padding:'6px 2px', cursor:'pointer',
                display:'flex', flexDirection:'column', alignItems:'center', gap:2, fontFamily:FONT,
                opacity: isSel ? 1 : !isCur ? 0.25 : isPast ? 0.45 : 1 }}>
              <span style={{ fontSize:14, fontWeight:isToday||isSel ? 400 : isCur ? 300 : 200,
                color:isSel ? '#fff' : isToday ? colors.primary : colors.text.primary }}>{cell.d}</span>
              <div style={{ display:'flex', gap:2, minHeight:6 }}>
                {evs.slice(0,3).map(e => (
                  <div key={e.id} style={{ width:6, height:6, borderRadius:'50%', background: dotBackground(derivedEventColors(e, groups)) ?? e.color }} />
                ))}
              </div>
            </button>
          )
        })}
      </div>
      </div>
      </div>
      )}

    </div>

      {calView === 'month' && (<>
      {/* Static date header + add button */}
      <div style={{ padding:'8px 16px 8px', borderTop:'1px solid ' + colors.border,
        display:'flex', alignItems:'center', justifyContent:'space-between', flexShrink:0 }}>
        <span style={{ fontWeight:400, fontSize:15, color: colors.text.primary }}>
          {selectedDate === todayStr ? 'Today · ' : ''}
          {selectedDate && new Date(selectedDate + 'T12:00:00').toLocaleDateString('en-US',
            { weekday:'long', month:'short', day:'numeric' })}
          {selectedDate < todayStr &&
            <span style={{ fontSize:11, color:colors.text.muted, fontWeight:300, marginLeft:8 }}>past</span>}
        </span>
        <div style={{ display:'flex', gap:8 }}>
          <button onClick={() => { setFullGrid(true) }} style={{
            width: 36, height: 36, borderRadius: 10,
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer',
          }}>
            <GridFour size={18} weight="thin" color="var(--color-text)" />
          </button>
          <button onClick={() => openCreate(selectedDate)} style={{
            width: 36, height: 36, borderRadius: 10,
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer',
          }}>
            <Plus size={18} weight="thin" color="var(--color-text)" />
          </button>
        </div>
      </div>
      {/* Group filter pills */}
      {groups && groups.length > 0 && (
        <div style={{ display:'flex', gap:6, overflowX:'auto', padding:'0 16px 10px',
          scrollbarWidth:'none', flexShrink:0, alignItems:'center' }}>
          <span style={{ flexShrink:0, display:'flex', alignItems:'center', gap:3,
            fontSize:11, color:colors.text.muted, letterSpacing:'0.03em' }}>
            <FunnelSimple size={12} weight="bold" /> Group Filter
          </span>
          <button onClick={() => setFilterGroupIds(new Set())} style={{
            flexShrink:0, fontSize:12, padding:'4px 12px',
            borderRadius:20, border:'1.5px solid ' + (filterGroupIds.size === 0 ? colors.primary : colors.border),
            background: filterGroupIds.size === 0 ? colors.primary : 'transparent',
            color: filterGroupIds.size === 0 ? '#fff' : colors.text.muted, cursor:'pointer' }}>
            All
          </button>
          {groups.map(g => (
            <button key={g.id} onClick={() => setFilterGroupIds(prev => {
              const next = new Set(prev)
              next.has(g.id) ? next.delete(g.id) : next.add(g.id)
              return next
            })} style={{
              flexShrink:0, fontSize:12, padding:'4px 12px',
              borderRadius:20, border:'1.5px solid ' + (filterGroupIds.has(g.id) ? g.color : colors.border),
              background: filterGroupIds.has(g.id) ? g.color : 'transparent',
              color: filterGroupIds.has(g.id) ? '#fff' : colors.text.muted, cursor:'pointer' }}>
              {g.name}
            </button>
          ))}
        </div>
      )}
      {/* Scrollable event list — flat, stable, never restructures */}
      <div ref={scrollRef} onScroll={handleScroll} style={{ flex:1, overflowY:'auto', padding:'0 16px calc(72px + var(--safe-area-bottom))', minHeight:0, WebkitOverflowScrolling: 'touch' }}>
      {!eventsReady.current ? (
        <div style={{ paddingTop: 8 }}>
          {[0,1,2].map(i => <SkeletonEventCard key={i} />)}
        </div>
      ) : null}
      {(() => {
        if (!eventsReady.current) return null
        const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 30)
        const cutoffStr = cutoff.toISOString().slice(0,10)
        const seen = new Map()
        const days = []
        const filteredEvents = (filterGroupIds.size > 0
          ? events.filter(e => (e.groups ?? []).some(gid => filterGroupIds.has(gid)))
          : events).filter(e => !isShadowHidden(e, events, myProfileId) && isInAgenda(e, myProfileId))
        filteredEvents
          .filter(e => (e.endDate || e.date) >= cutoffStr)
          .sort((a,b) => a.date.localeCompare(b.date))
          .forEach(e => {
            const endDate = e.endDate && e.endDate > e.date ? e.endDate : e.date
            if (endDate === e.date) {
              if (!seen.has(e.date)) { seen.set(e.date, []); days.push(e.date) }
              seen.get(e.date).push(e)
              return
            }
            const start = new Date(e.date + 'T12:00:00')
            const end = new Date(endDate + 'T12:00:00')
            const total = Math.round((end - start) / 86400000) + 1
            for (let i = 0; i < total; i++) {
              const d = new Date(start); d.setDate(start.getDate() + i)
              const ds = d.toISOString().slice(0,10)
              if (ds < cutoffStr) continue
              if (!seen.has(ds)) { seen.set(ds, []); days.push(ds) }
              seen.get(ds).push({ ...e, _dayIndex: i + 1, _dayTotal: total })
            }
          })
        if (!seen.has(todayStr)) {
          seen.set(todayStr, [])
          days.push(todayStr)
          days.sort((a,b) => a.localeCompare(b))
        }
        for (const list of seen.values()) {
          list.sort((a, b) => {
            if (a.allDay && !b.allDay) return -1
            if (!a.allDay && b.allDay) return 1
            return (a.start || '').localeCompare(b.start || '')
          })
        }
        return (
          <>
            {days.map(date => (
              <div key={date} data-date={date} style={{ marginBottom:20 }}>
                <div style={{ fontSize:12, fontWeight:400, color:colors.text.muted, letterSpacing:'0.05em',
                  marginBottom:8, paddingBottom:4, borderBottom:'1px solid ' + colors.border }}>
                  {date === todayStr ? 'TODAY' : new Date(date + 'T12:00:00').toLocaleDateString('en-US',
                    { weekday:'long', month:'short', day:'numeric' }).toUpperCase()}
                </div>
                {seen.get(date).map((ev, i) => (
                  <div key={ev.id} style={{ animation: `pearFadeUp 150ms var(--easing) ${i * 30}ms both` }}>
                    <EventCard ev={ev} isPast={date < todayStr} myRsvpStatus={myRsvps[ev.id]} myProfileId={myProfileId}
                      use24h={use24h} dayIndex={ev._dayIndex} dayTotal={ev._dayTotal} groups={groups}
                      onClick={() => setModal({ mode:'edit', event:{ ...ev } })} />
                  </div>
                ))}
              </div>
            ))}
            {/* Scroll sentinel: ensures scrollToDate(today) can always push today
                to the top even when little future content follows. Without it,
                short lists clamp scrollTop short and leave past events visible
                above today. 100vh is plenty for any realistic viewport. */}
            <div aria-hidden="true" style={{ height:'100vh' }} />
          </>
        )
      })()}
      </div>

      {/* Floating Today button — anchored above bottom nav, hidden when already on today */}
      {(() => {
        const onToday = y === parseInt(todayStr.slice(0,4)) && m === parseInt(todayStr.slice(5,7)) - 1 && selectedDate === todayStr
        return (
          <div style={{ position:'fixed', bottom:'calc(53px + var(--safe-area-bottom) + 12px)',
            left:'50%',
            transform: `translateX(-50%) translateY(${onToday ? 120 : 0}px)`,
            opacity: onToday ? 0 : 1,
            transition: 'transform 260ms var(--easing), opacity 200ms var(--easing)',
            pointerEvents: onToday ? 'none' : 'auto',
            display:'flex', justifyContent:'center' }}>
            <button onClick={() => {
              setViewDate({ y:parseInt(todayStr.slice(0,4)), m:parseInt(todayStr.slice(5,7)) - 1 })
              setSelectedDate(todayStr); scrollToDate(todayStr)
            }} style={{ height:44, padding:'0 24px', borderRadius:22,
              background: colors.primary, border:'none',
              boxShadow:'0 4px 16px rgba(0,0,0,0.28)',
              display:'flex', alignItems:'center', gap:8, cursor:'pointer' }}>
              <CalendarDot size={18} weight="bold" color="#fff" />
              <span style={{ fontSize:14, fontWeight:500, color:'#fff', fontFamily:FONT }}>Today</span>
            </button>
          </div>
        )
      })()}
      </>)}

      {calView === 'week' && (
        <WeekView selectedDate={selectedDate} setSelectedDate={setSelectedDate}
          weekStart={weekStart} eventsOnDate={eventsOnDate} todayStr={todayStr} dateStr={dateStr}
          openCreate={openCreate} setModal={setModal} use24h={use24h} events={events}
          groups={groups} filterGroupIds={filterGroupIds} setFilterGroupIds={setFilterGroupIds}
          onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}
          slideDir={slideDir} isSliding={isSliding} myRsvps={myRsvps} myProfileId={profile?.id} />
      )}

      {calView === 'day' && (
        <DayView selectedDate={selectedDate} setSelectedDate={setSelectedDate}
          weekStart={weekStart} eventsOnDate={eventsOnDate} todayStr={todayStr} dateStr={dateStr}
          openCreate={openCreate} setModal={setModal} use24h={use24h}
          groups={groups} filterGroupIds={filterGroupIds} setFilterGroupIds={setFilterGroupIds}
          onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}
          slideDir={slideDir} isSliding={isSliding} />
      )}

    </div>
  )
}

function DonationReminderModal ({ sync, onDonate, onDismiss }) {
  return (
    <div style={{ position:'fixed', inset:0, zIndex:490, background:'rgba(0,0,0,0.75)',
      display:'flex', alignItems:'center', justifyContent:'center', padding:'0 28px' }}>
      <div style={{ background: colors.surface.base, borderRadius:20, padding:'32px 24px', width:'100%', maxWidth:360,
        display:'flex', flexDirection:'column', alignItems:'center', gap:16, textAlign:'center' }}>
        <div style={{ fontSize:52 }}>⚡</div>
        <div style={{ fontSize:20, fontWeight:400, color: colors.text.primary }}>Enjoying PearCal?</div>
        <div style={{ fontSize:14, color:colors.text.muted, lineHeight:'1.7' }}>
          PearCal is free and open source with no ads or subscriptions. If you've received value from it, consider returning value to support development.
        </div>
        <button onClick={onDonate}
          style={{ ...pillBtn, width:'100%', padding:'13px', fontSize:15, 
            display:'flex', alignItems:'center', justifyContent:'center', gap:8 }}>
          Donate
        </button>
        <button onClick={onDismiss}
          style={{ background:'none', border:'none', color:colors.text.muted, fontSize:13,
            cursor:'pointer', fontFamily:FONT, padding:'4px' }}>
          Maybe later
        </button>
        <button onClick={onDismiss}
          style={{ background:'none', border:'none', color:colors.text.muted, fontSize:13,
            cursor:'pointer', fontFamily:FONT, padding:'4px' }}>
          Already donated ✓
        </button>
      </div>
    </div>
  )
}

// One-time explainer shown after updating to the version that made new groups
// encrypted. Gated by profile.encryptionNoticeSeen (proposal 2026-07-15).
function EncryptionNoticeModal ({ onDismiss }) {
  return (
    <div style={{ position:'fixed', inset:0, zIndex:490, background:'rgba(0,0,0,0.75)',
      display:'flex', alignItems:'center', justifyContent:'center', padding:'0 28px' }}>
      <div style={{ background: colors.surface.base, borderRadius:20, padding:'32px 24px', width:'100%', maxWidth:360,
        display:'flex', flexDirection:'column', alignItems:'center', gap:16, textAlign:'center' }}>
        <Lock size={48} weight="thin" color="var(--color-accent)" />
        <div style={{ fontSize:20, fontWeight:400, color: colors.text.primary }}>Groups are now encrypted</div>
        <div style={{ fontSize:14, color:colors.text.muted, lineHeight:'1.7' }}>
          New groups are end-to-end encrypted for privacy. Everyone in a group needs this version (or newer) to see it — invite members only after they've updated.
        </div>
        <div style={{ fontSize:14, color:colors.text.muted, lineHeight:'1.7' }}>
          If an existing group stops syncing, recreate it with everyone on the latest version.
        </div>
        <button onClick={onDismiss}
          style={{ ...pillBtn, width:'100%', padding:'13px', fontSize:15,
            display:'flex', alignItems:'center', justifyContent:'center', gap:8 }}>
          Got it
        </button>
      </div>
    </div>
  )
}

function OnboardingModal ({ step, setStep, profile, onUpdateProfile, db, sync, qrScanModeRef, closeOnboardSubModeRef, onComplete }) {
  const [name, setName] = useState(profile?.name ?? '')
  const [saving, setSaving] = useState(false)
  const [photoSaving, setPhotoSaving] = useState(false)
  const fileRef = useRef(null)
  const total = 5
  const [slideDir, setSlideDir] = useState(1)
  const [restoreMode, setRestoreMode] = useState(null) // null | 'pair' | 'pair-waiting'
  const [restoreError, setRestoreError] = useState('')
  const [pairInput, setPairInput] = useState('')

  // Expose a back-unwind hook so the App-level back handler pops the pair
  // sub-screen before falling through to step-decrement. 'pair-waiting' is
  // intentionally unbackable (we're mid-handshake). Returns true iff handled.
  useEffect(() => {
    if (!closeOnboardSubModeRef) return
    closeOnboardSubModeRef.current = () => {
      if (restoreMode === 'pair-waiting') return true  // swallow — mid-handshake
      if (restoreMode === 'pair') {
        db.cancelPairing?.().catch(() => {})
        setRestoreMode(null); setRestoreError(''); setPairInput('')
        return true
      }
      return false
    }
    return () => { if (closeOnboardSubModeRef) closeOnboardSubModeRef.current = null }
  }, [restoreMode, closeOnboardSubModeRef, db])

  // Secondary-side pair event listeners. pairingStarted (role: 'secondary')
  // fires when consumePairLink has joined the pair swarm and is actively
  // handshaking — that's the right moment to flip to 'pair-waiting'.
  // pairingCompleted advances onboarding to name entry (mnemonic came from
  // primary, name stays device-local). pairingFailed / pairingExpired returns
  // user to the pair menu with an error.
  useEffect(() => {
    function onPairingStarted (data) {
      if (!data || data.role !== 'secondary') return
      setRestoreMode('pair-waiting')
      setRestoreError('')
    }
    function onPairingCompleted (data) {
      if (!data || data.role !== 'secondary') return
      setRestoreMode(null)
      setRestoreError('')
      // Skip name + photo slides — both sync from the primary device via the
      // identityProfile keyspace (PR #134) within seconds of personal-base
      // open. Land on slide 4 ("Groups & Invites") which is informational for
      // a freshly-paired secondary, then "Let's go" finishes onboarding.
      setSlideDir(1); setStep(4)
    }
    function onPairingFailed (data) {
      const msg = (data?.reason === 'expired')
        ? 'Pairing link expired. Ask the other device to generate a new one.'
        : (data?.message || data?.reason || 'Pairing failed. Try again.')
      setRestoreMode('pair')
      setRestoreError(msg)
    }
    emitter.on('pairingStarted', onPairingStarted)
    emitter.on('pairingCompleted', onPairingCompleted)
    emitter.on('pairingFailed', onPairingFailed)
    emitter.on('pairingExpired', onPairingFailed)
    return () => {
      emitter.off('pairingStarted', onPairingStarted)
      emitter.off('pairingCompleted', onPairingCompleted)
      emitter.off('pairingFailed', onPairingFailed)
      emitter.off('pairingExpired', onPairingFailed)
    }
  }, [setStep])

  // Fire the native scanner. We DON'T flip to 'pair-waiting' here — if the
  // user backs out of the camera without scanning, no qrScanResult fires and
  // the UI would be stuck. The transition to pair-waiting happens only when
  // bare emits pairingStarted (secondary) above, after a valid URL is parsed.
  async function startPairScan () {
    setRestoreError('')
    if (qrScanModeRef) qrScanModeRef.current = 'pair'
    try { await sync?.qrScan?.() } catch (e) {
      qrScanModeRef.current = null
      setRestoreError(e?.message || 'Unable to open camera')
    }
  }

  async function submitPairPaste () {
    const url = pairInput.trim()
    if (!url) { setRestoreError('Paste a pearcal://pair link'); return }
    setRestoreError('')
    try {
      // pairingStarted listener flips UI to 'pair-waiting' once the swarm joins.
      await db.consumePairLink(url)
      // Success flows through pairingCompleted listener above.
    } catch (e) {
      setRestoreMode('pair')
      setRestoreError(e?.message || 'Invalid pairing link')
    }
  }


  async function handlePhotoChange (e) {
    const file = e.target.files?.[0]
    if (!file || !file.type.startsWith('image/')) return
    setPhotoSaving(true)
    try {
      const compressed = await compressAvatar(file)
      await onUpdateProfile({ avatar: compressed })
    } catch (err) { console.error('Photo compress failed', err) }
    setPhotoSaving(false)
    e.target.value = ''
  }

  async function saveName () {
    if (!name.trim()) return
    setSaving(true)
    await onUpdateProfile({ name: name.trim() })
    setSaving(false)
    setSlideDir(1); setStep(s => s + 1)
  }

  const hasPhoto = profile?.avatar?.startsWith?.('data:')
  const dots = Array.from({ length: total }, (_, i) => i)

  const slides = [
    // Slide 0 — Welcome (or pair sub-flow when restoreMode is set)
    restoreMode === 'pair' || restoreMode === 'pair-waiting' ? (
      <div key="0-pair" style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:16, flex:1, justifyContent:'center' }}>
        <div style={{ fontSize:22, fontWeight:400, color: colors.text.primary, textAlign:'center' }}>Pair with another device</div>
        <div style={{ fontSize:14, color:colors.text.muted, textAlign:'center', maxWidth:290, lineHeight:'1.6' }}>
          On your other device, open PearCal → Profile → Devices → Add a device, then scan or paste the pairing code here.
        </div>
        {restoreMode === 'pair-waiting' ? (
          <div style={{ fontSize:14, color:colors.text.muted, textAlign:'center', padding:'8px 0' }}>
            Connecting to your other device…
          </div>
        ) : (
          <>
            {!IS_DESKTOP && (
              <button onClick={startPairScan}
                style={{ ...pillBtn, padding:'12px 24px', fontSize:15,
                  width:'100%', maxWidth:260, boxSizing:'border-box' }}>
                Scan QR code
              </button>
            )}
            <div style={{ fontSize:12, color:colors.text.muted, marginTop:4 }}>{IS_DESKTOP ? 'Paste the pairing link' : 'or paste the link'}</div>
            <textarea value={pairInput} onChange={e => { setPairInput(e.target.value); setRestoreError('') }}
              placeholder="pearcal://pair?topic=…"
              rows={2}
              style={{ background:colors.surface.input, border:`1px solid ${colors.border}`, borderRadius:10,
                padding:'10px 12px', color:colors.text.primary, fontSize:13, 
                fontFamily:'monospace', width:'100%', maxWidth:260, boxSizing:'border-box',
                outline:'none', resize:'none', lineHeight:'1.4' }} />
            <button onClick={submitPairPaste} disabled={!pairInput.trim()}
              style={{ ...pillBtn, padding:'12px 24px', fontSize:15, 
                width:'100%', maxWidth:260, boxSizing:'border-box',
                opacity: !pairInput.trim() ? 0.4 : 1 }}>
              Pair
            </button>
          </>
        )}
        {restoreError && (
          <div style={{ fontSize:13, color:'#e67b7b', textAlign:'center', maxWidth:300 }}>
            {restoreError}
          </div>
        )}
        <button onClick={() => {
            // Release the bare-side swarm topic immediately instead of waiting
            // for the 15-min link expiry. Without this, backing out and then
            // consuming a different link errors with "another pair session in
            // progress" until the timer fires.
            db.cancelPairing?.().catch(() => {})
            setRestoreMode(null); setRestoreError(''); setPairInput('')
          }}
          disabled={restoreMode === 'pair-waiting'}
          style={{ background:'none', border:'none', color:colors.text.muted, fontFamily:FONT,
            fontSize:13, cursor:'pointer', padding:4,
            opacity: restoreMode === 'pair-waiting' ? 0.4 : 1 }}>
          Back
        </button>
      </div>
    ) : (
      <div key={0} style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:20, flex:1, justifyContent:'center' }}>
        <PearIcon size={56} />
        <div style={{ fontSize:22, fontWeight:400, color: colors.text.primary, textAlign:'center' }}>Welcome to PearCal</div>
        <div style={{ fontSize:14, color:colors.text.muted, textAlign:'center', lineHeight:'1.6', maxWidth:290 }}>
          A private shared calendar that works without servers, accounts, or subscriptions.
        </div>
        <button onClick={() => { setSlideDir(1); setStep(1) }}
          style={{ ...pillBtn, padding:'12px 40px', fontSize:16, marginTop:8 }}>
          Get Started
        </button>
        <button onClick={() => setRestoreMode('pair')}
          style={{ background:'none', border:'none', color:colors.text.muted, fontFamily:FONT,
            fontSize:13, cursor:'pointer', padding:4, textDecoration:'underline' }}>
          I already use PearCal
        </button>
      </div>
    ),

    // Slide 1 — How P2P works
    <div key={1} style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:20, flex:1, justifyContent:'center' }}>
      <ShareNetwork size={48} weight="thin" color="var(--color-accent)" />
      <div style={{ fontSize:22, fontWeight:400, color: colors.text.primary, textAlign:'center' }}>No servers. No accounts.</div>
      <div style={{ fontSize:14, color:colors.text.muted, textAlign:'center', lineHeight:'1.6', maxWidth:290 }}>
        PearCal syncs directly between devices using peer-to-peer technology. Your calendar data never touches a server — it lives only on the devices you share it with.
      </div>
      <div style={{ fontSize:13, color:colors.text.muted, textAlign:'center', maxWidth:290 }}>
        Share invite links or QR codes to connect with group members.
      </div>
      <button onClick={() => { setSlideDir(1); setStep(2) }}
        style={{ ...pillBtn, padding:'12px 40px', fontSize:16, marginTop:8 }}>
        Next
      </button>
    </div>,

    // Slide 2 — Name entry
    <div key={2} style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:20, flex:1, justifyContent:'center' }}>
      <User size={48} weight="thin" color="var(--color-accent)" />
      <div style={{ fontSize:22, fontWeight:400, color: colors.text.primary, textAlign:'center' }}>What's your name?</div>
      <div style={{ fontSize:14, color:colors.text.muted, textAlign:'center', maxWidth:290 }}>
        This is how you'll appear to group members in shared groups.
      </div>
      <input value={name} onChange={e => setName(e.target.value)}
        placeholder="Your name"
        style={{ background:colors.surface.input, border:`1px solid ${colors.border}`, borderRadius:10,
          padding:'12px 16px', color:colors.text.primary, fontSize:16, 
          fontFamily:FONT, width:'100%', boxSizing:'border-box', outline:'none', textAlign:'center' }} />

      <button onClick={saveName} disabled={!name.trim() || name.trim().toLowerCase() === 'my name' || saving}
        style={{ ...pillBtn, padding:'12px 40px', fontSize:16, 
          opacity: name.trim() && name.trim().toLowerCase() !== 'my name' ? 1 : 0.4 }}>
        {saving ? 'Saving…' : 'Continue'}
      </button>
    </div>,

    // Slide 3 — Photo upload
    <div key={3} style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:20, flex:1, justifyContent:'center' }}>
      <div style={{ width:96, height:96, borderRadius:'50%', background:profile?.color ?? '#6C9BF5',
        display:'flex', alignItems:'center', justifyContent:'center',
        fontSize:40, color:'#fff', overflow:'hidden',
        opacity: photoSaving ? 0.5 : 1, transition:'opacity 0.2s' }}>
        {hasPhoto
          ? <img src={profile.avatar} alt="avatar" style={{ width:'100%', height:'100%', objectFit:'cover' }} />
          : (profile?.name ?? '?').slice(0,1).toUpperCase()}
      </div>
      <div style={{ fontSize:22, fontWeight:400, color: colors.text.primary, textAlign:'center' }}>Add a photo</div>
      <div style={{ fontSize:14, color:colors.text.muted, textAlign:'center', maxWidth:290 }}>
        Optional — helps group members recognise you in shared groups.
      </div>
      <input ref={fileRef} type="file" accept="image/*" style={{ display:'none' }} onChange={handlePhotoChange} />
      <button onClick={() => sync?.takePhoto?.()} disabled={photoSaving}
        style={{ ...pillBtn, padding:'12px 20px', fontSize:15, 
          display:'flex', alignItems:'center', justifyContent:'center', gap:6,
          width:'100%', maxWidth:200, boxSizing:'border-box' }}>
        <Image size={18} weight="thin" /> Photo
      </button>
      <button onClick={() => { setSlideDir(1); setStep(4) }}
        style={{ ...pillBtn, padding:'12px 20px', fontSize:15, 
          width:'100%', maxWidth:200, boxSizing:'border-box' }}>
        {hasPhoto ? 'Continue' : 'Skip'}
      </button>
    </div>,

    // Slide 4 — Groups & Invites
    <div key={4} style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:20, flex:1, justifyContent:'center' }}>
      <Users size={48} weight="thin" color="var(--color-accent)" />
      <div style={{ fontSize:22, fontWeight:400, color: colors.text.primary, textAlign:'center' }}>Sharing with others</div>
      <div style={{ display:'flex', flexDirection:'column', gap:16, width:'100%', maxWidth:300 }}>
        <div style={{ display:'flex', gap:14, alignItems:'flex-start' }}>
          <Users size={22} weight="thin" color="var(--color-muted)" style={{ flexShrink:0 }} />
          <div style={{ fontSize:14, color:colors.text.muted, lineHeight:'1.6' }}>
            Use the{' '}
            <span style={{ display:'inline-flex', alignItems:'center', gap:4, verticalAlign:'middle',
              background:'var(--color-surface)', border:'1px solid var(--color-border)',
              borderRadius:12, padding:'3px 10px', fontSize:12, color:'var(--color-text)' }}>
              <UserPlus size={13} weight="thin" /> Join Group
            </span>
            {' '}and{' '}
            <span style={{ display:'inline-flex', alignItems:'center', gap:4, verticalAlign:'middle',
              background:'var(--color-primary)', border:'none',
              borderRadius:'var(--radius-xl)', padding:'3px 10px', fontSize:12, color: colors.text.onPrimary }}>
              <Plus size={13} weight="thin" /> New Group
            </span>
            {' '}buttons on the <span style={{ color: colors.text.primary, fontWeight:400 }}>Groups</span> page.
          </div>
        </div>
        <div style={{ display:'flex', gap:14, alignItems:'flex-start' }}>
          <ShareNetwork size={22} weight="thin" color="var(--color-muted)" style={{ flexShrink:0 }} />
          <div style={{ fontSize:14, color:colors.text.muted, lineHeight:'1.6' }}>
            Share the invite link or QR code from a group to let others join.
          </div>
        </div>
        <div style={{ display:'flex', gap:14, alignItems:'flex-start' }}>
          <CalendarBlank size={22} weight="thin" color="var(--color-muted)" style={{ flexShrink:0 }} />
          <div style={{ fontSize:14, color:colors.text.muted, lineHeight:'1.6' }}>
            Tap any day on the calendar, hit the{' '}
            <span style={{ display:'inline-flex', alignItems:'center', justifyContent:'center',
              verticalAlign:'middle', width:22, height:22, borderRadius:6,
              background:'var(--color-surface)', border:'1px solid var(--color-border)' }}>
              <Plus size={13} weight="thin" color="var(--color-text)" />
            </span>
            {' '}button, and assign the event to a group to share it.
          </div>
        </div>
        <div style={{ display:'flex', gap:14, alignItems:'flex-start' }}>
          <UploadSimple size={22} weight="thin" color="var(--color-muted)" style={{ flexShrink:0 }} />
          <div style={{ fontSize:14, color:colors.text.muted, lineHeight:'1.6' }}>
            Have events in another calendar? Import them from the{' '}
            <span style={{ color: colors.text.primary, fontWeight:400 }}>Profile</span> tab under Settings.
          </div>
        </div>
      </div>
      <button onClick={() => { onComplete?.() }}
        style={{ ...pillBtn, padding:'12px 40px', fontSize:16, marginTop:4 }}>
        Let's go!
      </button>
    </div>
  ]

  return (
    <div style={{ position:'fixed', inset:0, zIndex:500, background: colors.surface.base,
      display:'flex', flexDirection:'column', padding:'48px 28px 32px',
      animation: 'pearFadeUp 150ms var(--easing) both' }}>
      {/* Back button */}
      {step > 0 && (
        <button onClick={() => { setSlideDir(-1); setStep(s => s - 1) }}
          style={{ position:'absolute', top:48, left:24, background:'none', border:'none',
            color:colors.text.muted, cursor:'pointer', fontFamily:FONT, padding:4 }}>
          <CaretLeft size={24} weight="thin" />
        </button>
      )}
      {/* Slide content */}
      <div key={step} style={{ flex:1, display:'flex', flexDirection:'column',
        animation: `${slideDir >= 0 ? 'pearSlideInRight' : 'pearSlideInLeft'} 0.22s ease` }}>
        {slides[step]}
      </div>
      {/* Dots */}
      <div style={{ display:'flex', gap:6, justifyContent:'center', marginTop:16 }}>
        {dots.map(i => (
          <div key={i} style={{ width: i === step ? 18 : 6, height:6, borderRadius:3,
            background: i === step ? colors.primary : colors.border,
            transition:'width 0.2s, background 0.2s' }} />
        ))}
      </div>
    </div>
  )
}

// TODO #11 Phase 4 — primary-side pairing modal. Shows the QR + pasteable URL
// + a countdown. `data` shape tracks the pair lifecycle:
//   { url, expiresAt }              - active, waiting for secondary
//   { url, expiresAt, expired: true } - 15-min timer fired, needs regenerate
//   { status: 'completed' }          - success flash before auto-dismiss
function PairingHostModal ({ data, error, onRegenerate, onCancel }) {
  const canvasRef = useRef(null)
  const [qrError, setQrError] = useState(null)
  const link = data?.url
  useEffect(() => {
    if (!canvasRef.current || !link) return
    try {
      QRCode.toCanvas(canvasRef.current, link, { width: 240, margin: 2 }, (err) => {
        if (err) setQrError(err.message)
      })
    } catch(e) { setQrError(e.message) }
  }, [link])
  const copyLink = () => {
    if (!link) return
    try {
      const ta = document.createElement('textarea')
      ta.value = link; ta.style.position = 'fixed'; ta.style.opacity = '0'
      document.body.appendChild(ta); ta.select()
      document.execCommand('copy'); document.body.removeChild(ta)
      window.__pearSync?.haptic('success')
    } catch {}
  }
  const isCompleted = data?.status === 'completed'
  const isExpired   = data?.expired === true
  // Once pairing completes the modal is not dismissible by tapping the scrim, so
  // Back must not dismiss it either.
  useBackHandler(!isCompleted, onCancel)
  return (
    <div style={{ position:'fixed', top:0, left:0, right:0, bottom:0, zIndex:9999,
      background:'rgba(0,0,0,0.55)', display:'flex', alignItems:'center', justifyContent:'center' }}
      onClick={isCompleted ? undefined : onCancel}>
      <div style={{ background: colors.surface.card, borderRadius:16, padding:24, display:'flex',
        flexDirection:'column', alignItems:'center', gap:14, width:300 }}
        onClick={e => e.stopPropagation()}>
        <div style={{ fontSize:16, fontWeight:400, color: colors.text.primary }}>
          {isCompleted ? 'Device paired' : 'Add a device'}
        </div>
        {isCompleted ? (
          <div style={{ fontSize:13, color:colors.text.muted, textAlign:'center', padding:'20px 0' }}>
            The other device is now linked to your identity.
          </div>
        ) : isExpired ? (
          <>
            <div style={{ fontSize:13, color:colors.text.muted, textAlign:'center', lineHeight:1.5 }}>
              This pairing link expired. Generate a new one and scan it within 15 minutes.
            </div>
            <button onClick={onRegenerate}
              style={{ ...pillBtn, width:'100%', padding:'10px', fontSize:14 }}>
              Generate new link
            </button>
          </>
        ) : (
          <>
            <div style={{ fontSize:12, color:colors.text.muted, textAlign:'center', maxWidth:260 }}>
              On the other device, open PearCal and tap <b>I already use PearCal → Pair with another device</b>.
            </div>
            {qrError
              ? <div style={{ fontSize:11, color:'red' }}>QR error: {qrError}</div>
              : <canvas ref={canvasRef} style={{ borderRadius:8 }} />}
            <div style={{ fontSize:10, color:colors.text.muted, textAlign:'center',
              wordBreak:'break-all', fontFamily:'monospace', maxWidth:260, lineHeight:1.4 }}>{link}</div>
            <button data-haptic="success" onClick={copyLink}
              style={{ ...pillBtn, padding:'8px 20px', fontSize:12 }}>
              Copy link
            </button>
          </>
        )}
        {error && !isCompleted && (
          <div style={{ fontSize:12, color:'#e67b7b', textAlign:'center', maxWidth:260 }}>
            {error}
          </div>
        )}
        {!isCompleted && (
          <button onClick={onCancel}
            style={{ background:'none', border:`1px solid ${colors.border}`,
              color:colors.text.muted, fontFamily:FONT, padding:'8px 20px',
              fontSize:13, cursor:'pointer', borderRadius:8,
              width:'100%' }}>
            Cancel
          </button>
        )}
      </div>
    </div>
  )
}

function QRModal ({ link, onClose }) {
  const canvasRef = useRef(null)
  const [qrError, setQrError] = useState(null)
  const bsCloseRef = useRef(null)
  // No useBackHandler here: BottomSheet registers its own, so that Back plays the
  // slide-out instead of snapping the sheet away. Two handlers would double-fire.
  useEffect(() => {
    if (!canvasRef.current || !link) return
    try {
      QRCode.toCanvas(canvasRef.current, link, { width: 260, margin: 2 }, (err) => {
        if (err) setQrError(err.message)
      })
    } catch(e) { setQrError(e.message) }
  }, [link])
  // zIndex above the 300-tier sheets: the QR is opened from group settings, which
  // is itself a sheet, so it has to sit on top of its opener.
  return (
    <BottomSheet onClose={onClose} zIndex={400} closeRef={bsCloseRef}>
      <div style={{ position:'sticky', top:0, zIndex:10, background:'var(--color-bg)',
        padding:'12px 20px', display:'flex', justifyContent:'space-between', alignItems:'center',
        gap:10, borderBottom:`1px solid ${colors.border}` }}>
        <span style={{ fontSize:17, color: colors.text.primary }}>Scan to Join</span>
        <button onClick={() => bsCloseRef.current?.()} style={{ ...pillBtn, padding:'6px 14px', fontSize:13 }}>
          Close
        </button>
      </div>
      <div style={{ padding:'20px', display:'flex', flexDirection:'column',
        alignItems:'center', gap:16 }}>
        {qrError
          ? <div style={{ fontSize:11, color:'red' }}>QR error: {qrError}</div>
          : <canvas ref={canvasRef} style={{ borderRadius:8 }} />}
        <div style={{ fontSize:11, color:colors.text.muted, textAlign:'center',
          wordBreak:'break-all' }}>{link}</div>
      </div>
    </BottomSheet>
  )
}

function EventCard ({ ev, onClick, compact, isPast, use24h, myRsvpStatus, myProfileId, dayIndex, dayTotal, groups }) {
  const viewerIsCreator = ev.creatorId && myProfileId && ev.creatorId === myProfileId
  const showRsvpPill = !ev.isShadow && ev.rsvpEnabled && !viewerIsCreator
  const isDeclined = showRsvpPill && myRsvpStatus === 'declined'
  const isShadow = !!ev.isShadow
  const shadowEditable = isShadow && viewerIsCreator
  const creatorName = isShadow ? shadowCreatorName(ev, groups) : null
  return (
    <div onClick={() => { if (isShadow && !shadowEditable) return; window.__pearSync?.haptic('light'); onClick?.() }}
      style={{ display:'flex', gap:12, alignItems:'flex-start',
        padding:compact ? '10px 12px 10px 18px' : '12px 14px 12px 20px',
        borderRadius:12, cursor: (isShadow && !shadowEditable) ? 'default' : 'pointer', background: colors.surface.card,
        ...leftStripeStyle(derivedEventColors(ev, groups), 4), marginBottom:compact ? 0 : 8,
        opacity: (isPast || isDeclined) ? 0.5 : (isShadow ? 0.6 : 1),
        fontStyle: isShadow ? 'italic' : 'normal' }}>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ fontSize:compact ? 13 : 15, color: colors.text.primary,
          textDecoration: isDeclined ? 'line-through' : 'none' }}>
          {showRsvpPill && myRsvpStatus === 'going' && <span style={{ color:'#5DBF8A', marginRight:6 }}>✓</span>}
          {showRsvpPill && myRsvpStatus === 'declined' && <span style={{ color:'#D45F7A', marginRight:6 }}>✗</span>}
          {showRsvpPill && (!myRsvpStatus || myRsvpStatus === 'pending') && <span style={{ color:colors.text.muted, marginRight:6 }}>?</span>}
          {ev.title}
          {isShadow && creatorName ? (
            <span style={{ color:colors.text.muted }}> — {creatorName}</span>
          ) : null}
        </div>
        <div style={{ fontSize:12, color:colors.text.muted, marginTop:2 }}>
          {ev.allDay
            ? (ev.endDate && ev.endDate !== ev.date
                ? `${new Date(ev.date + 'T12:00:00').toLocaleDateString('en-US', { month:'short', day:'numeric' })} – ${new Date(ev.endDate + 'T12:00:00').toLocaleDateString('en-US', { month:'short', day:'numeric' })}`
                : 'All day')
            : `${formatTime(ev.start, use24h)} – ${formatTime(ev.end, use24h)}`}
          {dayIndex && dayTotal ? ` · day ${dayIndex} of ${dayTotal}` : ''}
          {compact && ` · ${new Date(ev.date + 'T12:00:00').toLocaleDateString('en-US',
            { month:'short', day:'numeric' })}`}
        </div>
        {!compact && ev.meetingLink ? (
          <div onClick={e => { e.stopPropagation(); window.__pearSync?.openURL(ev.meetingLink.trim()) }}
            style={{ display:'flex', alignItems:'center', gap:4, marginTop:4, cursor:'pointer', minWidth:0 }}>
            <ArrowSquareOut size={12} weight="thin" color="var(--color-accent)" style={{ flexShrink:0 }} />
            <span style={{ fontSize:11, color:colors.primary, textDecoration:'underline',
              overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
              {ev.meetingLink.trim().replace(/^https?:\/\//, '')}
            </span>
          </div>
        ) : null}
        {!compact && ev.desc ? <div style={{ fontSize:12, color:colors.text.muted, marginTop:4, 
          overflow:'hidden', display:'-webkit-box', WebkitLineClamp:2, WebkitBoxOrient:'vertical',
          lineHeight:'1.35' }}>{ev.desc}</div> : null}
        {!compact && ev.privateNote ? <div style={{ fontSize:12, color:colors.text.muted, marginTop:4, 
          fontStyle:'italic', overflow:'hidden', display:'-webkit-box', WebkitLineClamp:2, WebkitBoxOrient:'vertical',
          lineHeight:'1.35' }}>{ev.privateNote}</div> : null}
      </div>
      {!compact && ev.location ? (
        <>
          <div style={{ width:1, background:colors.border, alignSelf:'stretch', marginTop:2, marginBottom:2, flexShrink:0 }} />
          <div onClick={e => { e.stopPropagation(); window.__pearSync?.openURL('geo:0,0?q=' + encodeURIComponent(ev.location)) }}
            style={{ width:96, display:'flex', alignItems:'center', justifyContent:'center',
              cursor:'pointer', flexShrink:0, padding:'0 6px', gap:4 }}>
            <MapPin size={13} weight="thin" color="var(--color-muted)" style={{ flexShrink: 0 }} />
            <div style={{ fontSize:11, color:colors.primary, textDecoration:'underline',
              textAlign:'left', lineHeight:'1.35',
              overflow:'hidden', display:'-webkit-box', WebkitLineClamp:3, WebkitBoxOrient:'vertical' }}>
              {ev.location}
            </div>
          </div>
        </>
      ) : null}
    </div>
  )
}

// ─── Event Modal ──────────────────────────────────────────────────────────────

// Custom-interval helpers (TODO #83 Part B). Mirror of `src/lib/reminders.js`
// constants — duplicated here to avoid pulling another import into App.jsx
// just for two literals.
const REMINDER_UNIT_MULTIPLIER = { minutes: 1, hours: 60, days: 1440, weeks: 10080 }
const REMINDER_MAX_MINUTES = 525600 // 1 year

function isPresetReminder (v) {
  return REMINDER_OPTIONS.some(o => o.value === v)
}
function deriveCustomAmountFromMinutes (m) {
  if (!Number.isFinite(m) || m <= 0) return 1
  if (m % 10080 === 0) return m / 10080
  if (m % 1440 === 0)  return m / 1440
  if (m % 60 === 0)    return m / 60
  return m
}
function deriveCustomUnitFromMinutes (m) {
  if (!Number.isFinite(m) || m <= 0) return 'hours'
  if (m % 10080 === 0) return 'weeks'
  if (m % 1440 === 0)  return 'days'
  if (m % 60 === 0)    return 'hours'
  return 'minutes'
}

function RemindersEditor ({ reminders, setReminders }) {
  // A compact variant of the shared field recipe. It keeps inputStyle's 16px on
  // purpose: below 16px iOS zooms the whole page when the field takes focus, and
  // an inline size overrides the reset that exists to prevent exactly that.
  // (This block also used to shadow FONT with 'Geist' — a face the app has never
  // shipped, so these fields silently rendered in system-ui while every other
  // field rendered in Manrope.)
  const inp = { ...inputStyle, padding: '8px 10px', appearance: 'none' }

  // Per-slot custom-mode flag. Once a slot is in custom mode, typing a value
  // that happens to match a preset (e.g. 60) doesn't visually flip it back to
  // the dropdown — the inputs stay so the user can keep editing. Re-derived
  // when the reminders prop's length changes (event switch, async load).
  const [customMode, setCustomMode] = useState(() =>
    reminders.map(v => !isPresetReminder(v))
  )
  useEffect(() => {
    setCustomMode(prev =>
      prev.length === reminders.length
        ? prev
        : reminders.map(v => !isPresetReminder(v))
    )
  }, [reminders.length])

  // Per-slot draft text for the custom amount input. Lets the user clear
  // the field and type a new value (e.g. clear "3" and type "45") without
  // the controlled input snapping back to the previous stored value mid-key.
  // When draft is undefined the input is governed by the derived stored
  // value; when defined (incl. empty string) the draft wins.
  const [amountDraft, setAmountDraft] = useState({})

  function addReminder () {
    if (reminders.length >= 3) return
    const next = REMINDER_OPTIONS.find(o => !reminders.includes(o.value))
    if (next) {
      setReminders([...reminders, next.value])
      setCustomMode([...customMode, false])
    }
  }

  function removeReminder (idx) {
    setReminders(reminders.filter((_, i) => i !== idx))
    setCustomMode(customMode.filter((_, i) => i !== idx))
  }

  function updateReminder (idx, value) {
    const updated = [...reminders]
    updated[idx] = value
    setReminders(updated)
  }

  function handleSelectChange (idx, raw) {
    if (raw === '__custom__') {
      // Default custom value: 3 hours (avoids matching any current preset).
      setCustomMode(customMode.map((v, i) => i === idx ? true : v))
      updateReminder(idx, 180)
    } else {
      setCustomMode(customMode.map((v, i) => i === idx ? false : v))
      updateReminder(idx, Number(raw))
    }
  }

  function handleAmountInput (idx, raw, unit) {
    // Always track the raw text so a transient empty value renders correctly.
    setAmountDraft(prev => ({ ...prev, [idx]: raw }))
    if (raw === '') return  // empty mid-typing — leave stored value alone
    const n = parseInt(raw, 10)
    if (!Number.isFinite(n) || n < 1) return  // wait for a valid digit run
    const minutes = Math.min(REMINDER_MAX_MINUTES, n * REMINDER_UNIT_MULTIPLIER[unit])
    updateReminder(idx, minutes)
  }

  function handleAmountBlur (idx) {
    // On blur, drop the draft so the input falls back to the canonical value
    // (e.g. snaps from "" back to whatever was stored).
    setAmountDraft(prev => {
      if (!(idx in prev)) return prev
      const next = { ...prev }
      delete next[idx]
      return next
    })
  }

  function handleUnitChange (idx, amount, unit) {
    const minutes = Math.min(REMINDER_MAX_MINUTES, amount * REMINDER_UNIT_MULTIPLIER[unit])
    updateReminder(idx, minutes)
  }

  return (
    <div>
      {reminders.map((val, idx) => {
        const inCustom = customMode[idx]
        const amount = inCustom ? deriveCustomAmountFromMinutes(val) : 1
        const unit   = inCustom ? deriveCustomUnitFromMinutes(val)   : 'hours'
        return (
          <div key={idx} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
            {inCustom ? (
              <>
                <input type="number" min={1} max={REMINDER_MAX_MINUTES} inputMode="numeric"
                  style={{ ...inp, flex: '0 0 80px' }}
                  value={amountDraft[idx] !== undefined ? amountDraft[idx] : String(amount)}
                  onChange={e => handleAmountInput(idx, e.target.value, unit)}
                  onBlur={() => handleAmountBlur(idx)} />
                <select style={{ ...inp, flex: 1 }} value={unit}
                  onChange={e => handleUnitChange(idx, amount, e.target.value)}>
                  <option value="minutes">min before</option>
                  <option value="hours">hr before</option>
                  <option value="days">day before</option>
                  <option value="weeks">wk before</option>
                </select>
              </>
            ) : (
              <select
                style={{ ...inp, flex: 1 }}
                value={val}
                onChange={e => handleSelectChange(idx, e.target.value)}>
                {REMINDER_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}
                    disabled={opt.value !== val && reminders.includes(opt.value)}>
                    {opt.label}
                  </option>
                ))}
                <option value="__custom__">Custom…</option>
              </select>
            )}
            <button onClick={() => removeReminder(idx)}
              style={{ background: 'none', border: 'none', cursor: 'pointer',
                color: colors.text.muted, fontSize: 18, padding: '0 4px', lineHeight: 1 }}>
              ×
            </button>
          </div>
        )
      })}
      {reminders.length < 3 && (
        <button onClick={addReminder}
          style={{ background: 'none', border: `1px dashed ${colors.border}`, borderRadius: 10,
            color: colors.text.muted, fontSize: 13, padding: '8px 12px',
            cursor: 'pointer', width: '100%', fontFamily: FONT }}>
          + Add reminder
        </button>
      )}
    </div>
  )
}

function EventModal ({ modal, setModal, groups, profile, events = [], onSave, onForward, onDelete, onDeleteSeries, REMINDER_OPTIONS, db, onRequestConfirm, closeRef, notifs, setMyRsvps }) {
  const [ev, setEv] = useState(modal.event)
  const origDate = modal.mode === 'edit' ? modal.event.date : null
  const set = (k, v) => setEv(e => ({ ...e, [k]:v }))

  // "Custom…" recurrence (TODO #102): a UI mode where the user picks
  // "Every N days/weeks/months/years". Stored as a normal unit cadence +
  // recurrenceInterval, so an event opened with interval > 1 starts in custom
  // mode. intervalDraft holds the raw input text so the number field can be
  // cleared and retyped without the controlled value snapping back mid-edit.
  const [customMode, setCustomMode] = useState(() => (modal.event?.recurrenceInterval ?? 1) > 1)
  const [intervalDraft, setIntervalDraft] = useState(null)

  // Per-user busy-time forwards for this event, derived ONCE on modal open
  // from existing shadows I authored. Frozen in initialForwardsRef so the
  // dirty comparison doesn't shift if events update in the background.
  const [myForwards, setMyForwards] = useState(() => {
    if (!profile?.id) return []
    const myId = profile.id
    // NOTE: do NOT auto-arm a busy-time forward on create. A single-group
    // account previously defaulted myForwards to [groups[0].id], which — unless
    // the user also tapped the group under "Invite" — saved the event as a
    // PERSONAL event (groups:[]) plus a detail-less busy-time SHADOW in the
    // group. The personal source syncs over the multi-device personal base while
    // the shadow syncs over the reliable group base, so on a paired sibling the
    // two desync and the shadow (no location/desc) renders next to the real
    // event: "the same event, one with a location and one without." Sharing is
    // now explicit via "Invite" (a true group event over the group base);
    // busy-time forwarding stays an opt-in for forwarding into OTHER groups.
    const srcIds = modal.event.recurrenceId
      ? new Set(events.filter(e => !e.isShadow && e.recurrenceId === modal.event.recurrenceId).map(e => e.id))
      : new Set([modal.event.id])
    const targets = new Set()
    for (const e of events) {
      if (!e.isShadow) continue
      if (e.creatorId !== myId) continue
      if (!srcIds.has(e.sourceEventId)) continue
      const gid = (e.groups ?? [])[0]
      if (gid) targets.add(gid)
    }
    return Array.from(targets)
  })
  const initialForwardsRef = useRef(null)
  if (initialForwardsRef.current === null) initialForwardsRef.current = myForwards
  const toggleForward = (gid) => setMyForwards(cur =>
    cur.includes(gid) ? cur.filter(x => x !== gid) : [...cur, gid])
  const forwardsDirty = useMemo(() => {
    const a = [...(initialForwardsRef.current ?? [])].sort().join(',')
    const b = [...myForwards].sort().join(',')
    return a !== b
  }, [myForwards])

  function toggleGroup (gid) {
    setEv(e => ({ ...e, groups: e.groups.includes(gid)
      ? e.groups.filter(x => x !== gid) : [...e.groups, gid] }))
  }

  const allMembers = useMemo(() => {
    const seen = {}, res = []
    ev.groups.forEach(gid => {
      const g = groups.find(x => x.id === gid)
      if (g) g.members.forEach(m => {
        if (!seen[m.id] && m.id !== 'u1' && m.id !== profile?.id) { seen[m.id] = true; res.push(m) }
      })
    })
    return res
  }, [ev.groups, groups])

  function toggleInvitee (uid) {
    setEv(e => ({ ...e, invitees: e.invitees.includes(uid)
      ? e.invitees.filter(x => x !== uid) : [...e.invitees, uid] }))
  }

  useEffect(() => {
    const cols = ev.groups.map(gid => groups.find(x => x.id === gid)?.color).filter(Boolean)
    if (cols.length > 0) setEv(e => ({ ...e, color: cols[0], colors: cols }))
    else setEv(e => ({ ...e, colors: [] }))
  }, [ev.groups, groups])

  const [reminders, setReminders] = useState([])

  useEffect(() => {
    if (!db) return
    const eventId = modal.event?.id
    if (!eventId) return
    db.getReminders(eventId).then(r => {
      if (r && r.length > 0) {
        setReminders(r)
      } else if (modal.mode === 'create') {
        const profileDefault = typeof profile?.defaultReminder === 'number'
          ? profile.defaultReminder : 15
        if (profileDefault > 0) setReminders([profileDefault])
        else setReminders([])
      }
    }).catch(() => {})
  }, [modal.event?.id])

  // ── RSVP state ──────────────────────────────────────────────────────────
  const isEventCreator = !ev.creatorId || ev.creatorId === profile?.id
  const [myRsvp, setMyRsvp] = useState(null)          // own response when non-creator
  const [rsvpList, setRsvpList] = useState([])        // all responses when creator
  const [rsvpExpanded, setRsvpExpanded] = useState(false)

  useEffect(() => {
    if (!db || modal.mode !== 'edit') return
    const eid = modal.event?.id
    if (!eid || !ev.rsvpEnabled) return
    if (isEventCreator) {
      db.listRsvps(eid).then(r => setRsvpList(r ?? [])).catch(() => {})
    } else if (profile?.id) {
      db.getRsvp(eid, profile.id).then(r => setMyRsvp(r?.status ?? 'pending')).catch(() => {})
    }
  }, [modal.event?.id, ev.rsvpEnabled, isEventCreator])

  async function respondRsvp (status) {
    const eid = modal.event?.id
    if (!db || !eid || !profile?.id) return
    const groupIds = modal.event?.groups ?? []
    setMyRsvp(status)
    setMyRsvps?.(prev => ({ ...prev, [eid]: status }))
    try {
      await db.putRsvp(eid, profile.id, status, groupIds)
      // Cancel any pre-Phase-2 alarms in the legacy notifId range; the
      // global reconcile below handles top-K rescheduling regardless of
      // status (declined events are filtered out of computeUpcomingReminders).
      notifs?.cancelForEvent(eid).catch(() => {})
      notifs?.reconcile?.()
    } catch(e) { console.warn('[RSVP-ERR]', e?.message) }
  }

  const [moreOpen, setMoreOpen] = useState(false)
  const [mlOpen, setMlOpen] = useState(!!modal.event?.meetingLink)
  const [locOpen, setLocOpen] = useState(!!modal.event?.location)
  const [notesOpen, setNotesOpen] = useState(!!modal.event?.desc)
  const [privNotesOpen, setPrivNotesOpen] = useState(!!modal.event?.privateNote)
  const [titleErr, setTitleErr] = useState('')
  // Map<title, mostRecentEvent> — used to prefill fields when a suggestion is picked
  const [pastEvents, setPastEvents] = useState(new Map())
  const [suggestions, setSuggestions] = useState([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  useEffect(() => {
    db.listEvents().then(evts => {
      const byTitle = new Map()
      for (const e of (evts ?? [])) {
        if (!e.title) continue
        const existing = byTitle.get(e.title)
        if (!existing || (e.updatedAt ?? 0) > (existing.updatedAt ?? 0)) byTitle.set(e.title, e)
      }
      setPastEvents(byTitle)
    }).catch(() => {})
  }, [])

  function handleSave () {
    const isCreator = !ev.creatorId || (profile?.id && ev.creatorId === profile.id)
    const isReadOnly = modal.mode === 'edit' && ev.editPermission === 'creator' && !isCreator
    // Strip forwards that target a group the event is already in — a shadow
    // would collide with the event itself in that group.
    const evGroups = new Set(ev.groups ?? [])
    const effectiveForwards = myForwards.filter(gid => !evGroups.has(gid))
    // Non-creator on a locked event: only busy-time forwards change. Skip the
    // event write (we have no right to modify it) and fire only the forward diff.
    if (isReadOnly) {
      if (forwardsDirty) onForward?.(modal.event, effectiveForwards)
      setModal(null)
      return
    }
    if (!ev.title.trim()) { setTitleErr('Event title is required.'); return }
    setTitleErr('')
    // Edit mode: fire forward diff immediately against current events. Create
    // mode: hand myForwards off to saveEvent so it can fan out against the
    // newly-expanded occurrences (which aren't in events state yet).
    if (modal.mode === 'edit' && forwardsDirty) onForward?.(modal.event, effectiveForwards)
    const baseSave = origDate && origDate !== ev.date ? { ...ev, _prevDate: origDate } : ev
    const toSave = modal.mode === 'create' && effectiveForwards.length > 0
      ? { ...baseSave, _myForwards: effectiveForwards }
      : baseSave
    if (modal.mode === 'edit' && ev.recurrenceId) {
      const origGroups   = [...(modal.event.groups   ?? [])].sort().join(',')
      const newGroups    = [...(toSave.groups         ?? [])].sort().join(',')
      const origInvitees = [...(modal.event.invitees  ?? [])].sort().join(',')
      const newInvitees  = [...(toSave.invitees       ?? [])].sort().join(',')
      if (origGroups !== newGroups || origInvitees !== newInvitees) {
        onSave(toSave, 'future', { propagateGroups: true }, reminders)
        return
      }
      bsCloseRef.current?.(); onRequestConfirm({ type: 'editScope', ev: toSave, reminders }); return
    }
    onSave(toSave, 'one', {}, reminders)
  }

  const bsCloseRef = useRef(null)
  useEffect(() => {
    if (closeRef) {
      closeRef.current = () => { bsCloseRef.current?.(); return true }
      return () => { closeRef.current = null }
    }
  }, [])

  const formLocked = modal.mode === 'edit' && (
    ev.creatorId === 'system' ||
    (ev.editPermission === 'creator' && !(ev.creatorId && profile?.id && ev.creatorId === profile.id))
  )

  return (
    <BottomSheet onClose={() => setModal(null)} zIndex={100} closeRef={bsCloseRef}>
      <div style={{ position:'sticky', top:0, zIndex:10, background:'var(--color-bg)',
        padding:'12px 20px', display:'flex', justifyContent:'space-between', alignItems:'center',
        gap:10, borderBottom:`1px solid ${colors.border}` }}>
          <span style={{ fontSize:17, color: colors.text.primary, flex:1, minWidth:0,
            overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
            {modal.mode === 'create' ? 'New Event' : 'Edit Event'}
          </span>
          {(() => {
            const isCreator = ev.creatorId && profile?.id && ev.creatorId === profile.id
            const isHoliday = modal.mode === 'edit' && ev.creatorId === 'system'
            const isReadOnly = modal.mode === 'edit' && ev.editPermission === 'creator' && !isCreator
            if (isHoliday) return null
            // Read-only viewers only get a Save button once they've toggled a forward
            if (isReadOnly && !forwardsDirty) return null
            return (
              <button onClick={handleSave}
                style={{ ...pillBtn, padding:'7px 16px', fontSize:13, 
                  display:'flex', alignItems:'center', gap:4 }}>
                {modal.mode === 'create' ? 'Create' : 'Save'}
              </button>
            )
          })()}
          <button onClick={() => bsCloseRef.current?.()} style={{ ...iconBtn, fontSize:20 }}>✕</button>
        </div>
        <div style={{ padding:'16px 20px', display:'flex', flexDirection:'column', gap:14,
          animation: 'pearFadeUp 150ms var(--easing) both' }}>
          <div style={{ display:'flex', flexDirection:'column', gap:14,
            opacity: formLocked ? 0.45 : 1,
            pointerEvents: formLocked ? 'none' : 'auto' }}>

          {/* ── Responses banner (edit + RSVP + creator) ── */}
          {modal.mode === 'edit' && ev.rsvpEnabled && isEventCreator && (() => {
            const going    = rsvpList.filter(r => r.status === 'going')
            const declined = rsvpList.filter(r => r.status === 'declined')
            const respIds = new Set(rsvpList.map(r => r.memberId))
            const invited = []
            const seen = new Set()
            for (const gid of (ev.groups ?? [])) {
              const g = groups.find(x => x.id === gid)
              if (!g) continue
              for (const m of (g.members ?? [])) {
                if (m.id === ev.creatorId || m.id === profile?.id) continue
                if (!seen.has(m.id)) { seen.add(m.id); invited.push(m) }
              }
            }
            const pending = invited.filter(m => !respIds.has(m.id))
            const nameFor = (id) => invited.find(m => m.id === id)?.name || id.slice(0,6)
            return (
              <div onClick={() => setRsvpExpanded(e => !e)} style={{ cursor:'pointer',
                padding:'10px 14px', border:`1px solid ${colors.border}`, borderRadius:10,
                fontSize:13, color:colors.text.primary,
                display:'flex', flexDirection:'column', gap:6 }}>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                  <div style={{ display:'flex', gap:10 }}>
                    <span><span style={{ color:'#5DBF8A' }}>✓</span> {going.length} going</span>
                    <span><span style={{ color:'#D45F7A' }}>✗</span> {declined.length} declined</span>
                    <span style={{ color:colors.text.muted }}>? {pending.length} pending</span>
                  </div>
                  <CaretRight size={13} weight="thin" color="var(--color-muted)"
                    style={{ transition:'transform 0.25s',
                      transform: rsvpExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }} />
                </div>
                {rsvpExpanded && (
                  <div style={{ display:'flex', flexDirection:'column', gap:4, fontSize:12, marginTop:2 }}>
                    {going.length > 0 && <div><span style={{ color:'#5DBF8A' }}>✓</span> {going.map(r => nameFor(r.memberId)).join(', ')}</div>}
                    {declined.length > 0 && <div><span style={{ color:'#D45F7A' }}>✗</span> {declined.map(r => nameFor(r.memberId)).join(', ')}</div>}
                    {pending.length > 0 && <div><span style={{ color:colors.text.muted }}>?</span> {pending.map(m => m.name).join(', ')}</div>}
                  </div>
                )}
              </div>
            )
          })()}

          {/* ── Title (top, no section) ── */}
          <div style={{ position:'relative' }}>
            <input style={{ ...inputStyle, borderColor: titleErr ? '#D45F7A' : inputStyle.border }}
              placeholder="Event title" value={ev.title}
              onChange={e => {
                const val = e.target.value
                set('title', val)
                if (val.trim()) setTitleErr('')
                if (val.trim().length >= 1) {
                  const q = val.toLowerCase()
                  const matches = [...pastEvents.keys()].filter(t => t.toLowerCase().includes(q) && t !== val).slice(0, 5)
                  setSuggestions(matches)
                  setShowSuggestions(matches.length > 0)
                } else {
                  setShowSuggestions(false)
                }
              }}
              onBlur={() => setTimeout(() => setShowSuggestions(false), 150)} />
            {showSuggestions && (
              <div style={{ position:'absolute', top:'100%', left:0, right:0, zIndex:50,
                background:colors.surface.input, border:`1px solid ${colors.border}`, borderRadius:8,
                marginTop:2, overflow:'hidden', boxShadow:'0 4px 16px rgba(0,0,0,0.3)' }}>
                {suggestions.map((s, i) => {
                  const match = pastEvents.get(s)
                  const prefillHint = match
                    ? (match.allDay
                        ? (match.endDate && match.endDate !== match.date ? 'All day · multi-day' : 'All day')
                        : (match.start ? match.start + '–' + match.end : ''))
                    : ''
                  return (
                  <div key={i}
                    onMouseDown={() => {
                      setShowSuggestions(false)
                      setEv(prev => ({
                        ...prev,
                        title: s,
                        ...(match ? {
                          allDay:   match.allDay ?? prev.allDay,
                          start:    match.start ?? prev.start,
                          end:      match.end ?? prev.end,
                          location: match.location ?? prev.location,
                          meetingLink: match.meetingLink ?? prev.meetingLink,
                          endDate:  match.endDate ?? prev.endDate,
                        } : {}),
                      }))
                    }}
                    style={{ padding:'10px 12px', fontSize:14, color:colors.text.primary,
                      cursor:'pointer', borderBottom: i < suggestions.length - 1 ? `1px solid ${colors.border}` : 'none',
                      display:'flex', justifyContent:'space-between', alignItems:'center', gap:8 }}>
                    <span>{s}</span>
                    {prefillHint ? <span style={{ fontSize:11, color:colors.text.muted, flexShrink:0 }}>{prefillHint}</span> : null}
                  </div>
                  )
                })}
              </div>
            )}
            {titleErr && <div style={{ color:'#D45F7A', fontSize:12, marginTop:4 }}>{titleErr}</div>}
          </div>

          {/* ── Section: When ── */}
          <div style={{ borderTop:`1px solid ${colors.border}`, paddingTop:12, marginTop:2 }}>
            <div style={{ fontSize:10, fontWeight:400, color:colors.text.muted, letterSpacing:'0.1em',
              textTransform:'uppercase', marginBottom:12 }}>When</div>
            <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
              <div><Label>Date</Label>
                <input type="date" style={inputStyle} value={ev.date} onChange={e => set('date', e.target.value)} />
              </div>
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                <span style={{ fontSize:14, color: colors.text.primary }}>All Day</span>
                <Toggle val={ev.allDay} onChange={v => { set('allDay', v); if (!v) set('endDate', '') }} accent={colors.primary} />
              </div>
              {ev.allDay && !ev.recurrenceId && ev.recurrence === 'none' && (
                <div><Label>End Date</Label>
                  <input type="date" style={inputStyle} value={ev.endDate || ev.date} min={ev.date}
                    onChange={e => set('endDate', e.target.value === ev.date ? '' : e.target.value)} />
                </div>
              )}
              {!ev.allDay && (
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
                  <div><Label>Start</Label>
                    <input type="time" style={inputStyle} value={ev.start} onChange={e => {
                      const newStart = e.target.value
                      set('start', newStart)
                      const [h, mins] = newStart.split(':').map(Number)
                      const endH = String((h + 1) % 24).padStart(2, '0')
                      set('end', endH + ':' + String(mins).padStart(2, '0'))
                    }} />
                  </div>
                  <div><Label>End</Label>
                    <input type="time" style={inputStyle} value={ev.end} onChange={e => set('end', e.target.value)} />
                  </div>
                </div>
              )}
              {(modal.mode === 'create' || !ev.recurrenceId) && (
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                  <span style={{ fontSize:14, color: colors.text.primary }}>Recurring</span>
                  <Toggle val={!!ev.recurrence && ev.recurrence !== 'none'} accent={colors.primary}
                    onChange={v => {
                      setCustomMode(false)
                      setIntervalDraft(null)
                      if (v) {
                        set('recurrence', 'daily')
                        set('recurrenceInterval', 1)
                        if (!ev.recurrenceEnd && ev.date) {
                          const [y,m,d] = ev.date.split('-').map(Number)
                          const end = new Date(y+1, m-1, d)
                          const fmt = dt => String(dt.getFullYear()) + '-' + String(dt.getMonth()+1).padStart(2,'0') + '-' + String(dt.getDate()).padStart(2,'0')
                          set('recurrenceEnd', fmt(end))
                        }
                      } else {
                        set('recurrence', 'none')
                      }
                    }} />
                </div>
              )}
              {/* Frequency, Repeat forever — visible for create AND edit-series-occurrence.
                  Frequency edits regenerate the series via versioned occurrence ids
                  (TODO #80). Repeat forever is a series-level flag (TODO #82 Phase 3). */}
              {ev.recurrence && ev.recurrence !== 'none' && (
                <>
                  <div><Label>Frequency</Label>
                    <select style={{ ...inputStyle, appearance:'none' }} value={customMode ? 'custom' : ev.recurrence}
                      onChange={e => {
                        const val = e.target.value
                        if (val === 'custom') {
                          // Enter Custom mode. Stored as a unit cadence +
                          // interval; default to "every 2 <current unit>" so it
                          // reads as a real custom value (interval 1 would just
                          // collapse back to the matching preset on reopen).
                          setCustomMode(true)
                          if (!['daily','weekly','monthly','yearly'].includes(ev.recurrence)) set('recurrence', 'daily')
                          if (!((ev.recurrenceInterval ?? 1) > 1)) set('recurrenceInterval', 2)
                          setIntervalDraft(null)
                          return
                        }
                        setCustomMode(false)
                        set('recurrence', val)
                        set('recurrenceInterval', 1)   // presets are interval-1
                        setIntervalDraft(null)
                        if (val === 'monthly-nth' && ev.date) {
                          const d = new Date(ev.date + 'T12:00:00')
                          const weekday = d.getDay()
                          let nth = 0; const tmp = new Date(d.getFullYear(), d.getMonth(), 1)
                          while (tmp <= d) { if (tmp.getDay() === weekday) nth++; tmp.setDate(tmp.getDate() + 1) }
                          set('recurrenceNth', nth)
                          set('recurrenceWeekday', weekday)
                        }
                      }}>
                      <option value="daily">Daily</option>
                      <option value="weekly">Weekly</option>
                      <option value="biweekly">Every 2 weeks</option>
                      <option value="monthly">Monthly (same date)</option>
                      <option value="monthly-nth">Monthly (same weekday)</option>
                      <option value="yearly">Yearly</option>
                      <option value="custom">Custom…</option>
                    </select>
                  </div>
                  {/* Custom interval — "every N days/weeks/months/years" (TODO #102) */}
                  {customMode && (() => {
                    const n = ev.recurrenceInterval ?? 1
                    return (
                      <div><Label>Every</Label>
                        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                          <input type="number" min="1" max="999" inputMode="numeric"
                            style={{ ...inputStyle, width:90 }}
                            value={intervalDraft != null ? intervalDraft : String(n)}
                            onChange={e => {
                              const raw = e.target.value
                              setIntervalDraft(raw)
                              const parsed = parseInt(raw, 10)
                              if (Number.isFinite(parsed) && parsed >= 1) set('recurrenceInterval', Math.min(999, parsed))
                            }}
                            onBlur={() => {
                              const parsed = parseInt(intervalDraft ?? '', 10)
                              set('recurrenceInterval', Number.isFinite(parsed) ? Math.max(1, Math.min(999, parsed)) : 1)
                              setIntervalDraft(null)
                            }} />
                          <select style={{ ...inputStyle, appearance:'none', flex:1 }} value={ev.recurrence}
                            onChange={e => set('recurrence', e.target.value)}>
                            <option value="daily">{n === 1 ? 'day' : 'days'}</option>
                            <option value="weekly">{n === 1 ? 'week' : 'weeks'}</option>
                            <option value="monthly">{n === 1 ? 'month' : 'months'}</option>
                            <option value="yearly">{n === 1 ? 'year' : 'years'}</option>
                          </select>
                        </div>
                      </div>
                    )
                  })()}
                  <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                    <span style={{ fontSize:14, color: colors.text.primary }}>Repeat forever</span>
                    <Toggle val={!!ev.repeatForever} accent={colors.primary}
                      onChange={v => set('repeatForever', v)} />
                  </div>
                </>
              )}
              {/* Repeat until — editable for new events AND existing series
                  (TODO #102 follow-up). Editing it on a series and applying to
                  future/all regenerates occurrences via the endChanged path. */}
              {ev.recurrence && ev.recurrence !== 'none' && !ev.repeatForever && (
                <div><Label>Repeat until</Label>
                  <input type="date" style={inputStyle} value={ev.recurrenceEnd ?? ''}
                    onChange={e => set('recurrenceEnd', e.target.value)} />
                </div>
              )}
            </div>
          </div>

          {/* ── Section: Reminders ── */}
          <div style={{ borderTop:`1px solid ${colors.border}`, paddingTop:12, marginTop:2 }}>
            <div style={{ fontSize:10, fontWeight:400, color:colors.text.muted, letterSpacing:'0.1em',
              textTransform:'uppercase', marginBottom:12 }}>Reminders</div>
            <RemindersEditor reminders={reminders} setReminders={setReminders} />
          </div>

          {/* ── Section: Invite ── */}
          <div style={{ borderTop:`1px solid ${colors.border}`, paddingTop:12, marginTop:2 }}>
            <div style={{ fontSize:10, fontWeight:400, color:colors.text.muted, letterSpacing:'0.1em',
              textTransform:'uppercase', marginBottom:12 }}>Invite</div>
            <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
              <div>
                <Label>Peer Group(s)</Label>
                <div style={{ display:'flex', flexWrap:'wrap', gap:8, marginTop:6 }}>
                  {groups.map(g => {
                    const sel = ev.groups.includes(g.id)
                    return (
                      <button key={g.id} onClick={() => toggleGroup(g.id)}
                        style={{ padding:'6px 14px', borderRadius:20, border:`2px solid ${g.color}`, fontFamily:FONT,
                          background:sel ? g.color : 'transparent', color:sel ? '#fff' : g.color,
                          fontSize:13, cursor:'pointer',
                          display:'flex', alignItems:'center', gap:6 }}>
                        <span style={{ width:18, height:18, borderRadius:4, overflow:'hidden',
                          display:'inline-flex', alignItems:'center', justifyContent:'center', fontSize:14, flexShrink:0 }}>
                          {g.icon
                            ? <img src={g.icon} alt="" style={{ width:'100%', height:'100%', objectFit:'cover' }} />
                            : g.emoji}
                        </span>
                        {g.name}
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>
          </div>

          </div>
          {/* Share Busy Time — per-viewer forwarding, always editable (stays interactive for non-creators). */}
          {(() => {
            if (ev.creatorId === 'system') return null
            const others = groups.filter(g => !(ev.groups ?? []).includes(g.id))
            if (others.length === 0) return null
            return (
              <div style={{ borderTop:`1px solid ${colors.border}`, paddingTop:12, marginTop:2,
                display:'flex', flexDirection:'column', gap:6 }}>
                <div style={{ fontSize:10, fontWeight:400, color:colors.text.muted, letterSpacing:'0.1em',
                  textTransform:'uppercase', marginBottom:6 }}>Share Busy Time</div>
                <div style={{ fontSize:11, color:colors.text.muted, marginTop:2, marginBottom:6 }}>
                  Members of these groups will see the title and time — nothing else.
                </div>
                <div style={{ display:'flex', flexWrap:'wrap', gap:8 }}>
                  {others.map(g => {
                    const sel = myForwards.includes(g.id)
                    return (
                      <button key={g.id} onClick={() => toggleForward(g.id)}
                        style={{ padding:'6px 14px', borderRadius:20, border:`2px solid ${g.color}`, fontFamily:FONT,
                          background:sel ? g.color : 'transparent', color:sel ? '#fff' : g.color,
                          fontSize:13, cursor:'pointer',
                          display:'flex', alignItems:'center', gap:6 }}>
                        <span style={{ width:18, height:18, borderRadius:4, overflow:'hidden',
                          display:'inline-flex', alignItems:'center', justifyContent:'center', fontSize:14, flexShrink:0 }}>
                          {g.icon
                            ? <img src={g.icon} alt="" style={{ width:'100%', height:'100%', objectFit:'cover' }} />
                            : g.emoji}
                        </span>
                        {g.name}
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })()}
          <div style={{ display:'flex', flexDirection:'column', gap:14,
            opacity: formLocked ? 0.45 : 1,
            pointerEvents: formLocked ? 'none' : 'auto' }}>

          {/* ── Section: Details (expanders) ── */}
          <div style={{ borderTop:`1px solid ${colors.border}`, paddingTop:12, marginTop:2 }}>
            <div style={{ fontSize:10, fontWeight:400, color:colors.text.muted, letterSpacing:'0.1em',
              textTransform:'uppercase', marginBottom:12 }}>Details</div>
            <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
              {/* Meeting Link */}
              {mlOpen ? (
                <div>
                  <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:4 }}>
                    <Label>Meeting Link</Label>
                    {!ev.meetingLink && (
                      <button onClick={() => setMlOpen(false)}
                        style={{ background:'none', border:'none', cursor:'pointer',
                          color:colors.text.muted, fontSize:16, padding:'0 4px', lineHeight:1 }}>×</button>
                    )}
                  </div>
                  <input style={inputStyle} placeholder="Zoom, Meet, Webex, or Keet link…"
                    value={ev.meetingLink ?? ''} onChange={e => set('meetingLink', e.target.value)} />
                  {ev.meetingLink && /^https?:\/\//i.test(ev.meetingLink.trim()) && (
                    <div onClick={e => { e.stopPropagation(); window.__pearSync?.openURL(ev.meetingLink.trim()) }}
                      style={{ pointerEvents:'auto', display:'flex', alignItems:'center', gap:8,
                        marginTop:6, padding:'8px 10px', borderRadius:8, cursor:'pointer',
                        border:`1px solid ${colors.border}`, background: colors.surface.card }}>
                      <ArrowSquareOut size={15} weight="thin" color="var(--color-accent)" style={{ flexShrink: 0 }} />
                      <span style={{ fontSize:12, color:colors.primary,
                        overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                        {ev.meetingLink.trim()}
                      </span>
                    </div>
                  )}
                </div>
              ) : (
                <button onClick={() => setMlOpen(true)}
                  style={{ display:'flex', alignItems:'center', gap:8,
                    padding:'10px 12px', borderRadius:10, cursor:'pointer',
                    border:`1px dashed ${colors.border}`, background:'transparent',
                    color:colors.text.muted, fontSize:13, fontFamily:FONT, width:'100%' }}>
                  + Add Meeting Link
                </button>
              )}

              {/* Location */}
              {locOpen ? (
                <div>
                  <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:4 }}>
                    <Label>Location</Label>
                    {!ev.location && (
                      <button onClick={() => setLocOpen(false)}
                        style={{ background:'none', border:'none', cursor:'pointer',
                          color:colors.text.muted, fontSize:16, padding:'0 4px', lineHeight:1 }}>×</button>
                    )}
                  </div>
                  <input style={inputStyle} placeholder="Address, place, or landmark…"
                    value={ev.location ?? ''} onChange={e => set('location', e.target.value)} />
                </div>
              ) : (
                <button onClick={() => setLocOpen(true)}
                  style={{ display:'flex', alignItems:'center', gap:8,
                    padding:'10px 12px', borderRadius:10, cursor:'pointer',
                    border:`1px dashed ${colors.border}`, background:'transparent',
                    color:colors.text.muted, fontSize:13, fontFamily:FONT, width:'100%' }}>
                  + Add Location
                </button>
              )}

              {/* Notes (shared via sync for group events) */}
              {notesOpen ? (
                <div>
                  <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:4 }}>
                    <Label>{ev.groups?.length ? 'Shared Notes' : 'Notes'}</Label>
                    {!ev.desc && (
                      <button onClick={() => setNotesOpen(false)}
                        style={{ background:'none', border:'none', cursor:'pointer',
                          color:colors.text.muted, fontSize:16, padding:'0 4px', lineHeight:1 }}>×</button>
                    )}
                  </div>
                  <textarea style={{ ...inputStyle, resize:'none', minHeight:60 }}
                    placeholder={ev.groups?.length ? 'Visible to group members…' : 'Optional notes…'}
                    value={ev.desc} onChange={e => set('desc', e.target.value)} />
                  {extractURLs(ev.desc).map(url => (
                    <div key={url}
                      onClick={e => { e.stopPropagation(); window.__pearSync?.openURL(url) }}
                      style={{ pointerEvents:'auto', display:'flex', alignItems:'center', gap:8,
                        marginTop:6, padding:'8px 10px', borderRadius:8, cursor:'pointer',
                        border:`1px solid ${colors.border}`, background: colors.surface.card }}>
                      <ArrowSquareOut size={15} weight="thin" color="var(--color-accent)" style={{ flexShrink: 0 }} />
                      <span style={{ fontSize:12, color:colors.primary,
                        overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                        {url}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <button onClick={() => setNotesOpen(true)}
                  style={{ display:'flex', alignItems:'center', gap:8,
                    padding:'10px 12px', borderRadius:10, cursor:'pointer',
                    border:`1px dashed ${colors.border}`, background:'transparent',
                    color:colors.text.muted, fontSize:13, fontFamily:FONT, width:'100%' }}>
                  + Add {ev.groups?.length ? 'Shared ' : ''}Notes
                </button>
              )}

            </div>
          </div>

          {/* ── More Options (collapsed by default) ── */}
          <div style={{ borderTop:`1px solid ${colors.border}`, paddingTop:10, marginTop:2 }}>
            <div onClick={() => setMoreOpen(o => !o)}
              style={{ display:'flex', alignItems:'center', justifyContent:'space-between',
                cursor:'pointer', padding:'4px 0' }}>
              <div style={{ fontSize:10, fontWeight:400, color:colors.text.muted, letterSpacing:'0.1em',
                textTransform:'uppercase' }}>More Options</div>
              <CaretRight size={14} weight="thin" color="var(--color-muted)"
                style={{ transition:'transform 0.25s',
                  transform: moreOpen ? 'rotate(90deg)' : 'rotate(0deg)' }} />
            </div>
            <div style={{ maxHeight: moreOpen ? '1200px' : '0px', overflow:'hidden',
              transition:'max-height 0.35s cubic-bezier(0.4, 0, 0.2, 1)' }}>
              <div style={{ display:'flex', flexDirection:'column', gap:14, paddingTop:12 }}>
                {/* Request RSVP */}
                {ev.groups && ev.groups.length > 0 && isEventCreator && (
                  <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:12 }}>
                    <Label>Request RSVP</Label>
                    <button onClick={() => set('rsvpEnabled', !ev.rsvpEnabled)}
                      style={{ width:44, height:26, borderRadius:13, border:'none', cursor:'pointer',
                        background: ev.rsvpEnabled ? colors.primary : colors.border, position:'relative',
                        transition:'background 150ms var(--easing)' }}>
                      <div style={{ position:'absolute', top:3, left: ev.rsvpEnabled ? 21 : 3,
                        width:20, height:20, borderRadius:10, background:'#fff',
                        transition:'left 150ms var(--easing)' }} />
                    </button>
                  </div>
                )}

                {/* Invite Members */}
                {allMembers.length > 0 && (
                  <div>
                    <Label>Invite Select Members</Label>
                    <div style={{ display:'flex', flexWrap:'wrap', gap:8, marginTop:6 }}>
                      {allMembers.map(m => {
                        const sel = ev.invitees.includes(m.id)
                        const g   = groups.find(x => x.members.some(mb => mb.id === m.id))
                        const col = groups.length === 1 && g ? memberColorIndexed(g, m.id) : (g ? g.color : '#888')
                        return (
                          <button key={m.id} onClick={() => toggleInvitee(m.id)}
                            style={{ display:'flex', alignItems:'center', gap:6,
                              padding:'5px 12px 5px 6px', borderRadius:20,
                              border:`2px solid ${col}`, background:sel ? col : 'transparent',
                              cursor:'pointer', fontFamily:FONT }}>
                            <MemberAvatar avatar={m.avatar} avatarHash={m.avatarHash} name={m.nickname || m.name} color={col} size={24} fontSize={11} />
                            <span style={{ fontSize:13, color:sel ? '#fff' : col }}>{m.nickname || m.name}</span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}

                {/* Who can edit? (consolidated — shown in create mode or edit-mode-if-creator) */}
                {(modal.mode === 'create' ||
                  (modal.mode === 'edit' && ev.creatorId !== 'system' &&
                   ev.creatorId && profile?.id && ev.creatorId === profile.id)) && (
                  <div><Label>Who can edit?</Label>
                    <div style={{ display:'flex', gap:8 }}>
                      {[['everyone','Everyone'],['creator','Only me']].map(([val, label]) => (
                        <button key={val} onClick={() => set('editPermission', val)}
                          style={{ flex:1, padding:'8px 0', borderRadius:10, fontSize:13, 
                            cursor:'pointer',
                            border:'1.5px solid ' + (ev.editPermission === val ? colors.primary : colors.border),
                            background: ev.editPermission === val ? colors.primary : 'transparent',
                            color: ev.editPermission === val ? '#fff' : colors.text.muted }}>
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Recurring series hint */}
          {modal.mode === 'edit' && ev.recurrenceId && (
            <div style={{ fontSize:12, color:colors.text.muted,
              display:'flex', alignItems:'center', gap:6 }}>
              <Repeat size={13} weight="thin" color="var(--color-muted)" />
              {' '}Recurring series — editing this occurrence only
            </div>
          )}

          </div>

          {modal.mode === 'edit' && ev.rsvpEnabled && !isEventCreator && (
            <div>
              <Label>Your Response</Label>
              <div style={{ display:'flex', gap:8 }}>
                {[['going','Going'],['declined','Decline']].map(([val, label]) => (
                  <button key={val} onClick={() => respondRsvp(val)}
                    style={{ flex:1, padding:'10px 0', borderRadius:10, fontSize:14, 
                      cursor:'pointer',
                      border:'1.5px solid ' + (myRsvp === val ? (val === 'going' ? '#5DBF8A' : '#D45F7A') : colors.border),
                      background: myRsvp === val ? (val === 'going' ? '#5DBF8A' : '#D45F7A') : 'transparent',
                      color: myRsvp === val ? '#fff' : colors.text.muted }}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {(() => {
            const isCreator = ev.creatorId && profile?.id && ev.creatorId === profile.id
            const isHoliday = modal.mode === 'edit' && ev.creatorId === 'system'
            const isReadOnly = modal.mode === 'edit' && ev.editPermission === 'creator' && !isCreator
            if (isHoliday) return (
              <div style={{ fontSize:12, color:colors.text.muted, textAlign:'center',
                padding:'8px 0', border:'1px solid ' + colors.border, borderRadius:10 }}>
                🗓 Public holiday — toggle off in Profile to remove all
              </div>
            )
            if (isReadOnly) return (
              <div style={{ fontSize:12, color:colors.text.muted, textAlign:'center',
                padding:'8px 0', border:'1px solid ' + colors.border, borderRadius:10 }}>
                <Lock size={13} weight="thin" color="var(--color-muted)" />
                {' '}Read only — only the creator can edit this event
              </div>
            )
            return null
          })()}

        </div>

          {/* Private Notes — always editable, even when event is read-only */}
          <div style={{ padding:'0 20px 8px', display:'flex', flexDirection:'column', gap:6 }}>
            {privNotesOpen ? (
              <div>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:4 }}>
                  <Label>Private Notes</Label>
                  {!ev.privateNote && (
                    <button onClick={() => setPrivNotesOpen(false)}
                      style={{ background:'none', border:'none', cursor:'pointer',
                        color:colors.text.muted, fontSize:16, padding:'0 4px', lineHeight:1 }}>×</button>
                  )}
                </div>
                <textarea style={{ ...inputStyle, resize:'none', minHeight:60 }}
                  placeholder="Only visible to you — never synced…"
                  value={ev.privateNote ?? ''}
                  onChange={e => {
                    const v = e.target.value
                    set('privateNote', v)
                    if (modal.mode === 'edit' && ev.id) {
                      db?.putPrivateNote(ev.id, v).catch(() => {})
                    }
                  }} />
              </div>
            ) : (
              <button onClick={() => setPrivNotesOpen(true)}
                style={{ display:'flex', alignItems:'center', gap:8,
                  padding:'10px 12px', borderRadius:10, cursor:'pointer',
                  border:`1px dashed ${colors.border}`, background:'transparent',
                  color:colors.text.muted, fontSize:13, fontFamily:FONT, width:'100%' }}>
                + Add Private Notes
              </button>
            )}
          </div>

          {modal.mode === 'edit' && (() => {
            const isCreator = ev.creatorId && profile?.id && ev.creatorId === profile.id
            const label = isCreator ? 'Delete' : 'Remove for Me'
            const onClick = () => {
              if (ev.recurrenceId) {
                bsCloseRef.current?.()
                onRequestConfirm({ type: 'deleteScope', ev, isCreator })
              } else if (isCreator) {
                bsCloseRef.current?.()
                onRequestConfirm({ type: 'deleteEvent', ev })
              } else {
                onDelete(ev.id)
              }
            }
            return (
              <div style={{ padding:'0 20px 16px', display:'flex', flexDirection:'column', gap:8 }}>
                <button onClick={onClick}
                  style={{ background:'transparent', border:`1px solid #D45F7A`, borderRadius:12,
                    padding:'11px', color:'#D45F7A', fontSize:14, 
                    fontFamily:FONT, cursor:'pointer', width:'100%' }}>
                  {label}
                </button>
              </div>
            )
          })()}

    </BottomSheet>
  )
}

// ─── Groups Tab ───────────────────────────────────────────────────────────────
function JoinGroupModal ({ onClose, closeRef, db, sync, onJoined, onPendingJoin }) {
  const bsCloseRef = useRef(null)
  const [pasteMode, setPasteMode] = useState(false)
  const [pasteUrl,  setPasteUrl]  = useState('')
  const [pasteErr,  setPasteErr]  = useState('')

  useEffect(() => {
    if (closeRef) {
      closeRef.current = () => { bsCloseRef.current?.(); return true }
      return () => { closeRef.current = null }
    }
  }, [])

  function handlePasteJoin () {
    const url = pasteUrl.trim()
    if (!url.startsWith('https://peerloomllc.com/join') && !url.startsWith('pear://pearcal/join') && !url.startsWith('pearcal://join')) { setPasteErr('Not a valid PearCal invite link.'); return }
    const groupName = (() => { try { return new URL(url).searchParams.get('name') || 'a group' } catch { return 'a group' } })()
    bsCloseRef.current?.()
    onPendingJoin?.({ url, groupName })
  }

  return (
    <BottomSheet onClose={onClose} zIndex={100} closeRef={bsCloseRef}>
      <div style={{ padding:'0 20px 8px', display:'flex', flexDirection:'column', gap:14 }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:4 }}>
          <span style={{ fontSize:17, color: colors.text.primary }}>Join a Group</span>
          <button onClick={() => bsCloseRef.current?.()} style={{ ...iconBtn, fontSize:20 }}>✕</button>
        </div>
        {!pasteMode ? (
          <>
            {!IS_DESKTOP && (
              <button onClick={() => { bsCloseRef.current?.(); setTimeout(() => sync?.qrScan?.(), 50) }}
                style={{ ...pillBtn, width:'100%', padding:'14px', fontSize:15,
                  display:'flex', alignItems:'center', justifyContent:'center', gap:10 }}>
                <QrCode size={22} weight="thin" /> Scan QR Code
              </button>
            )}
            <button onClick={() => setPasteMode(true)}
              style={{ ...pillBtn, width:'100%', padding:'14px', fontSize:15, 
                display:'flex', alignItems:'center', justifyContent:'center', gap:10 }}>
              <ArrowSquareOut size={20} weight="thin" color="#fff" /> Paste Invite Link
            </button>
          </>
        ) : (
          <>
            <textarea value={pasteUrl} onChange={e => { setPasteUrl(e.target.value); setPasteErr('') }}
              placeholder='Paste invite link here…'
              style={{ width:'100%', minHeight:80, borderRadius:10, padding:'10px 12px',
                fontSize:13, fontFamily:'inherit', resize:'none', boxSizing:'border-box',
                background: colors.surface.input, border:'1px solid ' + (pasteErr ? '#D45F7A' : colors.border),
                color:'#111', outline:'none' }} />
            {pasteErr && <div style={{ fontSize:12, color:'#D45F7A' }}>{pasteErr}</div>}
            <div style={{ display:'flex', gap:8 }}>
              <button onClick={() => { setPasteMode(false); setPasteUrl(''); setPasteErr('') }}
                style={{ flex:1, padding:'10px', borderRadius:10, fontSize:13, 
                  background:'transparent', border:'1px solid ' + colors.border, color:colors.text.muted, cursor:'pointer' }}>
                Back
              </button>
              <button onClick={handlePasteJoin} disabled={!pasteUrl.trim()}
                style={{ flex:1, ...pillBtn, padding:'10px', fontSize:13, 
                  opacity: !pasteUrl.trim() ? 0.5 : 1 }}>
                Join
              </button>
            </div>
          </>
        )}
      </div>
    </BottomSheet>
  )
}

function NicknameBeforeJoinSheet ({ groupName, defaultName, onConfirm, onClose, closeRef, onOutcome }) {
  const bsCloseRef = useRef(null)
  const [nickname, setNickname] = useState(defaultName)
  const [joining,  setJoining]  = useState(false)
  const [err,      setErr]      = useState('')

  useEffect(() => {
    if (closeRef) {
      closeRef.current = () => { bsCloseRef.current?.(); return true }
      return () => { closeRef.current = null }
    }
  }, [])

  async function handleJoin () {
    setJoining(true); setErr('')
    const result = await onConfirm(nickname.trim())
    if (result && !result.ok) {
      setJoining(false)
      // TODO #145: every outcome but blocked_from_group used to end here as
      // either a silent close or "Check the invite link and try again" - which
      // is the wrong advice whenever the link is fine and the repair is what
      // failed. Say which of the dozen things actually happened.
      // blocked_from_group keeps its dedicated toast, raised by joinWithNickname,
      // so saying it twice here would be worse than saying it once.
      if (result.error === 'blocked_from_group') { bsCloseRef.current?.(); return }
      const outcome = joinOutcomeMessage({ error: result.error, reason: result.reason, groupName })
      if (isBenignJoinOutcome(result)) { onOutcome?.(outcome); bsCloseRef.current?.(); return }
      setErr(outcome.message)
    }
  }

  return (
    <BottomSheet onClose={onClose} zIndex={110} closeRef={bsCloseRef}>
      <div style={{ padding:'0 20px 16px', display:'flex', flexDirection:'column', gap:14 }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:4 }}>
          <span style={{ fontSize:17, color: colors.text.primary }}>Join {groupName}</span>
          <button onClick={() => bsCloseRef.current?.()} style={{ ...iconBtn, fontSize:20 }}>✕</button>
        </div>
        <div style={{ fontSize:13, color:colors.text.muted }}>
          How should group members see your name?
        </div>
        <input
          value={nickname}
          onChange={e => setNickname(e.target.value)}
          placeholder='Your nickname'
          style={{ background:colors.surface.input, border:`1px solid ${colors.border}`, borderRadius:8,
            padding:'9px 12px', color:colors.text.primary, fontSize:14, 
            fontFamily:FONT, width:'100%', boxSizing:'border-box', outline:'none' }}
        />
        {err ? <div style={{ fontSize:12, color:'#e55' }}>{err}</div> : null}
        <button
          onClick={handleJoin}
          disabled={joining || !nickname.trim()}
          style={{ ...pillBtn, width:'100%', padding:'13px', fontSize:15, 
            opacity: (joining || !nickname.trim()) ? 0.5 : 1 }}>
          {joining ? 'Joining…' : 'Join Group'}
        </button>
      </div>
    </BottomSheet>
  )
}

function GroupsTab ({ groups, profile, sync, db, readyGroupKeys, pendingApprovalGroups, onNewGroup, onSettings, onQrGroup, onJoined, joinOpen, setJoinOpen, closeInviteSheetRef }) {
  const [copiedId,         setCopiedId]         = useState(null)
  // Set when the worklet refuses to mint a link because this device holds no
  // block key for an encrypted group (#164). Better a visible refusal than a
  // link that quietly produces a member who can never sync.
  const [copyFailed,       setCopyFailed]       = useState(null)
  const [inviteModalGroup, setInviteModalGroup] = useState(null)

  useEffect(() => {
    const s = typeof window !== 'undefined' ? window.__pearScreenshotScene : null
    if (s?.openInviteGroupId) {
      const g = groups.find(gr => gr.id === s.openInviteGroupId)
      // Same shape as the real button: the worklet mints the link (#164).
      if (g) db?.buildInvite(g.id).then(link => setInviteModalGroup({ group: g, link })).catch(() => {})
    }
  }, [groups])

  async function copyInvite (g, e) {
    e.stopPropagation()
    if (!readyGroupKeys.has(g.id)) return
    // #164 - the worklet builds the link from the authoritative group record.
    // This used to fetch the record and build here, which is one copy too many:
    // any group object missing the local-only encryptionKey mints a link with
    // no `enc=`, and whoever accepts it joins keyless and never syncs.
    const link = await db?.buildInvite(g.id).catch(() => null)
    if (!link) { setCopyFailed(g.id); setTimeout(() => setCopyFailed(null), 4000); return }
    navigator.clipboard?.writeText(link)
    setCopiedId(g.id)
    setTimeout(() => setCopiedId(null), 2000)
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100%', position:'relative' }}>
      <div style={{ flex:1, overflowY:'auto', padding:'16px 16px calc(88px + var(--safe-area-bottom))', WebkitOverflowScrolling:'touch' }}>


      {groups.length === 0 && (
        <div style={{ textAlign:'center', color:colors.text.muted, fontSize:14, padding:'48px 0' }}>
          No groups yet — create one or join one!
        </div>
      )}

      <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
        {groups.map(g => (
          <div key={g.id} style={{ background: colors.surface.card, borderRadius:14, padding:'16px', borderLeft:`4px solid ${g.color}` }}>
            <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:10 }}>
              <GroupIcon group={g} />
              <div style={{ flex:1 }}>
                <div style={{ fontSize:15, color: colors.text.primary }}>{g.name}</div>
                <div style={{ fontSize:12, color:colors.text.muted }}>
                  {(g.members ?? []).length} member{(g.members ?? []).length !== 1 ? 's' : ''}
                </div>
              </div>
              <button onClick={() => onSettings(g)}
                style={{ ...iconBtn, fontSize:18, padding:'6px', borderRadius:10, border:`1px solid ${colors.border}` }}>
                <GearSix size={18} weight="thin" color="var(--color-muted)" />
              </button>
            </div>
            {pendingApprovalGroups?.has(g.id) && (
              <div style={{ background:'#F5C47422', border:'1px solid #F5C47466', borderRadius:10,
                padding:'10px 12px', marginBottom:12, display:'flex', gap:10, alignItems:'flex-start' }}>
                <Hourglass size={18} weight="thin" color="#F5C474" style={{ flexShrink:0, marginTop:1 }} />
                <div style={{ flex:1, fontSize:12, color: colors.text.primary, lineHeight:1.4 }}>
                  <div style={{ fontWeight:400, marginBottom:2 }}>Waiting for owner approval</div>
                  <div style={{ color:colors.text.muted }}>
                    The owner must approve your return before you'll see the group's members and events.
                  </div>
                </div>
              </div>
            )}

            {/* TODO #124: this device holds no block-encryption key for an
                encrypted group, so it sits on the raw-groupKey swarm topic
                while every keyed peer is on the domain-separated one. It will
                never sync, and every invite it mints omits `enc=`, quietly
                breaking whoever accepts it. A fresh invite from a current
                member is the only cure and nothing used to say so. */}
            {g.keyless && (
              <div style={{ background:'#E5484D1A', border:'1px solid #E5484D55', borderRadius:10,
                padding:'10px 12px', marginBottom:12, display:'flex', gap:10, alignItems:'flex-start' }}>
                <Lock size={18} weight="thin" color="#E5484D" style={{ flexShrink:0, marginTop:1 }} />
                <div style={{ flex:1, fontSize:12, color: colors.text.primary, lineHeight:1.4 }}>
                  <div style={{ fontWeight:400, marginBottom:2 }}>
                    {g.keyless.certainty === 'certain'
                      ? "This group can't sync on this device"
                      : "This group hasn't synced since you joined"}
                  </div>
                  <div style={{ color:colors.text.muted }}>
                    {g.keyless.certainty === 'certain'
                      ? 'It is encrypted and this device is missing the key, so it cannot reach the other members.'
                      : 'It may be encrypted with a key this device is missing, or the others may simply be offline.'}
                    {' '}Ask a member to send you a fresh invite link, then paste it into Join Group to repair it.
                  </div>
                  <div style={{ color:colors.text.muted, marginTop:4, fontSize:11 }}>Group ID: {g.id}</div>
                </div>
              </div>
            )}

            {/* #155: a shared calendar going quiet used to be completely
                invisible. Reported from the field: a five-member group stopped
                syncing, the app said nothing, and the user repaired it by
                creating a NEW group and moving every event across, which meant
                re-inviting everyone. Shown only when there IS somebody to sync
                with and we have a baseline to judge against, so groups that
                predate this stay quiet rather than crying wolf on first launch.
                Suppressed when the keyless banner above is already saying it. */}
            {!g.keyless && g.syncHealth?.state === 'stale' && (
              <div style={{ background:'#F5A62333', border:'1px solid #F5A62366', borderRadius:10,
                padding:'10px 12px', marginBottom:12, display:'flex', gap:10, alignItems:'flex-start' }}>
                <Warning size={18} weight="thin" color="#F5A623" style={{ flexShrink:0, marginTop:1 }} />
                <div style={{ flex:1, fontSize:12, color: colors.text.primary, lineHeight:1.4 }}>
                  <div style={{ fontWeight:400, marginBottom:2 }}>
                    {g.syncHealth.reason === 'never-synced'
                      ? "This calendar hasn't synced yet"
                      : 'This calendar hasn\'t synced in ' + fmtSyncAge(g.syncHealth.sinceMs)}
                  </div>
                  <div style={{ color:colors.text.muted }}>
                    {g.syncHealth.reason === 'never-synced'
                      ? 'Nothing has arrived from the other members since you joined.'
                      : 'Nothing has arrived from the other members for a while.'}
                    {' '}They may simply be offline. If they are using it and you still see this,
                    ask one of them to send you a fresh invite link and paste it into Join Group.
                  </div>
                </div>
              </div>
            )}

            {/* #159. There IS a notice for this, decided by classifyIndexerNotice
                in src/lib/indexerHealth.js, and it is deliberately not rendered
                yet. Two reasons, both decided 2026-08-07:

                  - The wording was ours, not a user's. Nobody outside the
                    codebase thinks of their calendar as having "history" that
                    gets "permanently saved".
                  - More importantly there is nothing to DO about it. A notice
                    that worries someone and offers no action is worse than
                    silence. Compare the #155 sync warning, which earns its place
                    because it tells you to ask for a fresh invite.

                The repair (proposal scenario K: everyone opens the app at the
                same time, and the calendar is fixed for good) is the action this
                notice is missing. Render it then, with that button, in words a
                person would actually use.

                The classifier and its tests stay because the decision is the
                hard part and it is already correct - including the regression
                where it stayed silent on the worst-affected calendar. The data
                behind it is not idle either: `indexers` feeds the rollout gate
                and gives the fleet-wide picture that otherwise means pulling
                databases off phones by hand. */}

            {/* Member avatars */}
            <div style={{ display:'flex', gap:6, marginBottom:12, flexWrap:'wrap' }}>
              {(g.members ?? []).map(m => (
                <div key={m.id} style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:3 }}>
                  <MemberAvatar avatar={m.avatar} avatarHash={m.avatarHash} name={m.nickname || m.name} color={groups.length === 1 ? memberColorIndexed(g, m.id) : g.color} size={34} fontSize={13} />
                  <span style={{ fontSize:10, color:colors.text.muted }}>{m.nickname || m.name}</span>
                </div>
              ))}
            </div>


            {/* #164 - the worklet refused to mint a link, which it only does
                when this device holds no block key for an encrypted group.
                Silence here would be the original bug in a new costume: the
                user would think they had shared something. */}
            {copyFailed === g.id && (
              <div style={{ background:'#E5484D1A', border:'1px solid #E5484D55', borderRadius:10,
                padding:'10px 12px', marginBottom:8, fontSize:12, color: colors.text.primary, lineHeight:1.4 }}>
                <div style={{ marginBottom:2 }}>Can't create an invite on this device</div>
                <div style={{ color:colors.text.muted }}>
                  This calendar is encrypted and this device is missing the key, so any
                  link it made would not work. Ask a member for a fresh invite and paste
                  it into Join Group first.
                </div>
              </div>
            )}

            <button onClick={async e => {
                e.stopPropagation()
                if (!readyGroupKeys.has(g.id)) return
                // #164 - mint the link in the worklet, from the authoritative
                // record, and carry it into the modal. Building it at render
                // time from a UI copy is what produced invites with no `enc=`.
                const link = await db?.buildInvite(g.id).catch(() => null)
                if (!link) { setCopyFailed(g.id); setTimeout(() => setCopyFailed(null), 4000); return }
                setInviteModalGroup({ group: g, link })
              }}
              disabled={!readyGroupKeys.has(g.id)}
              style={{ width:'100%', padding:'10px', fontSize:13, fontFamily:FONT,
                background:'transparent', border:`1px solid ${g.color}44`, borderRadius:10,
                color:readyGroupKeys.has(g.id) ? g.color : colors.text.muted,
                cursor:readyGroupKeys.has(g.id) ? 'pointer' : 'not-allowed',
                opacity:readyGroupKeys.has(g.id) ? 1 : 0.5 }}>
              <ShareNetwork size={16} weight="thin" style={{ display:'inline', verticalAlign:'middle' }} /> Share Group Invite
            </button>
          </div>
        ))}
      </div>
      </div>

      {/* Floating action buttons — anchored above bottom nav */}
      <div style={{ position:'fixed', bottom:'calc(53px + var(--safe-area-bottom) + 12px)',
        left:'50%', transform:'translateX(-50%)',
        width:'calc(100% - 64px)', maxWidth:366,
        display:'flex', justifyContent:'center', gap:10, pointerEvents:'none' }}>
        <button onClick={() => setJoinOpen(true)} style={{
          flex:1, height:44, borderRadius:22,
          background:'var(--color-surface)', border:'1px solid var(--color-border)',
          boxShadow:'0 2px 12px rgba(0,0,0,0.18)',
          display:'flex', alignItems:'center', justifyContent:'center', gap:8,
          cursor:'pointer', fontFamily:FONT, fontSize:14, color:'var(--color-text)',
          pointerEvents:'auto'
        }}>
          <UserPlus size={18} weight="thin" color="var(--color-text)" /> Join Group
        </button>
        <button onClick={onNewGroup} style={{
          flex:1, height:44, borderRadius:22,
          background:'var(--color-accent)', border:'none',
          boxShadow:'0 2px 12px rgba(0,0,0,0.18)',
          display:'flex', alignItems:'center', justifyContent:'center', gap:8,
          cursor:'pointer', fontFamily:FONT, fontSize:14, color:'#fff',
          pointerEvents:'auto'
        }}>
          <Plus size={18} weight="thin" /> New Group
        </button>
      </div>
      {inviteModalGroup && (
        <InviteOptionsModal
          group={inviteModalGroup.group}
          link={inviteModalGroup.link}
          sync={sync}
          onQrGroup={onQrGroup}
          onClose={() => setInviteModalGroup(null)}
          closeRef={closeInviteSheetRef}
        />
      )}
    </div>
  )
}

// ─── Invite Options Modal ──────────────────────────────────────────────────────
// `link` is minted by the worklet from the authoritative group record and handed
// in (#164). Deliberately NOT rebuilt here: this component only ever sees a UI
// copy of the group, and a copy missing the local-only encryptionKey is exactly
// what produced invites with no `enc=`.
function InviteOptionsModal ({ group, link, sync, onQrGroup, onClose, closeRef }) {
  const bsCloseRef = useRef(null)
  const shareMsg = `You've been invited to join ${group.name} as a peer in PearCal. To join, paste this link into PearCal:\n\n${link}`

  useEffect(() => {
    if (closeRef) {
      closeRef.current = () => { bsCloseRef.current?.(); return true }
      return () => { closeRef.current = null }
    }
  }, [])

  const row = (icon, title, subtitle, onClick) => (
    <button onClick={onClick}
      style={{ background:'transparent', border:`1px solid ${colors.border}`, borderRadius:12,
        padding:'14px 16px', display:'flex', alignItems:'center', gap:12,
        cursor:'pointer', fontFamily:FONT, width:'100%', textAlign:'left' }}>
      <span style={{ fontSize:22, flexShrink:0 }}>{icon}</span>
      <div>
        <div style={{ fontSize:14, color: colors.text.primary }}>{title}</div>
        <div style={{ fontSize:12, color:colors.text.muted }}>{subtitle}</div>
      </div>
    </button>
  )

  return (
    <BottomSheet onClose={onClose} zIndex={300} closeRef={bsCloseRef}>
      <div style={{ padding:'0 16px 8px' }}>
        <div style={{ fontSize:16, color: colors.text.primary, marginBottom:16 }}>
          Invite to {group.name}
        </div>
        <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
          {row(<ShareNetwork size={22} weight="thin" color="var(--color-text)" />, 'Share Link…', 'Send via messages, email, etc.', () => {
            bsCloseRef.current?.()
            setTimeout(() => sync?.nativeShare(`Join ${group.name} on PearCal`, shareMsg), 50)
          })}
          {row(<QrCode size={22} weight="thin" color="var(--color-text)" />, 'Show QR Code', 'Scan to join instantly', () => {
            bsCloseRef.current?.()
            setTimeout(() => onQrGroup({ group, link }), 50)
          })}
        </div>
      </div>
    </BottomSheet>
  )
}

// ─── Admit a Blind Peer (blind-seeder QR pairing) ─────────────────────────────
// The blind peer (seeder) displays a QR; the member scans it here. Scanning
// joins the seeder's one-time rendezvous, verifies its pubkey, and pushes an
// all-groups seed bundle so the seeder enrolls every group — encrypted, so it
// replicates ciphertext it can never read (proposal 2026-07-15-pearcal-seeder-
// port, QR-pairing model from PearCircle). "Blind peer" is the user-facing term
// (project_blind_peer_terminology).
function BlindPeerSheet ({ db, sync, onClose, qrScanModeRef }) {
  const bsCloseRef = useRef(null)
  const [groupInfo, setGroupInfo] = useState({ loading: true })
  // phase: 'idle' | 'scanning' | 'pairing' | 'success' | 'error'
  // 'scanning' is the camera being up; 'pairing' is the worklet on the
  // rendezvous, which is the only phase with a deadline to count down.
  const [phase, setPhase] = useState('idle')
  const [result, setResult] = useState(null)
  const [copied, setCopied] = useState(false)
  // Seconds left before seederPairScan gives up. Started when the worklet takes
  // the scanned link, so it counts the same 60s the worklet's own timer does
  // (issue #265 - the sheet used to sit on a static "Pairing…" with no way to
  // tell a working pair from a stalled one).
  const [secsLeft, setSecsLeft] = useState(null)

  useEffect(() => {
    let cancelled = false
    db.mintSeedBundle?.()
      .then(r => { if (!cancelled) setGroupInfo({ loading: false, ...r }) })
      .catch(() => { if (!cancelled) setGroupInfo({ loading: false, count: 0 }) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    function onResult (r) {
      if (r?.pending) { setPhase('pairing'); return }
      if (r?.cancelled) { setPhase('idle'); return }
      if (r?.ok) { setResult(r); setPhase('success'); window.__pearSync?.haptic('success') }
      else { setResult(r); setPhase('error') }
    }
    emitter.on('seederPairResult', onResult)
    return () => emitter.off('seederPairResult', onResult)
  }, [])

  // Tick once a second for as long as the worklet is on the rendezvous. Derived
  // from a start timestamp rather than by decrementing, so a dropped or delayed
  // tick (a backgrounded WebView, a slow render) self-corrects instead of
  // leaving the countdown permanently behind the real deadline.
  useEffect(() => {
    if (phase !== 'pairing') { setSecsLeft(null); return }
    const startedAt = Date.now()
    setSecsLeft(secondsRemaining(0, SEEDER_PAIR_SCAN_TIMEOUT_MS))
    const t = setInterval(() => {
      setSecsLeft(secondsRemaining(Date.now() - startedAt, SEEDER_PAIR_SCAN_TIMEOUT_MS))
    }, 1000)
    return () => clearInterval(t)
  }, [phase])

  const count = groupInfo.count ?? 0
  const encryptedCount = (groupInfo.groups ?? []).filter(g => g.encrypted).length

  const startScan = () => {
    if (!qrScanModeRef || !sync?.qrScan) return
    window.__pearSync?.haptic('light')
    setPhase('scanning')
    qrScanModeRef.current = 'seederPair'
    sync.qrScan()
  }

  // Reverse of scanning: hand the seeder a link instead of scanning its QR.
  // Copies the all-groups seed bundle so it can be pasted into the blind peer's
  // dashboard ("Paste invite" tab). More reliable than QR pairing when the
  // rendezvous can't hole-punch (e.g. phone + seeder behind the same router),
  // and easier when the dashboard is open on the same phone.
  const copyBundle = () => {
    if (!groupInfo.bundle) return
    window.__pearSync?.haptic('light')
    sync?.copyText?.(groupInfo.bundle)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <BottomSheet onClose={onClose} zIndex={300} closeRef={bsCloseRef}>
      <div style={{ padding:'0 20px 8px' }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:10, marginBottom:12 }}>
          <ShieldCheck size={24} weight="thin" color="var(--color-accent)" />
          <span style={{ fontSize:17, color: colors.text.primary }}>Admit a blind peer</span>
        </div>

        {phase === 'success' ? (
          <div style={{ textAlign:'center', padding:'8px 0 4px' }}>
            <CheckCircle size={44} weight="thin" color="#5DBF8A" />
            <div style={{ fontSize:15, color: colors.text.primary, marginTop:10 }}>
              Paired with your blind peer
            </div>
            <div style={{ fontSize:13, color: colors.text.muted, marginTop:6, lineHeight:1.5 }}>
              It's now keeping {result?.enrolled ?? 0} group{(result?.enrolled ?? 0) === 1 ? '' : 's'} synced,
              even when no one else is online.
            </div>
            {Array.isArray(result?.names) && result.names.length > 0 && (
              <div style={{ fontSize:12, color: colors.text.muted, marginTop:8 }}>
                {result.names.join(' · ')}
              </div>
            )}
            <button onClick={() => bsCloseRef.current?.()}
              style={{ ...pillBtn, width:'100%', padding:'11px', fontSize:14, marginTop:18 }}>
              Done
            </button>
          </div>
        ) : (phase === 'pairing' || phase === 'scanning') ? (
          <div style={{ textAlign:'center', padding:'20px 0' }}>
            <ArrowsClockwise size={30} weight="thin" color="var(--color-accent)"
              style={{ animation:'pearSpin 900ms linear infinite' }} />
            <div style={{ fontSize:14, color: colors.text.primary, marginTop:10 }}>
              {phase === 'scanning' ? 'Scanning…' : 'Pairing…'}
            </div>
            <div style={{ fontSize:13, color: colors.text.muted, marginTop:8, lineHeight:1.5 }}>
              Connecting to the blind peer. Make sure you scanned the QR currently on its
              screen — a QR that's already been used won't connect.
            </div>
            {/* The deadline is the worklet's, not this timer's: at 0 the scan
                itself fails and the error phase takes over, so the countdown
                only ever reports. */}
            {phase === 'pairing' && secsLeft != null && (
              <div style={{ fontSize:12, color: colors.text.muted, marginTop:10 }}>
                {secsLeft > 0
                  ? 'Giving up in ' + formatCountdown(secsLeft)
                  : 'Taking longer than expected…'}
              </div>
            )}
            <button onClick={() => { db.cancelSeederPairScan?.().catch(() => {}); setPhase('idle') }}
              style={{ background:'none', border:`1px solid ${colors.border}`, color: colors.text.muted,
                fontFamily:FONT, padding:'8px 20px', fontSize:13, cursor:'pointer', borderRadius:8, marginTop:18 }}>
              Cancel
            </button>
          </div>
        ) : (
          <>
            <div style={{ fontSize:13, color: colors.text.muted, lineHeight:1.5, marginBottom:16 }}>
              A blind peer is an always-on device (a home server, Umbrel, or Mac) that keeps your
              groups in sync even when no one else is online. It stores them <b>encrypted</b> and
              can never read them. Open its screen and <b>scan the QR code</b> it shows.
            </div>

            {phase === 'error' && (
              <div style={{ fontSize:13, color:'#e67b7b', textAlign:'center', padding:'0 0 12px' }}>
                {result?.error || 'Pairing failed'} — try again.
              </div>
            )}

            {!groupInfo.loading && count === 0 ? (
              <div style={{ fontSize:13, color: colors.text.muted, textAlign:'center', padding:'8px 0 16px' }}>
                You're not in any groups yet. Create or join a group first, then admit a blind peer
                to keep it synced.
              </div>
            ) : (
              <>
                {!groupInfo.loading && (
                  <div style={{ fontSize:12, color: colors.text.muted, marginBottom:14 }}>
                    Will enroll {count} group{count === 1 ? '' : 's'}
                    {encryptedCount < count && <span> · {encryptedCount} encrypted (blind), {count - encryptedCount} legacy</span>}
                  </div>
                )}
                {!IS_DESKTOP && (
                  <>
                    <button data-haptic="light" onClick={startScan}
                      style={{ ...pillBtn, width:'100%', padding:'12px', fontSize:15,
                        display:'flex', alignItems:'center', justifyContent:'center', gap:8 }}>
                      <QrCode size={18} weight="thin" /> Scan blind peer QR
                    </button>
                    <div style={{ display:'flex', alignItems:'flex-start', gap:8, marginTop:10,
                      padding:'9px 11px', borderRadius:9, background:'rgba(224,168,86,0.10)',
                      border:'1px solid rgba(224,168,86,0.28)' }}>
                      <Warning size={15} weight="thin" color="#E0A856" style={{ flexShrink:0, marginTop:1 }} />
                      <span style={{ fontSize:11, color: colors.text.muted, lineHeight:1.5 }}>
                        Scanning needs your phone and the blind peer on <b>different networks</b> — if
                        they share the same Wi-Fi, the connection often can't form. On the same network,
                        use <b>Copy invite link</b> below instead.
                      </span>
                    </div>
                    <div style={{ display:'flex', alignItems:'center', gap:10, margin:'12px 0' }}>
                      <div style={{ flex:1, height:1, background:colors.border }} />
                      <span style={{ fontSize:11, color:colors.text.muted }}>or</span>
                      <div style={{ flex:1, height:1, background:colors.border }} />
                    </div>
                  </>
                )}
                <button data-haptic="light" onClick={copyBundle}
                  style={{ width:'100%', padding:'11px', fontSize:14, fontFamily:FONT,
                    background:'none', color:colors.text.primary, cursor:'pointer',
                    border:`1px solid ${colors.border}`, borderRadius:10,
                    display:'flex', alignItems:'center', justifyContent:'center', gap:8 }}>
                  {copied
                    ? <><CheckCircle size={18} weight="thin" color="#5DBF8A" /> Invite copied</>
                    : <><Copy size={18} weight="thin" /> Copy invite link</>}
                </button>
                <div style={{ fontSize:11, color: colors.text.muted, marginTop:8, lineHeight:1.5 }}>
                  Paste it into the blind peer's dashboard — the <b>Paste invite</b> tab — to enroll
                  all {count} group{count === 1 ? '' : 's'} without scanning.
                </div>
              </>
            )}
            <div style={{ fontSize:11, color: colors.text.muted, marginTop:12, lineHeight:1.5 }}>
              Nothing you scan reveals a group's contents — the pairing only shares each group's
              encrypted-sync address, never its decryption key.
            </div>
          </>
        )}
      </div>
    </BottomSheet>
  )
}

// ─── Group Settings Modal ─────────────────────────────────────────────────────
function GroupSettingsModal ({ group, me, db, sync, totalGroupsCount = 1, pendingApproval = false, onClose, onUpdate, onDelete, onMemberLeft, onNicknameChange, onRequestConfirm, closeRef }) {
  const bsCloseRef = useRef(null)
  useEffect(() => {
    if (closeRef) {
      closeRef.current = () => { bsCloseRef.current?.(); return true }
      return () => { closeRef.current = null }
    }
  }, [])
  const [g,       setG]       = useState({ ...group })
  const [nameErr, setNameErr] = useState('')
  const [saved,   setSaved]   = useState(false)
  const [saving,  setSaving]  = useState(false)
  const [nickInput, setNickInput] = useState(() => (group.members ?? []).find(m => m.id === me?.id)?.nickname ?? '')
  const [nickSaved, setNickSaved] = useState(false)
  const [rejoinRequests, setRejoinRequests] = useState([])
  const [transferPicker, setTransferPicker] = useState(false)
  const [showAllHistory, setShowAllHistory] = useState(false)
  const fileRef = useRef()
  const isOwner  = g.ownerId === me?.id
  const isAdmin  = !isOwner && (g.admins ?? []).includes(me?.id)
  const canManage = isOwner || isAdmin
  const isMember = g.members.some(m => m.id === me?.id)
  // Mirrors the bare.js constant (CLAIM_OWNERSHIP_INACTIVITY_MS). Keep in sync.
  const CLAIM_OWNERSHIP_INACTIVITY_MS = 30 * 24 * 60 * 60 * 1000
  const lastOwnerActivityTs = g.lastOwnerActivityTs ?? g.updatedAt ?? 0
  const ownerInactiveMs = Date.now() - lastOwnerActivityTs
  const canClaimOwnership = !isOwner && isMember && ownerInactiveMs > CLAIM_OWNERSHIP_INACTIVITY_MS
  const ownerInactiveDays = Math.max(0, Math.floor(ownerInactiveMs / 86_400_000))

  useEffect(() => {
    if (!canManage) return
    let cancelled = false
    const refresh = () => {
      db.listPendingRejoins?.().then(rows => {
        if (cancelled) return
        setRejoinRequests((rows ?? []).filter(r => r.groupId === g.id))
      }).catch(() => {})
    }
    refresh()
    const onPending = (d) => { if (d?.groupId === g.id) refresh() }
    emitter.on('pendingRejoin', onPending)
    return () => { cancelled = true; emitter.off('pendingRejoin', onPending) }
  }, [canManage, g.id])

  // Keep live member/removed/pending lists in sync with the parent's group state
  // so approve/deny, remote member joins, and kicks reflect without closing the
  // modal. Editable fields (name/color/emoji/icon) stay local until Save.
  useEffect(() => {
    setG(prev => ({
      ...prev,
      members: group.members ?? prev.members,
      removedMembers: group.removedMembers ?? prev.removedMembers,
      pendingInvites: group.pendingInvites ?? prev.pendingInvites,
    }))
  }, [group.members, group.removedMembers, group.pendingInvites])

  function set (k, v) { setG(prev => ({ ...prev, [k]:v })); setSaved(false) }

  function handleImageUpload (e) {
    const file = e.target.files?.[0]
    if (!file || !file.type.startsWith('image/')) return
    const reader = new FileReader()
    reader.onload = ev => set('icon', ev.target.result)
    reader.readAsDataURL(file)
  }

  async function save () {
    if (!g.name.trim()) { setNameErr('Group name cannot be empty.'); return }
    setNameErr('')
    setSaving(true)
    await onUpdate({ ...g, name:g.name.trim() })
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }


  const section = label => (
    <div style={{ fontSize:11, letterSpacing:'0.08em', color:colors.text.muted, marginBottom:8, marginTop:4 }}>
      {label}
    </div>
  )

  return (
    <BottomSheet onClose={onClose} zIndex={200} closeRef={bsCloseRef}>
      <div style={{ padding:'12px 20px 0', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <span style={{ fontSize:17, color: colors.text.primary }}>Group Settings</span>
          <div style={{ display:'flex', gap:8, alignItems:'center' }}>
            {saved && <span style={{ fontSize:12, color:'#5DBF8A' }}>✓ Saved</span>}
            {isOwner && (
              <button onClick={save} disabled={saving}
                style={{ ...pillBtn, fontSize:13, padding:'6px 16px', opacity:saving ? 0.6 : 1,
                  display:'flex', alignItems:'center', gap:4 }}>
                {saving ? <><Spinner size={12} /> {' Saving…'}</> : 'Save'}
              </button>
            )}
            <button onClick={() => bsCloseRef.current?.()} style={{ ...iconBtn, fontSize:20 }}>✕</button>
          </div>
        </div>

        <div style={{ padding:'20px 20px 0', display:'flex', flexDirection:'column', gap:20 }}>
          {pendingApproval && (
            <div style={{ background:'#F5C47422', border:'1px solid #F5C47466', borderRadius:12,
              padding:'12px 14px', display:'flex', gap:10, alignItems:'flex-start' }}>
              <Hourglass size={20} weight="thin" color="#F5C474" style={{ flexShrink:0, marginTop:1 }} />
              <div style={{ flex:1, fontSize:13, color: colors.text.primary, lineHeight:1.45 }}>
                <div style={{ fontWeight:400, marginBottom:3 }}>Waiting for owner approval</div>
                <div style={{ color:colors.text.muted }}>
                  The group owner is reviewing your recovery-phrase match. You'll see
                  the full member list and events once they approve.
                </div>
              </div>
            </div>
          )}
          {g.brokenAt && (
            <div style={{ border:'1px solid #D45F7A66', background:'#D45F7A11', borderRadius:12, padding:'14px 16px' }}>
              <div style={{ fontSize:13, color:'#D45F7A', marginBottom:6 }}>
                ⚠ This group's data couldn't be loaded
              </div>
              <div style={{ fontSize:12, color:colors.text.muted, lineHeight:1.5, marginBottom:10 }}>
                The local copy of this group is corrupted and can't be recovered in place.
                {isOwner
                  ? ' As the owner, you\u2019ll need to recreate the group and re-invite everyone.'
                  : ' Ask the group owner to send you a fresh invite link.'}
              </div>
              {g.brokenError && (
                <div style={{ fontSize:10, color:colors.text.muted, fontFamily:'monospace',
                  marginBottom:10, opacity:0.7, overflowWrap:'anywhere' }}>
                  {g.brokenError}
                </div>
              )}
              <button onClick={() => { onRequestConfirm({ type: 'removeBrokenGroup', g }) }}
                style={{ background:'#D45F7A', border:'none', borderRadius:8, color:'#fff',
                  fontSize:13, padding:'8px 14px', cursor:'pointer', fontFamily:FONT,
                  display:'flex', alignItems:'center', gap:6 }}>
                <Trash size={14} weight="thin" /> Remove this group
              </button>
            </div>
          )}
          {/* Identity — owner only */}
          {canManage && (g.pendingInvites ?? []).length > 0 && (
            <div>
              {section('PENDING INVITES')}
              <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                {(g.pendingInvites ?? []).map(m => (
                  <div key={m.id} style={{ display:'flex', alignItems:'center', gap:12,
                    background: colors.surface.card, borderRadius:12, padding:'10px 14px' }}>
                    <MemberAvatar avatar={m.avatar} avatarHash={m.avatarHash} name={m.name} color={totalGroupsCount === 1 ? memberColorIndexed(g, m.id) : g.color} size={38} fontSize={15} />
                    <div style={{ flex:1 }}>
                      <div style={{ fontSize:14, color: colors.text.primary }}>{m.name}</div>
                      <div style={{ fontSize:11, color:colors.text.muted }}>Invite sent</div>
                    </div>
                    <button onClick={() => {
                        const link = window.__pearBuildReinviteLink?.(g, me?.id ?? 'unknown')
                        if (!link) return
                        if (sync) sync.nativeShare(`Join ${g.name} on PearCal`, link)
                        else navigator.clipboard?.writeText(link)
                      }}
                      style={{ background:'transparent', border:`1px solid ${g.color}44`, borderRadius:8,
                        color:g.color, fontSize:12, padding:'5px 10px', cursor:'pointer',
                        fontFamily:FONT }}>
                      <ShareNetwork size={14} weight="thin" style={{ display:'inline', verticalAlign:'middle' }} /> Share Again
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
          {canManage && rejoinRequests.length > 0 && (
            <div>
              {section('REJOIN REQUESTS')}
              <div style={{ fontSize:12, color:colors.text.muted, marginBottom:8, lineHeight:1.5 }}>
                Someone you previously removed has returned with a matching recovery phrase.
                Approve to restore them as a member, or deny to keep them out.
              </div>
              <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                {rejoinRequests.map(r => (
                  <div key={r.identityPublicKey} style={{ display:'flex', alignItems:'center', gap:12,
                    background: colors.surface.card, borderRadius:12, padding:'10px 14px' }}>
                    <MemberAvatar avatar={null} avatarHash={r.avatarHash} name={r.name || '?'} color={g.color} size={38} fontSize={15} />
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize:14, color: colors.text.primary }}>{r.name || 'Unknown'}</div>
                      <div style={{ fontSize:11, color:colors.text.muted, 
                        overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                        Recovery phrase matches · {r.identityPublicKey.slice(0, 12)}…
                      </div>
                    </div>
                    <button onClick={async () => {
                        await db.approveRejoin(g.id, r.identityPublicKey)
                        setRejoinRequests(prev => prev.filter(x => x.identityPublicKey !== r.identityPublicKey))
                      }}
                      style={{ background:'transparent', border:'1px solid #5DBF8A66', borderRadius:8,
                        color:'#5DBF8A', fontSize:12, padding:'5px 10px', cursor:'pointer',
                        fontFamily:FONT }}>
                      Approve
                    </button>
                    <button onClick={async () => {
                        await db.denyRejoin(g.id, r.identityPublicKey)
                        setRejoinRequests(prev => prev.filter(x => x.identityPublicKey !== r.identityPublicKey))
                      }}
                      style={{ background:'transparent', border:'1px solid #D45F7A44', borderRadius:8,
                        color:'#D45F7A', fontSize:12, padding:'5px 10px', cursor:'pointer',
                        fontFamily:FONT }}>
                      Deny
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
          {canManage && (g.removedMembers ?? []).length > 0 && (
            <div>
              {section('REMOVED MEMBERS')}
              <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                {(g.removedMembers ?? []).map(m => (
                  <div key={m.id} style={{ display:'flex', alignItems:'center', gap:12,
                    background: colors.surface.card, borderRadius:12, padding:'10px 14px' }}>
                    <MemberAvatar avatar={m.avatar} avatarHash={m.avatarHash} name={m.name} color={totalGroupsCount === 1 ? memberColorIndexed(g, m.id) : g.color} size={38} fontSize={15} />
                    <div style={{ flex:1 }}>
                      <div style={{ fontSize:14, color: colors.text.primary }}>{m.name}</div>
                      <div style={{ fontSize:11, color:colors.text.muted }}>Removed</div>
                    </div>
                    <button onClick={async () => {
                        await db.reinviteMember(g.id, m.id)
                        const memberRecord = (g.removedMembers ?? []).find(x => x.id === m.id)
                        const updated = { ...g,
                          removedMembers: (g.removedMembers ?? []).filter(x => x.id !== m.id),
                          pendingInvites: [...(g.pendingInvites ?? []), memberRecord] }
                        setG(updated)
                        const link = window.__pearBuildReinviteLink?.(g, me?.id ?? 'unknown')
                        if (!link) return
                        if (sync) sync.nativeShare(`Join ${g.name} on PearCal`, link)
                        else navigator.clipboard?.writeText(link)
                      }}
                      style={{ background:'transparent', border:`1px solid ${g.color}44`, borderRadius:8,
                        color:g.color, fontSize:12, padding:'5px 10px', cursor:'pointer',
                        fontFamily:FONT }}>
                      <ShareNetwork size={14} weight="thin" style={{ display:'inline', verticalAlign:'middle' }} /> Reinvite
                    </button>
                    <button onClick={() => { onRequestConfirm({ type: 'purgeMember', g, memberId: m.id }) }}
                      style={{ background:'transparent', border:'1px solid #D45F7A44', borderRadius:8,
                        color:'#D45F7A', fontSize:12, padding:'5px 10px', cursor:'pointer',
                        fontFamily:FONT }}>
                      <Trash size={14} weight="thin" style={{ display:'inline', verticalAlign:'middle' }} /> Delete
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
          {isOwner && <div>
            {section('GROUP IDENTITY')}
            <div style={{ display:'flex', gap:16, alignItems:'flex-start' }}>
              <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:6, flexShrink:0 }}>
                <GroupIcon group={g} size={72} radius={18} />
                <div style={{ display:'flex', gap:6 }}>
                  <button onClick={() => { activeCameraConsumer.current = b64 => { if (b64) set('icon', b64) }; window.__pearSync?.takePhoto?.() }}
                    style={{ fontSize:11, padding:'4px 8px', borderRadius:6, border:`1px solid ${colors.border}`,
                      background:'transparent', color:colors.text.primary, cursor:'pointer', fontFamily:FONT,
                      display:'flex', alignItems:'center', gap:4 }}>
                    <Image size={13} weight="thin" /> Photo
                  </button>
                  {g.icon && (
                    <button onClick={() => set('icon', null)}
                      style={{ fontSize:11, padding:'4px 8px', borderRadius:6, border:`1px solid #D45F7A`,
                        background:'transparent', color:'#D45F7A', cursor:'pointer', fontFamily:FONT }}>
                      Remove
                    </button>
                  )}
                </div>
                <input ref={fileRef} type="file" accept="image/*" style={{ display:'none' }}
                  onChange={handleImageUpload} />
              </div>
              <div style={{ flex:1, display:'flex', flexDirection:'column', gap:8 }}>
                <input style={inputStyle} placeholder="Group name" value={g.name}
                  onChange={e => { set('name', e.target.value); setNameErr('') }} />
                {nameErr && <div style={{ color:'#D45F7A', fontSize:12 }}>{nameErr}</div>}
                {!g.icon && (
                  <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
                    {GROUP_EMOJIS.map(em => (
                      <button key={em} onClick={() => set('emoji', em)}
                        style={{ width:34, height:34, borderRadius:8, fontSize:18,
                          border:`2px solid ${g.emoji === em ? g.color : colors.border}`,
                          background:g.emoji === em ? g.color + '22' : 'transparent', cursor:'pointer' }}>
                        {em}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>}

          {/* Color — owner only */}
          {isOwner && <div>
            {section('GROUP COLOR')}
            <div style={{ display:'flex', gap:10, flexWrap:'wrap' }}>
              {GROUP_COLORS.map(c => (
                <button key={c} onClick={() => set('color', c)}
                  style={{ width:34, height:34, borderRadius:'50%', background:c, cursor:'pointer',
                    border:g.color === c ? '3px solid #fff' : '3px solid transparent',
                    boxShadow:g.color === c ? `0 0 0 2px ${c}` : 'none' }} />
              ))}
            </div>
          </div>}

          {/* My Nickname — visible to all members */}
          <div>
            {section('MY NICKNAME IN THIS GROUP')}
            <div style={{ display:'flex', gap:8 }}>
              <input style={{ ...inputStyle, flex:1 }}
                placeholder={me?.name ?? 'Your name'}
                value={nickInput}
                onChange={e => { setNickInput(e.target.value); setNickSaved(false) }} />
              <button onClick={async () => {
                  const nick = nickInput.trim()
                  setG(prev => ({ ...prev, members: (prev.members ?? []).map(m => m.id === me?.id ? { ...m, nickname: nick } : m) }))
                  await onNicknameChange?.(g.id, nick)
                  setNickSaved(true)
                  setTimeout(() => setNickSaved(false), 2000)
                }}
                style={{ ...pillBtn, fontSize:13, padding:'6px 16px', flexShrink:0 }}>
                {nickSaved ? '✓' : 'Save'}
              </button>
            </div>
            <div style={{ fontSize:11, color:colors.text.muted, marginTop:4 }}>
              How you appear to others in this group
            </div>
          </div>

          {/* Members */}
          <div>
            {section(`MEMBERS · ${g.members.length}`)}
            <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
              {g.members.map(m => {
                const isMe        = m.id === me?.id
                const isMemberOwner = m.id === g.ownerId
                const isMemberAdmin = (g.admins ?? []).includes(m.id)
                const canRemove   = canManage && !isMe && !isMemberOwner
                return (
                  <div key={m.id} style={{ display:'flex', alignItems:'center', gap:12,
                    background: colors.surface.card, borderRadius:12, padding:'10px 14px' }}>
                    <MemberAvatar avatar={m.avatar} avatarHash={m.avatarHash} name={m.name} color={totalGroupsCount === 1 ? memberColorIndexed(g, m.id) : g.color} size={38} fontSize={15} />
                    <div style={{ flex:1 }}>
                      <div style={{ fontSize:14, color: colors.text.primary }}>
                        {m.nickname || m.name}
                        {isMe && <span style={{ fontSize:11, color:colors.text.muted, marginLeft:6 }}>(you)</span>}
                      </div>
                      {m.nickname && <div style={{ fontSize:11, color:colors.text.muted }}>{m.name}</div>}
                      {isMemberOwner && <div style={{ fontSize:11, color:g.color, display:'flex', alignItems:'center', gap:3 }}><Crown size={11} weight="thin" /> Owner</div>}
                      {!isMemberOwner && isMemberAdmin && <div style={{ fontSize:11, color:'#4CAF50', display:'flex', alignItems:'center', gap:3 }}><ShieldCheck size={11} weight="thin" /> Admin</div>}
                    </div>
                    <div style={{ display:'flex', flexDirection:'row', gap:6, alignItems:'center' }}>
                      {isOwner && !isMe && !isMemberOwner && (
                        <button onClick={() => { onRequestConfirm({ type: isMemberAdmin ? 'removeAdmin' : 'makeAdmin', g, memberId: m.id, memberName: m.nickname || m.name }) }}
                          style={{ background:'transparent', border:`1px solid ${isMemberAdmin ? '#D45F7A44' : '#4CAF5044'}`, borderRadius:8,
                            color:isMemberAdmin ? '#D45F7A' : '#4CAF50', fontSize:11, padding:'4px 8px', cursor:'pointer',
                            fontFamily:FONT, display:'flex', alignItems:'center', gap:4 }}>
                          <ShieldCheck size={12} weight="thin" /> {isMemberAdmin ? 'Revoke Admin' : 'Make Admin'}
                        </button>
                      )}
                      {canRemove && (
                        <button onClick={() => { onRequestConfirm({ type: 'removeMember', g, memberId: m.id }) }}
                          style={{ background:'transparent', border:`1px solid #D45F7A44`, borderRadius:8,
                            color:'#D45F7A', fontSize:11, padding:'4px 8px', cursor:'pointer',
                            fontFamily:FONT }}>
                          Remove
                        </button>
                      )}
                      {isMe && !isOwner && !isAdmin && <span style={{ fontSize:11, color:colors.text.muted }}>Member</span>}
                      {isMe && isOwner && (
                        <span style={{ fontSize:11, color:g.color, background:g.color+'22',
                          padding:'3px 8px', borderRadius:10, display:'flex', alignItems:'center', gap:3 }}>
                          <Crown size={11} weight="thin" /> Owner
                        </span>
                      )}
                      {isMe && isAdmin && (
                        <span style={{ fontSize:11, color:'#4CAF50', background:'#4CAF5022',
                          padding:'3px 8px', borderRadius:10, display:'flex', alignItems:'center', gap:3 }}>
                          <ShieldCheck size={11} weight="thin" /> Admin
                        </span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>


          {/* Ownership — visible to all members */}
          {isMember && (() => {
            const ownerMember = g.members.find(m => m.id === g.ownerId)
            const ownerName = ownerMember?.nickname || ownerMember?.name || 'Unknown'
            const lookupName = (id) => {
              const m = (g.members ?? []).find(x => x.id === id)
                     || (g.removedMembers ?? []).find(x => (x.id ?? x) === id)
              return m?.nickname || m?.name || (typeof id === 'string' ? id.slice(0, 8) + '…' : 'Someone')
            }
            const nonOwnerMembers = (g.members ?? []).filter(m => m.id !== g.ownerId)
            const log = g.promotionLog ?? []
            return (
              <div>
                {section('OWNERSHIP')}
                <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
                  <div style={{ background: colors.surface.card, borderRadius:12, padding:'12px 14px',
                    display:'flex', alignItems:'center', gap:10 }}>
                    <Crown size={18} weight="thin" style={{ color: g.color, flexShrink:0 }} />
                    <div style={{ flex:1, minWidth:0 }}>
                      {isOwner ? (
                        <>
                          <div style={{ fontSize:14, color: colors.text.primary }}>You are the owner</div>
                          <div style={{ fontSize:11, color:colors.text.muted, marginTop:2 }}>
                            Only you can remove members and approve rejoin requests
                          </div>
                        </>
                      ) : (
                        <>
                          <div style={{ fontSize:14, color: colors.text.primary }}>{ownerName}</div>
                          <div style={{ fontSize:11, color:colors.text.muted, marginTop:2 }}>
                            Active {formatRelativeTime(lastOwnerActivityTs) || 'recently'}
                          </div>
                        </>
                      )}
                    </div>
                  </div>

                  {isOwner && nonOwnerMembers.length > 0 && !transferPicker && (
                    <button onClick={() => { setTransferPicker(true) }}
                      style={{ background:'transparent', border:`1px solid ${colors.border}`, borderRadius:10,
                        color:colors.text.primary, fontSize:13, padding:'10px 14px', cursor:'pointer',
                        fontFamily:FONT, textAlign:'left',
                        display:'flex', alignItems:'center', gap:8 }}>
                      <Crown size={14} weight="thin" /> Transfer ownership to…
                    </button>
                  )}

                  {isOwner && transferPicker && (
                    <div style={{ border:`1px solid ${colors.border}`, borderRadius:12, overflow:'hidden' }}>
                      <div style={{ padding:'10px 14px', fontSize:12, color:colors.text.muted, 
                        borderBottom:`1px solid ${colors.border}` }}>
                        Pick a member to promote. They'll gain owner privileges; you'll lose them.
                      </div>
                      <div style={{ display:'flex', flexDirection:'column' }}>
                        {nonOwnerMembers.map(m => (
                          <button key={m.id} onClick={() => {
                              setTransferPicker(false)
                              bsCloseRef.current?.()
                              onRequestConfirm({ type: 'transferOwnership', g, targetId: m.id, targetName: m.nickname || m.name })
                            }}
                            style={{ display:'flex', alignItems:'center', gap:12, padding:'10px 14px',
                              background:'transparent', border:'none', borderBottom:`1px solid ${colors.border}`,
                              cursor:'pointer', fontFamily:FONT, textAlign:'left' }}>
                            <MemberAvatar avatar={m.avatar} avatarHash={m.avatarHash} name={m.name} color={totalGroupsCount === 1 ? memberColorIndexed(g, m.id) : g.color} size={32} fontSize={13} />
                            <div style={{ flex:1 }}>
                              <div style={{ fontSize:14, color: colors.text.primary }}>{m.nickname || m.name}</div>
                              {m.nickname && <div style={{ fontSize:11, color:colors.text.muted }}>{m.name}</div>}
                            </div>
                          </button>
                        ))}
                      </div>
                      <button onClick={() => setTransferPicker(false)}
                        style={{ width:'100%', padding:'10px 14px', background:'transparent', border:'none',
                          color:colors.text.muted, fontSize:12, cursor:'pointer', fontFamily:FONT, textAlign:'center' }}>
                        Cancel
                      </button>
                    </div>
                  )}

                  {canClaimOwnership && (
                    <div style={{ border:'1px solid #F5C47466', background:'#F5C47411', borderRadius:12, padding:'12px 14px' }}>
                      <div style={{ fontSize:13, color:colors.text.primary, marginBottom:6, lineHeight:1.45 }}>
                        The owner has been inactive for {ownerInactiveDays} day{ownerInactiveDays === 1 ? '' : 's'}.
                        If you can't reach them, you can claim ownership of this group.
                      </div>
                      <button onClick={() => { onRequestConfirm({ type: 'claimOwnership', g }) }}
                        style={{ background:'transparent', border:'1px solid #E5864A66', borderRadius:8,
                          color:'#E5864A', fontSize:13, padding:'6px 12px', cursor:'pointer',
                          fontFamily:FONT, display:'flex', alignItems:'center', gap:6 }}>
                        <Crown size={14} weight="thin" /> Claim ownership
                      </button>
                    </div>
                  )}

                  {log.length > 0 && (() => {
                    const HISTORY_PREVIEW = 5
                    const reversed = [...log].reverse()
                    const hiddenCount = Math.max(0, reversed.length - HISTORY_PREVIEW)
                    const visible = showAllHistory ? reversed : reversed.slice(0, HISTORY_PREVIEW)
                    return (
                      <div>
                        <div style={{ fontSize:11, color:colors.text.muted, marginTop:4, marginBottom:6,
                          letterSpacing:'0.04em' }}>
                          HISTORY
                        </div>
                        <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
                          {visible.map((e, i) => {
                            const when = new Date(e.ts)
                            const whenStr = when.toLocaleDateString() + ' ' +
                              when.toLocaleTimeString([], { hour:'numeric', minute:'2-digit' })
                            const byName = lookupName(e.by)
                            const toName = lookupName(e.to)
                            const selfPromoted = e.by === e.to
                            return (
                              <div key={i} style={{ fontSize:12, color:colors.text.muted, lineHeight:1.5 }}>
                                {selfPromoted
                                  ? `${toName} claimed ownership`
                                  : `${byName} transferred to ${toName}`}
                                <span style={{ marginLeft:8, opacity:0.7 }}>{whenStr}</span>
                              </div>
                            )
                          })}
                          {hiddenCount > 0 && (
                            <button onClick={() => setShowAllHistory(v => !v)}
                              style={{ background:'transparent', border:'none', color:colors.text.muted,
                                fontSize:11, fontFamily:FONT, cursor:'pointer',
                                textAlign:'left', padding:'2px 0', marginTop:2 }}>
                              {showAllHistory
                                ? 'Show less'
                                : `Show ${hiddenCount} older`}
                            </button>
                          )}
                        </div>
                      </div>
                    )
                  })()}
                </div>
              </div>
            )
          })()}


          {/* Danger zone */}
          <div>
            {isOwner && (
              <>
                {section('STORAGE')}
                <div style={{ border:`1px solid ${colors.border}`, borderRadius:12, overflow:'hidden', marginBottom:12 }}>
                  <button onClick={() => { onRequestConfirm({ type: 'rekeyGroup', g }) }}
                    style={{ width:'100%', padding:'14px 16px', background:'transparent', border:'none',
                      fontFamily:FONT, color:colors.text.primary, fontSize:14, cursor:'pointer',
                      textAlign:'left', display:'flex', justifyContent:'space-between', alignItems:'center', gap:10 }}>
                    <span>Rekey Group</span>
                    <span style={{ fontSize:11, color:colors.text.muted, textAlign:'right' }}>
                      Reclaim shared history storage
                    </span>
                  </button>
                </div>
              </>
            )}
            {section('DANGER ZONE')}
            <div style={{ border:`1px solid #D45F7A44`, borderRadius:12, overflow:'hidden' }}>
              {!isOwner && (
                <button onClick={() => { onRequestConfirm({ type: 'leaveGroup', g }) }}
                  style={{ width:'100%', padding:'14px 16px', background:'transparent', border:'none',
                    fontFamily:FONT, color:'#D45F7A', fontSize:14, cursor:'pointer',
                    textAlign:'left', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                  <span style={{ display:'flex', alignItems:'center', gap:6 }}><SignOut size={16} weight="thin" /> Leave Group</span>
                  <span style={{ fontSize:12, color:colors.text.muted }}>You'll lose access to shared events</span>
                </button>
              )}
              {isOwner && (
                <button onClick={() => { onRequestConfirm({ type: 'deleteGroup', g }) }}
                  style={{ width:'100%', padding:'14px 16px', background:'#D45F7A11', border:'none',
                    fontFamily:FONT, color:'#D45F7A', fontSize:14, cursor:'pointer',
                    textAlign:'left', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                  <span style={{ display:'flex', alignItems:'center', gap:6 }}><Trash size={16} weight="thin" /> Delete Group</span>
                  <span style={{ fontSize:12, color:'#D45F7A99' }}>Permanent — cannot be undone</span>
                </button>
              )}
            </div>
          </div>
        </div>

    </BottomSheet>
  )
}

// ─── New Group Modal ──────────────────────────────────────────────────────────
function NewGroupModal ({ onClose, onAdd, onUpdate, me, sync, onCreated, closeRef }) {
  const bsCloseRef = useRef(null)
  const [name,           setName]           = useState('')
  const [color,          setColor]          = useState(GROUP_COLORS[0])
  const [emoji,          setEmoji]          = useState(GROUP_EMOJIS[0])
  const [icon,           setIcon]           = useState(null)
  const [nameErr,        setNameErr]        = useState('')
  const [creating,       setCreating]       = useState(false)
  const fileRef = useRef()

  useEffect(() => {
    if (closeRef) closeRef.current = () => { bsCloseRef.current?.(); return true }
  }, [])

  function handleImageUpload (e) {
    const file = e.target.files?.[0]
    if (!file || !file.type.startsWith('image/')) return
    const reader = new FileReader()
    reader.onload = ev => setIcon(ev.target.result)
    reader.readAsDataURL(file)
  }

  async function handleCreate () {
    if (!name.trim()) { setNameErr('Group name required'); return }
    setCreating(true)
    try {
      // Bare-side createGroup opens the Autobase, captures the real base.key
      // as groupKey, persists the group record, then joins the swarm. Returns
      // the materialised group record we can hand to the UI state.
      const newG = await sync.createGroup(name.trim(), { color, emoji, icon })
      if (!newG) throw new Error('createGroup returned null')
      await onAdd(newG, { alreadyJoined: true })
      onCreated(newG)
      bsCloseRef.current?.()
    } catch (e) {
      console.error('[createGroup]', e?.message || e)
    } finally {
      setCreating(false)
    }
  }


  return (
    <BottomSheet onClose={onClose} zIndex={200} closeRef={bsCloseRef}>
      <div style={{ padding:'12px 20px 0', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
        <span style={{ fontSize:17, color: colors.text.primary }}>Create a Group</span>
        <button onClick={() => bsCloseRef.current?.()} style={{ ...iconBtn, fontSize:20 }}>✕</button>
      </div>
      <div style={{ padding:'0 20px 8px', display:'flex', flexDirection:'column', gap:14 }}>
        {/* Name input */}
        <div>
          <input
            placeholder="Group name"
            value={name}
            onChange={e => { setName(e.target.value); setNameErr('') }}
            style={inputStyle}
          />
          {nameErr && <div style={{ color:'var(--color-destructive)', fontSize:13, marginTop:4 }}>{nameErr}</div>}
        </div>

        {/* Group Avatar */}
        <div>
          <div style={{ fontSize:13, color:'var(--color-muted)', marginBottom:8 }}>Group Avatar</div>
          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
            {icon ? (
              <div style={{ position:'relative', width:52, height:52, borderRadius:12, overflow:'hidden', flexShrink:0 }}>
                <img src={icon} alt="" style={{ width:'100%', height:'100%', objectFit:'cover' }} />
                <button onClick={() => setIcon(null)}
                  style={{ position:'absolute', top:0, right:0, background:'rgba(0,0,0,0.55)',
                    border:'none', color:'#fff', width:18, height:18, borderRadius:0, cursor:'pointer',
                    display:'flex', alignItems:'center', justifyContent:'center', padding:0 }}>
                  <X size={10} weight="bold" />
                </button>
              </div>
            ) : (
              <div style={{ width:52, height:52, borderRadius:12, border:`1px dashed var(--color-border)`,
                background:'var(--color-surface)', display:'flex', alignItems:'center', justifyContent:'center',
                color:'var(--color-muted)', fontSize:22, flexShrink:0 }}>
                <Users size={24} weight="thin" />
              </div>
            )}
            <input ref={fileRef} type="file" accept="image/*" style={{ display:'none' }} onChange={handleImageUpload} />
            <div style={{ display:'flex', gap:8 }}>
              <button onClick={() => { activeCameraConsumer.current = b64 => { if (b64) setIcon(b64) }; window.__pearSync?.takePhoto?.() }}
                style={{ fontSize:12, padding:'6px 14px', borderRadius:8, border:`1px solid var(--color-border)`,
                  background:'transparent', color:'var(--color-text)', cursor:'pointer', fontFamily:FONT,
                  display:'flex', alignItems:'center', gap:5 }}>
                <Image size={14} weight="thin" /> Photo
              </button>
            </div>
          </div>
        </div>

        {/* Color picker */}
        <div>
          <div style={{ fontSize:13, color:'var(--color-muted)', marginBottom:6 }}>Color</div>
          <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
            {GROUP_COLORS.map(c => (
              <button key={c} onClick={() => setColor(c)}
                style={{ width:28, height:28, borderRadius:'50%', background:c, border:`2px solid ${color === c ? 'var(--color-text)' : 'transparent'}`,
                  cursor:'pointer', transition:'border-color var(--duration-fast) var(--easing)' }} />
            ))}
          </div>
        </div>

        {/* Create button */}
        <button onClick={handleCreate} disabled={creating}
          style={{ ...pillBtn, padding:'13px', fontSize:15, opacity: creating ? 0.6 : 1 }}>
          {creating ? 'Creating…' : 'Create Group'}
        </button>
      </div>
    </BottomSheet>
  )
}

// ─── Profile Tab ──────────────────────────────────────────────────────────────
function SkeletonCard ({ height = 64, radius = 12 }) {
  return (
    <div style={{ width:'100%', height, borderRadius:radius, background:colors.border,
      animation:'pearSkeletonPulse 1.4s ease-in-out infinite' }} />
  )
}

function SkeletonList ({ count = 3, height = 64 }) {
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:10, padding:'8px 0' }}>
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonCard key={i} height={height} />
      ))}
    </div>
  )
}

// ─── Group Created Toast ───────────────────────────────────────────────────
function GroupCreatedToast ({ group, db, sync, readyGroupKeys, onDismiss }) {
  const [leaving, setLeaving] = useState(false)

  useEffect(() => {
    const id = setTimeout(() => setLeaving(true), 5000)
    return () => clearTimeout(id)
  }, [])

  useEffect(() => {
    if (leaving) setTimeout(() => onDismiss(), 150)
  }, [leaving])

  async function handleShare () {
    // #164 - worklet-minted, from the authoritative record. Nothing is shared
    // if it refuses, rather than handing out a link that cannot work.
    const link = await db?.buildInvite(group.id).catch(() => null)
    setLeaving(true)
    setTimeout(() => onDismiss(), 150)
    if (link) sync?.nativeShare('Join ' + group.name + ' on PearCal', link)
  }

  const ready = readyGroupKeys.has(group.id)

  return (
    <div style={{
      position: 'fixed',
      bottom: 'calc(53px + var(--safe-area-bottom) + 16px)',
      left: '50%', transform: 'translateX(-50%)',
      width: 'calc(100% - 32px)', maxWidth: 398,
      zIndex: 400,
    }}>
      <div style={{
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-lg)',
        padding: '12px 16px',
        display: 'flex', alignItems: 'center', gap: 10,
        animation: leaving
          ? 'pearFadeOut 150ms var(--easing) both'
          : 'pearFadeUp 200ms var(--easing) both',
      }}>
        <GroupIcon group={group} size={28} radius={8} />
        <span style={{ flex:1, color:'var(--color-text)', fontSize:14 }}>
          "{group.name}" created
        </span>
        <button
          disabled={!ready}
          style={{ ...pillBtn, fontSize:13, padding:'6px 14px', 
            opacity: ready ? 1 : 0.5 }}
          onClick={handleShare}
        >
          Share →
        </button>
      </div>
    </div>
  )
}

// ─── Scope Sheet (recurring edit) ─────────────────────────────────────────────
function ScopeSheet ({ ev, onSave, onDismiss, closeRef }) {
  const bsCloseRef = useRef(null)
  useEffect(() => {
    if (closeRef) {
      closeRef.current = () => { bsCloseRef.current?.(); return true }
      return () => { closeRef.current = null }
    }
  }, [])
  return (
    <BottomSheet onClose={onDismiss} zIndex={250} closeRef={bsCloseRef}>
      <div style={{ padding:'24px 20px 8px', display:'flex', flexDirection:'column', alignItems:'center', gap:10, textAlign:'center' }}>
        <div style={{ marginBottom:4 }}><ArrowsClockwise size={28} weight="thin" color="var(--color-accent)" /></div>
        <div style={{ fontSize:17, color: colors.text.primary }}>Edit recurring event</div>
        <div style={{ fontSize:14, color:'var(--color-muted)', lineHeight:1.5 }}>
          Apply changes to just this event, this and future events, or every event in the series?
        </div>
        <Button onClick={() => { bsCloseRef.current?.(); setTimeout(() => onSave(ev, 'one'), 280) }}>This Event</Button>
        <Button onClick={() => { bsCloseRef.current?.(); setTimeout(() => onSave(ev, 'future'), 280) }}>This & Future</Button>
        <Button onClick={() => { bsCloseRef.current?.(); setTimeout(() => onSave(ev, 'all'), 280) }}>Entire Series</Button>
        <Button variant="secondary" onClick={() => bsCloseRef.current?.()} style={{ marginBottom:8 }}>
          Cancel
        </Button>
      </div>
    </BottomSheet>
  )
}

// ─── Delete Scope Sheet (recurring delete) ────────────────────────────────────
function DeleteScopeSheet ({ onChoose, onDismiss, closeRef }) {
  const bsCloseRef = useRef(null)
  useEffect(() => {
    if (closeRef) {
      closeRef.current = () => { bsCloseRef.current?.(); return true }
      return () => { closeRef.current = null }
    }
  }, [])
  return (
    <BottomSheet onClose={onDismiss} zIndex={250} closeRef={bsCloseRef}>
      <div style={{ padding:'24px 20px 8px', display:'flex', flexDirection:'column', alignItems:'center', gap:12, textAlign:'center' }}>
        <div style={{ marginBottom:4 }}><Trash size={28} weight="thin" color="var(--color-destructive)" /></div>
        <div style={{ fontSize:17, color: colors.text.primary }}>Delete recurring event</div>
        <div style={{ fontSize:14, color:'var(--color-muted)', lineHeight:1.5 }}>
          Delete just this event, or the entire series?
        </div>
        <div style={{ display:'flex', gap:10, width:'100%', marginTop:8 }}>
          <button onClick={() => { bsCloseRef.current?.(); setTimeout(() => onChoose('one'), 280) }}
            style={{ flex:1, padding:'12px', borderRadius:12, border:'none', fontFamily:FONT,
              background:'var(--color-destructive)', color:'#fff', fontSize:14, cursor:'pointer' }}>
            This Event
          </button>
          <button onClick={() => { bsCloseRef.current?.(); setTimeout(() => onChoose('all'), 280) }}
            style={{ flex:1, padding:'12px', borderRadius:12, border:'none', fontFamily:FONT,
              background:'var(--color-destructive)', color:'#fff', fontSize:14, cursor:'pointer' }}>
            Entire Series
          </button>
        </div>
        <button onClick={() => bsCloseRef.current?.()}
          style={{ width:'100%', padding:'12px', borderRadius:12, border:`1px solid var(--color-border)`,
            fontFamily:FONT, background:'transparent', color:'var(--color-text)',
            fontSize:14, cursor:'pointer', marginBottom:8 }}>
          Cancel
        </button>
      </div>
    </BottomSheet>
  )
}

// ─── Confirm Sheet ────────────────────────────────────────────────────────────
function ConfirmSheet ({ title, message, icon, confirmLabel, dangerous, onConfirm, onDismiss, closeRef }) {
  const bsCloseRef = useRef(null)

  useEffect(() => {
    if (closeRef) {
      closeRef.current = () => { bsCloseRef.current?.(); return true }
      return () => { closeRef.current = null }
    }
  }, [])

  return (
    <BottomSheet onClose={onDismiss} zIndex={250} closeRef={bsCloseRef}>
      <div style={{ padding:'24px 20px 8px', display:'flex', flexDirection:'column', alignItems:'center', gap:12, textAlign:'center' }}>
        <div style={{ marginBottom:4 }}>{icon}</div>
        <div style={{ fontSize:17, color: colors.text.primary }}>{title}</div>
        <div style={{ fontSize:14, color:'var(--color-muted)', lineHeight:1.5 }}>{message}</div>
        <div style={{ display:'flex', gap:10, width:'100%', marginTop:8 }}>
          {/* Equal width: the confirm and Cancel carry the same weight, so neither
              reads as the obvious choice by size alone. */}
          <Button variant="secondary" onClick={() => bsCloseRef.current?.()} style={{ flex:1 }}>
            Cancel
          </Button>
          <Button variant={dangerous ? 'danger' : 'primary'}
            onClick={() => { bsCloseRef.current?.(); setTimeout(onConfirm, 280) }} style={{ flex:1 }}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </BottomSheet>
  )
}

function InfoSheet ({ title, message, icon, onDismiss, closeRef }) {
  const bsCloseRef = useRef(null)

  useEffect(() => {
    if (closeRef) {
      closeRef.current = () => { bsCloseRef.current?.(); return true }
      return () => { closeRef.current = null }
    }
  }, [])

  return (
    <BottomSheet onClose={onDismiss} zIndex={250} closeRef={bsCloseRef}>
      <div style={{ padding:'24px 20px 8px', display:'flex', flexDirection:'column', alignItems:'center', gap:12, textAlign:'center' }}>
        {icon && <div style={{ marginBottom:4 }}>{icon}</div>}
        <div style={{ fontSize:17, color: colors.text.primary }}>{title}</div>
        <div style={{ fontSize:14, color:'var(--color-muted)', lineHeight:1.5 }}>{message}</div>
        <Button onClick={() => bsCloseRef.current?.()} style={{ marginTop:8 }}>
          OK
        </Button>
      </div>
    </BottomSheet>
  )
}

function BottomSheet ({ onClose, children, zIndex = 200, closeRef }) {
  const [visible, setVisible] = useState(false)
  const [closing, setClosing] = useState(false)
  const touchStartY = useRef(null)
  const DURATION = 280

  // Back dismisses the sheet with its slide-out, rather than snapping it away.
  // close() already guards re-entry while closing, so a double-Back is a no-op.
  useBackHandler(true, close)

  useEffect(() => {
    const id = setTimeout(() => setVisible(true), 20)
    return () => clearTimeout(id)
  }, [])
  useEffect(() => { if (closeRef) closeRef.current = close }, [closing])

  function close () {
    if (closing) return
    setClosing(true)
    setTimeout(() => onClose(), DURATION)
  }

  function onHandleTouchStart (e) {
    touchStartY.current = e.touches[0].clientY
  }
  function onHandleTouchMove (e) {
    if (touchStartY.current === null) return
    const dy = e.touches[0].clientY - touchStartY.current
    if (dy > 60) { touchStartY.current = null; close() }
  }

  const translateY = (!visible || closing) ? '100%' : '0%'

  // Portal to <body>: a transformed ancestor becomes the containing block for a
  // position:fixed child, which would clip the scrim and land the sheet short of
  // the screen edge. Nested sheets (a confirm inside group settings) hit this.
  return createPortal(
    <div style={{ position:'fixed', inset:0, zIndex, display:'flex', alignItems:'flex-end',
      justifyContent:'center', background: visible && !closing ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0)',
      transition:`background ${DURATION}ms ease` }}
      onClick={close}>
      <div onClick={e => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 430,
          background: 'var(--color-bg)',
          borderRadius: 'var(--radius-sheet) var(--radius-sheet) 0 0',
          maxHeight: '80dvh', overflowY: 'auto', overflowX: 'hidden',
          paddingBottom: 'calc(32px + 53px + var(--safe-area-bottom))',
          transform: `translateY(${translateY})`,
          transition: `transform ${DURATION}ms cubic-bezier(0.32,0.72,0,1)`,
          WebkitOverflowScrolling: 'touch',
        }}>
        <div onTouchStart={onHandleTouchStart} onTouchMove={onHandleTouchMove}
          style={{ display:'flex', justifyContent:'center', padding:'16px 0 8px', cursor:'pointer' }}
          onClick={close}>
          <div style={{
            width: 32, height: 3, borderRadius: 2,
            background: 'var(--color-border)',
            margin: '12px auto 4px',
            flexShrink: 0,
          }} />
        </div>
        {children}
      </div>
    </div>,
    document.body
  )
}

function ImportIcsSheet ({ events, filename, groups, existingEventIds, onImport, onClose }) {
  const bsClose = useRef(null)
  const memberIds = new Set((groups ?? []).map(g => g.id))
  // Compute routing per event
  const routed = events.map(ev => {
    const uid = ev.uid ? ev.uid.replace(/@pearcal$/, '') : null
    const skipped = uid && existingEventIds?.has(uid)
    const keptGroups = Array.isArray(ev.groups) ? ev.groups.filter(gid => memberIds.has(gid)) : []
    return { ev, uid, skipped, keptGroups }
  })
  const toImport = routed.filter(r => !r.skipped)
  const skippedCount = routed.length - toImport.length
  // Summary: per-group counts + personal
  const perGroupCount = new Map()
  let personalCount = 0
  for (const r of toImport) {
    if (r.keptGroups.length === 0) personalCount++
    else for (const gid of r.keptGroups) perGroupCount.set(gid, (perGroupCount.get(gid) ?? 0) + 1)
  }
  const summaryRows = []
  if (personalCount > 0) summaryRows.push({ label: 'Personal', count: personalCount, color: null })
  for (const [gid, count] of perGroupCount) {
    const g = (groups ?? []).find(x => x.id === gid)
    summaryRows.push({ label: g?.name ?? 'Unknown group', count, color: g?.color })
  }
  return (
    <BottomSheet onClose={onClose} zIndex={250} closeRef={bsClose}>
      <div style={{ padding:'0 20px 16px' }}>
        <div style={{ fontSize:17, fontWeight:400, color: colors.text.primary, marginBottom:4 }}>
          Import {toImport.length} Event{toImport.length !== 1 ? 's' : ''}
        </div>
        <div style={{ fontSize:13, color:colors.text.muted, marginBottom:16,
          overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
          {filename}
        </div>
        {summaryRows.length > 0 && (
          <div style={{ display:'flex', flexDirection:'column', gap:6, marginBottom:12 }}>
            {summaryRows.map((row, i) => (
              <div key={i} style={{ display:'flex', alignItems:'center', gap:8,
                padding:'8px 12px', borderRadius:8, border:`1px solid ${colors.border}` }}>
                <div style={{ width:8, height:8, borderRadius:4,
                  background: row.color ?? colors.text.muted }} />
                <div style={{ flex:1, fontSize:13, color: colors.text.primary }}>{row.label}</div>
                <div style={{ fontSize:13, color:colors.text.muted }}>{row.count}</div>
              </div>
            ))}
          </div>
        )}
        {skippedCount > 0 && (
          <div style={{ fontSize:12, color:colors.text.muted, marginBottom:12 }}>
            {skippedCount} event{skippedCount !== 1 ? 's' : ''} already exist — will be skipped
          </div>
        )}
        <div style={{ maxHeight:220, overflowY:'auto', display:'flex', flexDirection:'column',
          gap:8, marginBottom:16 }}>
          {routed.map((r, i) => (
            <div key={i} style={{ padding:'10px 12px', borderRadius:10,
              border:`1px solid ${colors.border}`, display:'flex', flexDirection:'column', gap:3,
              opacity: r.skipped ? 0.5 : 1 }}>
              <div style={{ fontSize:14, fontWeight:400, color: colors.text.primary }}>
                {r.ev.title}{r.skipped ? ' · (skipped)' : ''}
              </div>
              <div style={{ fontSize:12, color:colors.text.muted }}>
                {r.ev.date}
                {r.ev.allDay
                  ? (r.ev.endDate ? ` – ${r.ev.endDate} · All day` : ' · All day')
                  : (r.ev.start ? ` · ${r.ev.start}${r.ev.end ? '–'+r.ev.end : ''}` : '')}
              </div>
            </div>
          ))}
        </div>
        <button onClick={() => onImport(toImport)}
          disabled={toImport.length === 0}
          style={{ ...pillBtn, width:'100%', padding:13, fontSize:15, 
            opacity: toImport.length === 0 ? 0.4 : 1 }}>
          Import {toImport.length} Event{toImport.length !== 1 ? 's' : ''}
        </button>
      </div>
    </BottomSheet>
  )
}

function AboutTab ({ sync, closeSheetRef, onReplayTour }) {
  const lsBsCloseRef = useRef(null)
  const [lightningModal, setLightningModal] = useState(false)
  const [lnDetected, setLnDetected] = useState(false)
  useEffect(() => {
    if (closeSheetRef) closeSheetRef.current = () => {
      if (lightningModal) { setLightningModal(false); return true }
      return false
    }
    return () => { if (closeSheetRef) closeSheetRef.current = null }
  }, [lightningModal])

  // BTC is a chooser: tapping it always opens the sheet. We probe for an
  // installed Lightning wallet first so the sheet can show the hero handoff
  // button when one is present, then fall back to the alternatives.
  async function handleDonate () {
    if (!sync) return
    sync.canOpenLightning()
    const detected = await new Promise(resolve => {
      const handler = (e) => {
        window.removeEventListener('pear:canOpenLightning', handler)
        resolve(e.detail)
      }
      window.addEventListener('pear:canOpenLightning', handler)
      setTimeout(() => { window.removeEventListener('pear:canOpenLightning', handler); resolve(false) }, 3000)
    })
    setLnDetected(!!detected)
    setLightningModal(true)
  }

  // Accordion: one section open at a time, all closed to start — the About tab is
  // a reference surface, so it should open as a short scannable index rather than
  // six screens of prose.
  const [openSection, setOpenSection] = useState(null)
  const toggleSection = (id) => setOpenSection(s => (s === id ? null : id))

  const donateBody = { fontSize:13, color:colors.text.muted, lineHeight:'1.7' }
  const donateSecLabel = { fontSize:11, fontWeight:400, color:colors.text.muted, letterSpacing:'0.04em', margin:'20px 0 8px', textAlign:'center' }
  const donatePrimaryBtn = {
    ...pillBtn, width:'100%', padding:'14px 16px',
    minHeight:DONATE_OPTION_MIN_H, boxSizing:'border-box',
    fontSize:15, fontWeight:400,
    display:'flex', alignItems:'center', justifyContent:'center', gap:8,
  }

  return (
    <div style={{ padding:'16px 20px 0', overflowY:'auto', flex:1,
      paddingBottom:'calc(16px + env(safe-area-inset-bottom))', WebkitOverflowScrolling: 'touch' }}>
      {/* App info */}
      <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:4, marginBottom:16 }}>
        <PearIcon size={44} />
        <div style={{ fontSize:18, fontWeight:400, color: colors.text.primary }}>PearCal</div>
        <div style={{ fontSize:12, color:colors.text.muted }}>Decentralized. Private. No servers.</div>
      </div>

      <Collapsible title="How it works" icon={Info}
        open={openSection === 'how'} onToggle={() => toggleSection('how')}>
        <div style={{ fontSize:12, color:colors.text.muted, lineHeight:'1.6', marginBottom:10 }}>
          PearCal syncs directly between devices using peer-to-peer technology powered by Hypercore Protocol.
          Your calendar data never touches a server — it lives only on the devices in your groups.
          No accounts. No subscriptions. No data collection.
        </div>
        <button onClick={() => sync?.openURL('https://pears.com/')}
          style={{ ...pillBtn, width:'100%', padding:'10px', fontSize:14,
            display:'flex', alignItems:'center', justifyContent:'center', gap:8 }}>
          Learn about P2P <ArrowSquareOut size={14} weight="thin" />
        </button>
      </Collapsible>

      {onReplayTour && (
        <Collapsible title="Replay welcome tour" icon={ArrowsClockwise}
          open={openSection === 'tour'} onToggle={() => toggleSection('tour')}>
          <div style={{ fontSize:12, color:colors.text.muted, lineHeight:'1.6', marginBottom:10 }}>
            Walk through the calendar's main controls again — create flow, groups, profile, settings.
          </div>
          <button onClick={onReplayTour}
            style={{ ...pillBtn, width:'100%', padding:'10px', fontSize:14 }}>
            Replay welcome tour
          </button>
        </Collapsible>
      )}

      <Collapsible title="Support development" icon={Lightning}
        open={openSection === 'support'} onToggle={() => toggleSection('support')}>
        <div style={{ fontSize:12, color:colors.text.muted, lineHeight:'1.6', marginBottom:10 }}>
          PearCal is free and open source. If you receive value from it, please consider returning value.
        </div>
        <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
          <button onClick={handleDonate}
            style={{ ...pillBtn, flex:1, minWidth:120, padding:'10px 8px', fontSize:13,
              display:'flex', alignItems:'center', justifyContent:'center', gap:6 }}>
            <Lightning size={14} weight="thin" /> Donate BTC <Lightning size={14} weight="thin" />
          </button>
          <button onClick={() => sync?.openURL('https://buymeacoffee.com/peerloomllc')}
            style={{ ...pillBtn, flex:1, minWidth:120, padding:'10px 8px', fontSize:13,
              display:'flex', alignItems:'center', justifyContent:'center', gap:6 }}>
            <CurrencyDollar size={14} weight="thin" /> Donate USD <CurrencyDollar size={14} weight="thin" />
          </button>
        </div>
      </Collapsible>

      <Collapsible title="Learn about Bitcoin" icon={BookOpen}
        open={openSection === 'bitcoin'} onToggle={() => toggleSection('bitcoin')}>
        <div style={{ fontSize:12, color:colors.text.muted, lineHeight:'1.6', marginBottom:10 }}>
          New to Bitcoin? The Satoshi Nakamoto Institute has a free, concise crash course explaining how Bitcoin works and why it matters.
        </div>
        <button onClick={() => sync?.openURL('https://nakamotoinstitute.org/crash-course/')}
          style={{ ...pillBtn, width:'100%', padding:'10px', fontSize:14,
            display:'flex', alignItems:'center', justifyContent:'center', gap:8 }}>
          <BookOpen size={16} weight="thin" /> Bitcoin Crash Course <ArrowSquareOut size={14} weight="thin" />
        </button>
      </Collapsible>

      <Collapsible title="Share the app" icon={ShareNetwork}
        open={openSection === 'share'} onToggle={() => toggleSection('share')}>
        <div style={{ fontSize:12, color:colors.text.muted, lineHeight:'1.6', marginBottom:10 }}>
          Know someone who'd enjoy a private, serverless calendar? Share PearCal with them.
        </div>
        <button onClick={() => sync?.nativeShare('PearCal', 'Check out PearCal — a private, peer-to-peer calendar app with no servers or accounts.\n\nhttps://peerloomllc.com/pearcal/')}
          style={{ ...pillBtn, width:'100%', padding:'10px', fontSize:14,
            display:'flex', alignItems:'center', justifyContent:'center', gap:8 }}>
          <ShareNetwork size={16} weight="thin" /> Share PearCal
        </button>
      </Collapsible>

      <Collapsible title="Contact" icon={EnvelopeSimple}
        open={openSection === 'contact'} onToggle={() => toggleSection('contact')}>
        <div style={{ display:'flex', gap:8 }}>
          <button onClick={() => sync?.openURL('mailto:peerloomllc@proton.me?subject=%5BPearCal%5D%20Feedback')}
            style={{ ...pillBtn, flex:1, padding:'10px 8px', fontSize:13,
              display:'flex', alignItems:'center', justifyContent:'center', gap:6 }}>
            <EnvelopeSimple size={14} weight="thin" /> Send Email <ArrowSquareOut size={13} weight="thin" />
          </button>
          <button onClick={() => sync?.openURL('https://github.com/peerloomllc/pearcal-native/issues')}
            style={{ ...pillBtn, flex:1, padding:'10px 8px', fontSize:13,
              display:'flex', alignItems:'center', justifyContent:'center', gap:6 }}>
            <Bug size={14} weight="thin" /> Report Issue <ArrowSquareOut size={13} weight="thin" />
          </button>
        </div>
      </Collapsible>

      {/* Lightning / on-chain donation chooser */}
      {lightningModal && (
        <BottomSheet onClose={() => setLightningModal(false)} zIndex={300} closeRef={lsBsCloseRef}>
          <div style={{ padding:'0 20px 20px' }}>
            <div style={{ fontSize:18, fontWeight:400, color: colors.text.primary, marginBottom:8, textAlign:'center', display:'flex', alignItems:'center', justifyContent:'center', gap:8 }}>
              <Lightning size={18} weight="thin" /> Bitcoin Lightning <Lightning size={18} weight="thin" />
            </div>
            <div style={{ ...donateBody, marginBottom:16, textAlign:'center' }}>
              Support PearCal with Bitcoin over Lightning (fast and low-fee){BTC_ONCHAIN_ADDRESS ? ' or on-chain' : ''}.
            </div>

            {lnDetected && (
              <>
                <button onClick={() => { sync?.openLightning(LIGHTNING_ADDRESS); lsBsCloseRef.current?.() }} style={donatePrimaryBtn}>
                  <Lightning size={16} weight="fill" /> Open in your Lightning wallet <Lightning size={16} weight="fill" />
                </button>
                <div style={{ ...donateBody, textAlign:'center', margin:'16px 0 0' }}>or use another method:</div>
              </>
            )}

            <div style={{ ...donateSecLabel, marginTop: lnDetected ? 16 : 12 }}>Lightning address</div>
            <CopyField sync={sync} value={LIGHTNING_ADDRESS} hint="Paste into any Lightning, ecash or web wallet." />

            <div style={{ marginTop:16 }}>
              <button onClick={() => { sync?.openURL(STRIKE_TIP_URL); lsBsCloseRef.current?.() }} style={donatePrimaryBtn}>
                <Lightning size={16} weight="fill" /> Show a QR / pay in a browser <Lightning size={16} weight="fill" />
              </button>
              <div style={{ fontSize:12, color:colors.text.muted, margin:'4px 0 0', textAlign:'center', lineHeight:1.5 }}>
                Scan from another device or on desktop.
              </div>
            </div>

            {BTC_ONCHAIN_ADDRESS && (
              <>
                <div style={donateSecLabel}>On-chain Bitcoin</div>
                <CopyField sync={sync} value={BTC_ONCHAIN_ADDRESS} hint="On-chain BTC. Higher fees, so Lightning is cheaper for small tips." />
              </>
            )}

            {!lnDetected && (
              <>
                <div style={{ ...donateBody, textAlign:'center', margin:'20px 0 8px' }}>
                  Don't have a Lightning wallet?
                </div>
                <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
                  {LIGHTNING_WALLETS.map(w => (
                    <button key={w.name} onClick={() => sync?.openURL(w.url)}
                      style={{ background: colors.surface.card, borderRadius:12, padding:'10px 16px', border:`1px solid ${colors.border}`,
                        minHeight:DONATE_OPTION_MIN_H, boxSizing:'border-box',
                        display:'flex', alignItems:'center', gap:12, cursor:'pointer', width:'100%',
                        fontFamily:FONT, textAlign:'left' }}>
                      <div style={{ flex:1 }}>
                        <div style={{ fontSize:14, fontWeight:400, color: colors.text.primary }}>{w.name}</div>
                        <div style={{ fontSize:12, color:colors.text.muted }}>{w.desc}</div>
                      </div>
                      <ArrowSquareOut size={14} weight="thin" color={colors.text.muted} />
                    </button>
                  ))}
                </div>
                <div style={{ ...donateBody, textAlign:'center', marginTop:16 }}>
                  After installing, return here and tap Donate BTC again.
                </div>
              </>
            )}
          </div>
        </BottomSheet>
      )}

      <div style={{ textAlign:'center', fontSize:11, color:colors.text.muted,
        paddingTop:16, paddingBottom:4 }}>
        v{window.__PEARCAL_VERSION__ ?? '1.0.0'}
      </div>
    </div>
  )
}

function ProfileTab ({ profile, groups, onUpdateProfile, db, events, setEvents, dark, onToggleDark, sync, saveEvent, blindPeerKey, setBlindPeerKey, qrScanModeRef }) {
  const [name,       setName]       = useState(profile?.name ?? '')
  const [editing,    setEditing]    = useState(false)
  const [saving,     setSaving]     = useState(false)
  const [photoSaving, setPhotoSaving] = useState(false)
  const [holidayWorking,    setHolidayWorking]    = useState(false)
  const [holidaysOpen,      setHolidaysOpen]      = useState((profile?.holidayCountries ?? []).length > 0)
  const [personalOpen,      setPersonalOpen]      = useState(false)
  const [advancedOpen,      setAdvancedOpen]      = useState(false)
  const [appearanceOpen,    setAppearanceOpen]    = useState(false)
  const [timeFormatOpen,    setTimeFormatOpen]    = useState(false)
  const [weekStartOpen,     setWeekStartOpen]     = useState(false)
  const [defaultRemOpen,    setDefaultRemOpen]    = useState(false)
  const [importExportOpen,  setImportExportOpen]  = useState(false)
  const [reclaimBusy,       setReclaimBusy]       = useState(false)
  const [reclaimResult,     setReclaimResult]     = useState(null)
  const [rebuildConfirm,    setRebuildConfirm]    = useState(false)
  const [storageOpen,       setStorageOpen]       = useState(false)
  const [reportOpen,        setReportOpen]        = useState(null) // 'breakdown' | 'analyze' | null
  const [sweepReport,       setSweepReport]       = useState(null) // dry-run audit result
  const [sweepBusy,         setSweepBusy]         = useState(false)
  const [sweepResult,       setSweepResult]       = useState(null) // post-purge summary
  // Reset app data (TODO #118). `resetSheet` opens the chooser; `resetMode` is
  // set once a level is picked and drives the confirmation step.
  const [resetSheet,        setResetSheet]        = useState(false)
  const [resetMode,         setResetMode]         = useState(null)  // 'keep' | 'full'
  const [resetTyped,        setResetTyped]        = useState('')
  const [resetBusy,         setResetBusy]         = useState(false)
  const [resetError,        setResetError]        = useState(null)
  const closeResetSheetRef  = useRef(null)

  const formatBytes = b => b > 1e9 ? (b/1e9).toFixed(2)+' GB'
                         : b > 1e6 ? (b/1e6).toFixed(1)+' MB'
                         : b > 1e3 ? (b/1e3).toFixed(0)+' KB' : b+' B'
  const [icsImport, setIcsImport] = useState(null)
  const icsFileRef = useRef(null)
  const localeUse24h = !new Intl.DateTimeFormat([], { hour: 'numeric' }).format(0).match(/am|pm/i)
  const use24h    = profile?.use24h    ?? localeUse24h
  const weekStart = profile?.weekStart ?? 0
  const fileRef = useRef()
  // Blind-seeder admission (proposal 2026-07-15-pearcal-seeder-port). Supersedes
  // the old manual blind-peer-key input; the user scans the seeder's QR instead.
  const [blindPeerOpen,    setBlindPeerOpen]    = useState(false)
  const [blindPeers,       setBlindPeers]       = useState([])
  const [removeBpConfirm,  setRemoveBpConfirm]  = useState(null)
  const [renameBpKey,      setRenameBpKey]      = useState(null)
  const [bpRenameDraft,    setBpRenameDraft]    = useState('')
  const [bpRenameSaving,   setBpRenameSaving]   = useState(false)
  const loadBlindPeers = useCallback(() => {
    db.listBlindPeers?.().then(list => setBlindPeers(list ?? [])).catch(() => {})
  }, [db])
  // The off-LAN relay backstop (TODO #130). Default ON — it is what makes the app
  // connect at all on a carrier NAT that can never hole-punch, and PearCal is
  // phone-to-phone so both ends are often on one. OFF is the privacy-maximalist
  // choice: pure peer-to-peer, accepting that such a network simply won't connect.
  const [relayStatus, setRelayStatus] = useState(null)
  const loadRelayStatus = useCallback(() => {
    db.getRelayStatus?.().then(s => setRelayStatus(s ?? null)).catch(() => {})
  }, [db])
  useEffect(() => { loadRelayStatus() }, [loadRelayStatus])
  // Load on mount and refresh whenever the pairing sheet closes (a scan may have
  // just admitted one).
  useEffect(() => { if (!blindPeerOpen) loadBlindPeers() }, [blindPeerOpen, loadBlindPeers])
  // Live refresh (#116 facet #2): the bare backend emits blindPeersChanged when a
  // seederFollow row is added/updated/removed — including a live seeder groupCount
  // update — so the list reflects it in place without a section reopen.
  useEffect(() => {
    const onBlindPeersChanged = () => loadBlindPeers()
    emitter.on('blindPeersChanged', onBlindPeersChanged)
    return () => emitter.off('blindPeersChanged', onBlindPeersChanged)
  }, [loadBlindPeers])

  // Inline rename of a blind peer (member-side, LOCAL to this device). The pencil
  // opens an editable name; the override is stored per-device. Clearing it (blank)
  // reveals the seeder's own advertised name (bp.seederName), shown as the input
  // placeholder so the user can see what it will revert to.
  function startRenameBp (bp) {
    setRemoveBpConfirm(null)
    setBpRenameDraft(bp.override ?? '') // pre-fill the raw override, not the resolved name
    setRenameBpKey(bp.pubkey)
  }
  function cancelRenameBp () {
    setRenameBpKey(null)
    setBpRenameDraft('')
  }
  async function saveRenameBp (pubkey) {
    if (bpRenameSaving) return
    setBpRenameSaving(true)
    try {
      const trimmed = (bpRenameDraft ?? '').trim().slice(0, 32)
      const override = trimmed || null
      await db.renameBlindPeer?.(pubkey, trimmed)
      // Optimistic update so the row reflects immediately; the blindPeersChanged
      // event will reconcile shortly after. Clearing reveals the seeder self-name.
      setBlindPeers(list => list.map(bp => bp.pubkey === pubkey
        ? { ...bp, override, nickname: override ?? bp.seederName ?? null }
        : bp))
      setRenameBpKey(null)
      setBpRenameDraft('')
    } catch (e) {
      console.error('renameBlindPeer failed', e)
    }
    setBpRenameSaving(false)
  }
  const [pairHost,         setPairHost]         = useState(null) // null | { url, expiresAt } | { url, expiresAt, expired: true } | { status: 'completed' }
  const [pairHostBusy,     setPairHostBusy]     = useState(false)
  const [pairHostError,    setPairHostError]    = useState(null)
  const [linkedDevices,    setLinkedDevices]    = useState([])
  const [renamingKey,      setRenamingKey]      = useState(null)
  const [renameDraft,      setRenameDraft]      = useState('')
  const [renameSaving,     setRenameSaving]     = useState(false)
  const [removeConfirmKey, setRemoveConfirmKey] = useState(null)
  const [removingKey,      setRemovingKey]      = useState(null)

  async function saveName () {
    setSaving(true)
    await onUpdateProfile({ name })
    setSaving(false)
    setEditing(false)
  }

  async function handlePhotoChange (e) {
    const file = e.target.files?.[0]
    if (!file || !file.type.startsWith('image/')) return
    setPhotoSaving(true)
    try {
      const compressed = await compressAvatar(file)
      await onUpdateProfile({ avatar: compressed })
    } catch (err) {
      console.error('Photo compress failed', err)
    }
    setPhotoSaving(false)
    // Reset input so same file can be picked again
    e.target.value = ''
  }

  async function removePhoto () {
    const initials = (profile?.name ?? '').trim().split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0,2) || '?'
    setPhotoSaving(true)
    await onUpdateProfile({ avatar: initials })
    setPhotoSaving(false)
  }

  const hasPhoto = profile?.avatar?.startsWith?.('data:')
  const publicKey = profile?.publicKey ?? '—'
  const identityId = profile?.id ?? '—'

  // Primary-side pair event listeners. Active while pairHost is non-null (modal
  // is shown). pairingCompleted auto-dismisses with a success flash; expired
  // transitions the modal into a "tap to regenerate" state without closing it.
  useEffect(() => {
    if (!pairHost || pairHost.status === 'completed') return
    function onPairingCompleted (data) {
      if (!data || data.role !== 'primary') return
      setPairHost({ status: 'completed' })
      setPairHostError(null)
      setTimeout(() => setPairHost(null), 1800)
    }
    function onPairingExpired () {
      setPairHost(h => h && !h.status ? { ...h, expired: true } : h)
    }
    function onPairingFailed (data) {
      setPairHostError(data?.message || data?.reason || 'Pairing failed')
    }
    emitter.on('pairingCompleted', onPairingCompleted)
    emitter.on('pairingExpired', onPairingExpired)
    emitter.on('pairingFailed', onPairingFailed)
    return () => {
      emitter.off('pairingCompleted', onPairingCompleted)
      emitter.off('pairingExpired', onPairingExpired)
      emitter.off('pairingFailed', onPairingFailed)
    }
  }, [pairHost])

  async function startDevicePairing () {
    if (pairHostBusy) return
    setPairHostBusy(true)
    setPairHostError(null)
    try {
      // startPairing in bare.js requires personalMeta:bootstrap — enable on demand.
      await db.enablePersonalSync()
      const res = await db.startPairing()
      if (!res?.url) throw new Error('Could not generate pairing link')
      setPairHost({ url: res.url, expiresAt: res.expiresAt })
    } catch (e) {
      setPairHostError(e?.message || 'Failed to start pairing')
    }
    setPairHostBusy(false)
  }

  // Linked devices list (TODO #95). Loads on mount + refreshes on the
  // linkedDevicesChanged event (fires when any device's deviceMeta row is
  // added or renamed, locally or on a sibling).
  useEffect(() => {
    let cancelled = false
    async function refresh () {
      try {
        const list = await db.listLinkedDevices()
        if (!cancelled) setLinkedDevices(Array.isArray(list) ? list : [])
      } catch (e) {
        if (!cancelled) setLinkedDevices([])
      }
    }
    refresh()
    function onChanged () { refresh() }
    function onPairingCompleted () {
      refresh()
      // Defensive retry: personalBase.activeWriters may take an event-loop
      // tick to reflect the new writer even after the bare-side base.update()
      // call. A delayed second refresh ensures the synthesised row appears
      // reliably when network or apply timing varies.
      setTimeout(() => { if (!cancelled) refresh() }, 500)
    }
    emitter.on('linkedDevicesChanged', onChanged)
    emitter.on('pairingCompleted', onPairingCompleted)
    // Belt-and-suspenders: poll every 3s so deviceMeta rows that arrive via
    // Autobase replay-after-pair eventually show up even if their event raced
    // the initial mount. Cheap (single hyperbee read).
    const poll = setInterval(refresh, 3000)
    return () => {
      cancelled = true
      clearInterval(poll)
      emitter.off('linkedDevicesChanged', onChanged)
      emitter.off('pairingCompleted', onPairingCompleted)
    }
  }, [db])

  function deviceDefaultLabel (d) {
    if (d.isThisDevice) return 'This device'
    const p = (d.platform ?? '').toLowerCase()
    if (p === 'ios')     return 'iOS device'
    if (p === 'android') return 'Android device'
    if (p === 'macos')   return 'macOS device'
    if (p === 'windows') return 'Windows device'
    return 'Device'
  }

  function devicePlatformLabel (d) {
    const p = (d.platform ?? '').toLowerCase()
    if (p === 'ios')     return 'iOS'
    if (p === 'android') return 'Android'
    if (p === 'macos')   return 'macOS'
    if (p === 'windows') return 'Windows'
    return p ? p[0].toUpperCase() + p.slice(1) : 'Unknown'
  }

  function startRenameDevice (d) {
    if (!d.isThisDevice) return
    setRenameDraft(d.nickname ?? '')
    setRenamingKey(d.writerKey)
  }

  function cancelRenameDevice () {
    setRenamingKey(null)
    setRenameDraft('')
  }

  async function saveRenameDevice () {
    if (renameSaving) return
    setRenameSaving(true)
    try {
      const trimmed = (renameDraft ?? '').trim().slice(0, 32)
      const res = await db.setDeviceNickname(trimmed)
      // Optimistic local update so the row reflects immediately even before
      // the apply branch fires the event back.
      setLinkedDevices(list => list.map(d => d.isThisDevice
        ? { ...d, nickname: res?.nickname ?? trimmed }
        : d))
      setRenamingKey(null)
      setRenameDraft('')
    } catch (e) {
      // Surface failure quietly; the row stays in rename mode so the user can retry.
      console.error('setDeviceNickname failed', e)
    }
    setRenameSaving(false)
  }

  async function confirmRemoveDevice (writerKey) {
    if (!writerKey || removingKey) return
    setRemovingKey(writerKey)
    try {
      await db.removeDeviceFromList(writerKey)
      // Optimistic local prune; apply event will follow and reconcile.
      setLinkedDevices(list => list.filter(d => d.writerKey !== writerKey))
    } catch (e) {
      console.error('removeDeviceFromList failed', e)
    }
    setRemovingKey(null)
    setRemoveConfirmKey(null)
  }

  async function cancelDevicePairing () {
    try { await db.cancelPairing() } catch {}
    setPairHost(null)
    setPairHostError(null)
  }

  return (
    <div style={{ padding:'24px 20px' }}>
      <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:12, marginBottom:28 }}>

        {/* Avatar — tap to change */}
        <div style={{ position:'relative' }}>
          <div style={{ width:88, height:88, borderRadius:'50%', background:profile?.color ?? '#6C9BF5',
            display:'flex', alignItems:'center', justifyContent:'center',
            fontSize:36, color:'#fff', overflow:'hidden',
            opacity: photoSaving ? 0.5 : 1, transition:'opacity 0.2s' }}>
            {hasPhoto
              ? <img src={profile.avatar} alt="avatar"
                  style={{ width:'100%', height:'100%', objectFit:'cover' }} />
              : (profile?.name ?? '?').slice(0,1).toUpperCase()
            }
          </div>
          {photoSaving && (
            <div style={{ position:'absolute', inset:0, borderRadius:'50%',
              display:'flex', alignItems:'center', justifyContent:'center',
              background:'rgba(0,0,0,0.45)' }}>
              <ArrowsClockwise size={20} weight="thin" color="#FFFFFF"
                style={{ animation: 'pearSpin 800ms linear infinite' }} />
            </div>
          )}
        </div>

        {/* Photo action buttons */}
        <div style={{ display:'flex', gap:8 }}>
          <button onClick={() => window.__pearSync?.takePhoto?.()} disabled={photoSaving}
            style={{ fontSize:12, padding:'5px 14px', borderRadius:8,
              border:`1px solid ${colors.border}`, background:'transparent',
              color:colors.text.primary, cursor:'pointer', fontFamily:FONT,
              display:'flex', alignItems:'center', gap:5,
              opacity: photoSaving ? 0.5 : 1 }}>
            <Image size={14} weight="thin" /> Photo
          </button>
          {hasPhoto && (
            <button onClick={removePhoto} disabled={photoSaving}
              style={{ fontSize:12, padding:'5px 14px', borderRadius:8,
                border:`1px solid #D45F7A`, background:'transparent',
                color:'#D45F7A', cursor:'pointer', fontFamily:FONT,
                opacity: photoSaving ? 0.5 : 1 }}>
              Remove
            </button>
          )}
        </div>
        <input ref={fileRef} type="file" accept="image/*" style={{ display:'none' }}
          onChange={handlePhotoChange} />

        {editing
          ? <input autoFocus style={{ fontSize:18, textAlign:'center', background:'transparent',
              fontFamily:FONT, border:`1px solid ${colors.border}`, borderRadius:8, padding:'6px 12px',
              color:colors.text.primary, outline:'none' }}
              value={name} onChange={e => setName(e.target.value)} />
          : <span style={{ fontSize:20, color: colors.text.primary }}>{profile?.name ?? 'My Name'}</span>
        }
        <button
          onClick={editing ? saveName : () => setEditing(true)}
          disabled={saving}
          style={{ ...pillBtn, fontSize:13, padding:'5px 16px', opacity:saving ? 0.6 : 1 }}>
          {saving ? 'Saving…' : editing ? 'Save Name' : 'Edit Name'}
        </button>
      </div>

      <div style={{ fontSize:12, color:colors.text.muted, letterSpacing:'0.06em',
        marginBottom:12, marginTop:4, textAlign:'center' }}>
        SETTINGS
      </div>

      {/* Personal */}
      <div style={{ background: colors.surface.card, borderRadius:12, marginBottom:16, overflow:'hidden' }}>
        <div onClick={() => { window.__pearSync?.haptic('light'); setPersonalOpen(o => !o) }}
          style={{ display:'flex', alignItems:'center', justifyContent:'space-between',
            padding:'14px 16px', cursor:'pointer' }}>
          <div style={{ fontSize:12, color:colors.text.muted, letterSpacing:'0.06em' }}>
            PERSONAL
          </div>
          <CaretRight size={16} weight="thin" color="var(--color-muted)"
            style={{ transition: 'transform 0.3s', transform: personalOpen ? 'rotate(90deg)' : 'rotate(0deg)', display: 'inline-block' }} />
        </div>
      </div>

      <div style={{ maxHeight: personalOpen ? '2000px' : '0px', overflow:'hidden',
        transition:'max-height 0.4s cubic-bezier(0.4, 0, 0.2, 1)' }}>

      {/* Appearance */}
      <div style={{ fontSize:11, color:colors.text.muted, letterSpacing:'0.08em', textAlign:'center', marginTop:16, marginBottom:8 }}>
        APPEARANCE
      </div>
      <div style={{ marginBottom:12 }}>
        <div style={{ padding:'14px 16px', display:'flex', alignItems:'center',
          justifyContent:'space-between' }}>
          <div style={{ fontSize:13, color: colors.text.primary }}>Dark mode</div>
          <Toggle val={dark} onChange={onToggleDark} accent={colors.primary} />
        </div>
      </div>

      {/* First Day of Week */}
      <div style={{ fontSize:11, color:colors.text.muted, letterSpacing:'0.08em', textAlign:'center', marginTop:16, marginBottom:8 }}>
        FIRST DAY OF WEEK
      </div>
      <div style={{ marginBottom:12 }}>
        <div style={{ padding:'14px 16px', display:'flex', gap:8 }}>
          {[['Sunday', 0], ['Monday', 1]].map(([label, val]) => (
            <button key={val} onClick={() => { onUpdateProfile({ weekStart: val }) }}
              style={{ flex:1, padding:'8px 0', borderRadius:10, fontSize:13, 
                cursor:'pointer', fontFamily:FONT,
                border:'1.5px solid ' + (weekStart === val ? colors.primary : colors.border),
                background: weekStart === val ? colors.primary : 'transparent',
                color: weekStart === val ? '#fff' : colors.text.muted }}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Default Reminder */}
      <div style={{ fontSize:11, color:colors.text.muted, letterSpacing:'0.08em', textAlign:'center', marginTop:16, marginBottom:8 }}>
        DEFAULT REMINDER
      </div>
      <div style={{ marginBottom:12 }}>
        <div style={{ padding:'14px 16px' }}>
          <select value={profile?.defaultReminder ?? 15}
            onChange={e => { window.__pearSync?.haptic('light'); onUpdateProfile({ defaultReminder: Number(e.target.value) }) }}
            style={{ width:'100%', padding:'10px 12px', borderRadius:10, fontSize:13, 
              border:`1px solid ${colors.border}`, background:colors.surface.input, color:colors.text.primary,
              fontFamily:FONT, appearance:'none' }}>
            <option value={0}>None</option>
            {REMINDER_OPTIONS.map(r => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Daily Digest */}
      {(() => {
        const digestEnabled = profile?.digestEnabled !== false
        const digestHour    = Number.isFinite(Number(profile?.digestHour))   ? Number(profile.digestHour)   : 9
        const digestMinute  = Number.isFinite(Number(profile?.digestMinute)) ? Number(profile.digestMinute) : 0
        const hhmm = String(digestHour).padStart(2, '0') + ':' + String(digestMinute).padStart(2, '0')
        return (
          <>
            <div style={{ fontSize:11, color:colors.text.muted, letterSpacing:'0.08em', textAlign:'center', marginTop:16, marginBottom:8 }}>
              DAILY DIGEST
            </div>
            <div style={{ marginBottom:12 }}>
              <div style={{ padding:'14px 16px', display:'flex', alignItems:'center',
                justifyContent:'space-between' }}>
                <div style={{ flex:1, paddingRight:12 }}>
                  <div style={{ fontSize:13, color: colors.text.primary }}>Morning summary</div>
                  <div style={{ fontSize:11, color:colors.text.muted, marginTop:2 }}>
                    Notifies you of today's events so the app foregrounds and peers sync
                  </div>
                </div>
                <Toggle val={digestEnabled}
                  onChange={v => { onUpdateProfile({ digestEnabled: v }) }}
                  accent={colors.primary} />
              </div>
              {digestEnabled && (
                <div style={{ padding:'0 16px 14px', display:'flex', alignItems:'center',
                  justifyContent:'space-between' }}>
                  <div style={{ fontSize:13, color: colors.text.primary }}>Time</div>
                  <input type="time" value={hhmm}
                    onChange={e => {
                      const [hStr, mStr] = e.target.value.split(':')
                      const h = Number(hStr), m = Number(mStr)
                      if (!isNaN(h) && !isNaN(m)) {
                        window.__pearSync?.haptic('light')
                        onUpdateProfile({ digestHour: h, digestMinute: m })
                      }
                    }}
                    style={{ padding:'8px 12px', borderRadius:10, fontSize:13, 
                      border:`1px solid ${colors.border}`, background:colors.surface.input, color:colors.text.primary,
                      fontFamily:FONT, appearance:'none' }} />
                </div>
              )}
            </div>
          </>
        )
      })()}

      {/* Time Format */}
      <div style={{ fontSize:11, color:colors.text.muted, letterSpacing:'0.08em', textAlign:'center', marginTop:16, marginBottom:8 }}>
        TIME FORMAT
      </div>
      <div style={{ marginBottom:12 }}>
        <div style={{ padding:'14px 16px', display:'flex', alignItems:'center',
          justifyContent:'space-between' }}>
          <div>
            <div style={{ fontSize:13, color: colors.text.primary }}>24-hour time</div>
            <div style={{ fontSize:11, color:colors.text.muted, marginTop:2 }}>
              {use24h ? 'e.g. 14:30' : 'e.g. 2:30pm'}
            </div>
          </div>
          <Toggle val={use24h} onChange={v => onUpdateProfile({ use24h: v })} accent={colors.primary} />
        </div>
      </div>

      {/* Widget */}
      <div style={{ fontSize:11, color:colors.text.muted, letterSpacing:'0.08em', textAlign:'center', marginTop:16, marginBottom:8 }}>
        WIDGET
      </div>
      <div style={{ marginBottom:12 }}>
        <div style={{ padding:'14px 16px', display:'flex', alignItems:'center',
          justifyContent:'space-between' }}>
          <div style={{ flex:1, paddingRight:12 }}>
            <div style={{ fontSize:13, color: colors.text.primary }}>Show upcoming events</div>
            <div style={{ fontSize:11, color:colors.text.muted, marginTop:2 }}>
              On empty days, list the next few events instead of just tomorrow
            </div>
          </div>
          <Toggle val={profile?.widgetShowUpcoming === true}
            onChange={v => { onUpdateProfile({ widgetShowUpcoming: v }) }}
            accent={colors.primary} />
        </div>
      </div>

      {/* Holidays */}
      {(() => {
        const thisYear = new Date().getFullYear()
        const years = [thisYear, thisYear + 1]
        const makeId = holidayEventId
        const allCountries = HOLIDAY_COUNTRIES
        // Toggle state tracked explicitly in profile to avoid shared-ID false positives
        const activeCountries = new Set(profile?.holidayCountries ?? [])

        async function toggleCountry (code, fn, on) {
          setHolidayWorking(true)
          const meta = allCountries.find(c => c.code === code)
          const color = meta?.color ?? '#CF3535'
          const colors = meta?.colors ?? []
          const desc  = meta?.desc  ?? 'Public Holiday'
          const newActive = new Set(activeCountries)
          // IDs the calendars that stay on after this toggle still need.
          const otherIds = () => {
            const keep = new Set()
            for (const { code: otherCode, fn: otherFn } of allCountries) {
              if (otherCode === code || !newActive.has(otherCode)) continue
              for (const id of holidayCalendarIds(otherFn, years)) keep.add(id)
            }
            return keep
          }
          // Remove this calendar's stored events that `keepIds` does not claim.
          // Matched by title slug rather than exact ID so events sitting at a
          // date an older build computed wrongly are still found.
          const keepAndSweep = async keepIds => {
            for (const ev of strayHolidayEvents(events, fn, years, keepIds)) {
              await db?.localDeleteEvent(ev.date, ev.id).catch(() => {})
              setEvents(prev => prev.filter(e => e.id !== ev.id))
            }
          }
          if (on) {
            newActive.add(code)
            // Import holidays; skip any already in calendar by shared ID or same date+title
            const existingIds = new Set((events ?? []).map(e => e.id))
            const existingKeys = new Set((events ?? []).map(e => e.date + '|' + e.title))
            for (const yr of years) {
              for (const h of fn(yr)) {
                const id = makeId(h)
                const key = h.date + '|' + h.title
                if (existingIds.has(id) || existingKeys.has(key)) continue
                const ev = {
                  id, title: h.title, date: h.date, allDay: true,
                  start: '00:00', end: '00:00', reminder: -1,
                  groups: [], invitees: [], color, colors,
                  desc, location: '',
                  creatorId: 'system', recurrence: 'none',
                  recurrenceId: '', recurrenceEnd: '', recurrenceNth: 0, recurrenceWeekday: 0,
                  editPermission: 'everyone', updatedAt: Date.now(),
                }
                await db?.putEvent(ev).catch(() => {})
                setEvents(prev => prev.find(e => e.id === ev.id) ? prev : [...prev, ev])
                existingIds.add(id)
                existingKeys.add(key)
              }
            }
            // Turning a calendar on also repairs it: drop anything it left
            // behind at a date an older build computed wrongly, keeping the
            // dates it and the other active calendars still want.
            await keepAndSweep(new Set([...otherIds(), ...holidayCalendarIds(fn, years)]))
          } else {
            newActive.delete(code)
            await keepAndSweep(otherIds())
          }
          await onUpdateProfile({ holidayCountries: [...newActive] }).catch(() => {})
          setHolidayWorking(false)
        }

        const anyEnabled = activeCountries.size > 0
        return (
          <>
            <div style={{ fontSize:11, color:colors.text.muted, letterSpacing:'0.08em', textAlign:'center', marginTop:16, marginBottom:8 }}>
              HOLIDAYS
            </div>
            <div style={{ marginBottom:12,
              opacity: holidayWorking ? 0.6 : 1, transition:'opacity 0.2s' }}>
              <div style={{ padding:'14px 16px' }}>
                {allCountries.map(({ code, flag, label, fn, color: flagColor }, i) => (
                  <div key={code} style={{ display:'flex', alignItems:'center', gap:10,
                    padding:'10px 0', borderBottom: i < allCountries.length - 1 ? `1px solid ${colors.border}` : 'none' }}>
                    <span style={{ fontSize:20, color: flagColor }}>{flag}</span>
                    <div style={{ flex:1 }}>
                      <div style={{ fontSize:13, color: colors.text.primary }}>{label}</div>
                      <div style={{ fontSize:11, color:colors.text.muted }}>
                        {fn(thisYear).length} holidays · {thisYear}–{thisYear + 1}
                      </div>
                    </div>
                    <Toggle val={activeCountries.has(code)}
                      onChange={v => !holidayWorking && toggleCountry(code, fn, v)} accent={colors.primary} />
                  </div>
                ))}
                {anyEnabled && (
                  <div style={{ fontSize:11, color:colors.text.muted, marginTop:10 }}>
                    Added to your personal calendar. Toggle off to remove.
                  </div>
                )}
              </div>
            </div>
          </>
        )
      })()}

      </div>

      {/* Advanced */}
      <div style={{ background: colors.surface.card, borderRadius:12, marginBottom:16, overflow:'hidden' }}>
        <div onClick={() => { window.__pearSync?.haptic('light'); setAdvancedOpen(o => !o) }}
          style={{ display:'flex', alignItems:'center', justifyContent:'space-between',
            padding:'14px 16px', cursor:'pointer' }}>
          <div style={{ fontSize:12, color:colors.text.muted, letterSpacing:'0.06em' }}>
            ADVANCED
          </div>
          <CaretRight size={16} weight="thin" color="var(--color-muted)"
            style={{ transition: 'transform 0.3s', transform: advancedOpen ? 'rotate(90deg)' : 'rotate(0deg)', display: 'inline-block' }} />
        </div>
      </div>

      <div style={{ maxHeight: advancedOpen ? '3000px' : '0px', overflow:'hidden',
        transition:'max-height 0.4s cubic-bezier(0.4, 0, 0.2, 1)' }}>

      {/* Devices (TODO #11 Phase 4) */}
      <div style={{ fontSize:11, color:colors.text.muted, letterSpacing:'0.08em', textAlign:'center', marginTop:16, marginBottom:8 }}>
        DEVICES
      </div>
      <div style={{ marginBottom:12 }}>
        <div style={{ padding:'0 16px 14px' }}>
          <button onClick={() => { startDevicePairing() }}
            disabled={pairHostBusy || !!pairHost}
            style={{ display:'flex', alignItems:'center', gap:12, width:'100%',
              padding:'12px 14px', borderRadius:10, cursor:'pointer',
              border:`1px solid var(--color-accent)`, background:'transparent', fontFamily:FONT,
              opacity: (pairHostBusy || !!pairHost) ? 0.5 : 1 }}>
            <Plus size={18} weight="thin" color="var(--color-accent)" />
            <div style={{ flex:1, textAlign:'left' }}>
              <div style={{ fontSize:14, fontWeight:400, color:'var(--color-accent)' }}>
                {pairHostBusy ? 'Generating…' : 'Add a device'}
              </div>
              <div style={{ fontSize:11, color:colors.text.muted }}>
                Pair your phone, tablet, or desktop under the same identity
              </div>
            </div>
          </button>
          {pairHostError && !pairHost && (
            <div style={{ fontSize:12, color:'#e67b7b', marginTop:8, textAlign:'center' }}>
              {pairHostError}
            </div>
          )}
          {linkedDevices.length > 0 && (
            <div style={{ marginTop:12, display:'flex', flexDirection:'column', gap:8 }}>
              {linkedDevices.map(d => {
                const isRenaming = renamingKey       === d.writerKey
                const isConfirmingRemove = removeConfirmKey === d.writerKey
                const isRemoving = removingKey       === d.writerKey
                const label = (d.nickname && d.nickname.trim()) || deviceDefaultLabel(d)
                const subtitle = devicePlatformLabel(d) + (d.isThisDevice ? ' · this device' : '')
                const cardStyle = {
                  padding:'12px 14px', borderRadius:10,
                  border:`1px solid ${colors.border}`, background:'transparent',
                  cursor: d.isThisDevice && !isRenaming ? 'pointer' : 'default',
                  ...(d.isThisDevice
                    ? { borderLeft: '3px solid var(--color-accent)', paddingLeft: 12 }
                    : {}),
                }
                return (
                  <div key={d.writerKey}
                    onClick={() => { if (!isRenaming && !isConfirmingRemove && d.isThisDevice) { window.__pearSync?.haptic('light'); startRenameDevice(d) } }}
                    style={cardStyle}>
                    {isRenaming ? (
                      <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                        <input autoFocus type="text" value={renameDraft} maxLength={32}
                          onChange={e => setRenameDraft(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === 'Enter')  { e.preventDefault(); saveRenameDevice() }
                            if (e.key === 'Escape') { e.preventDefault(); cancelRenameDevice() }
                          }}
                          placeholder={deviceDefaultLabel(d)}
                          style={{ fontSize:14, fontFamily:FONT,
                            background:'transparent', border:`1px solid ${colors.border}`,
                            borderRadius:8, padding:'8px 10px', color:colors.text.primary, outline:'none' }} />
                        <div style={{ display:'flex', justifyContent:'flex-end', gap:8 }}>
                          <button onClick={e => { e.stopPropagation(); cancelRenameDevice() }}
                            disabled={renameSaving}
                            style={{ padding:'6px 12px', borderRadius:8, fontSize:13, 
                              fontFamily:FONT, border:`1px solid ${colors.border}`, background:'transparent',
                              color:colors.text.muted, cursor:'pointer' }}>
                            Cancel
                          </button>
                          <button onClick={e => { e.stopPropagation(); saveRenameDevice() }}
                            disabled={renameSaving}
                            style={{ padding:'6px 12px', borderRadius:8, fontSize:13, 
                              fontFamily:FONT, border:`1px solid var(--color-accent)`, background:'transparent',
                              color:'var(--color-accent)', cursor:'pointer',
                              opacity: renameSaving ? 0.5 : 1 }}>
                            {renameSaving ? 'Saving…' : 'Save'}
                          </button>
                        </div>
                      </div>
                    ) : isConfirmingRemove ? (
                      <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                        <div style={{ fontSize:13, color:colors.text.muted, lineHeight:1.5, textAlign:'center' }}>
                          Remove <span style={{ color: colors.text.primary, fontWeight:400 }}>{label}</span> from your devices list?
                        </div>
                        <div style={{ display:'flex', justifyContent:'center', gap:8 }}>
                          <button onClick={e => { e.stopPropagation(); setRemoveConfirmKey(null) }}
                            disabled={isRemoving}
                            style={{ padding:'6px 12px', borderRadius:8, fontSize:13, 
                              fontFamily:FONT, border:`1px solid ${colors.border}`, background:'transparent',
                              color:colors.text.muted, cursor:'pointer' }}>
                            Cancel
                          </button>
                          <button onClick={e => { e.stopPropagation(); confirmRemoveDevice(d.writerKey) }}
                            disabled={isRemoving}
                            style={{ padding:'6px 12px', borderRadius:8, fontSize:13, 
                              fontFamily:FONT, border:`1px solid var(--color-destructive)`, background:'transparent',
                              color:'var(--color-destructive)', cursor:'pointer',
                              opacity: isRemoving ? 0.5 : 1 }}>
                            {isRemoving ? 'Removing…' : 'Remove'}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                        <div style={{ flex:1, minWidth:0 }}>
                          <div style={{ fontSize:14, color: colors.text.primary,
                            whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
                            {label}
                          </div>
                          <div style={{ fontSize:11, color:colors.text.muted, marginTop:2 }}>
                            {subtitle}
                          </div>
                        </div>
                        {d.isThisDevice ? (
                          <CaretRight size={14} weight="thin" color="var(--color-muted)" />
                        ) : (
                          <button onClick={e => { e.stopPropagation(); setRemoveConfirmKey(d.writerKey) }}
                            aria-label="Remove device"
                            style={{ background:'transparent', border:'none', padding:6,
                              cursor:'pointer', display:'flex', alignItems:'center',
                              color:colors.text.muted, fontFamily:FONT }}>
                            <X size={16} weight="thin" />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
              <div style={{ fontSize:11, color:colors.text.muted, marginTop:2, lineHeight:1.4 }}>
                Tap your device to rename it.
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Import & Export */}
      <div style={{ fontSize:11, color:colors.text.muted, letterSpacing:'0.08em', textAlign:'center', marginTop:16, marginBottom:8 }}>
        IMPORT & EXPORT
      </div>
      <div style={{ marginBottom:12 }}>
        <div style={{ padding:'14px 16px', display:'flex', flexDirection:'column', gap:10 }}>
            <input ref={icsFileRef} type="file" accept=".ics,.ical,text/calendar"
              style={{ display:'none' }} onChange={e => {
                const file = e.target.files?.[0]
                if (!file) return
                e.target.value = ''
                const reader = new FileReader()
                reader.onload = ev => {
                  const parsed = parseIcs(ev.target.result)
                  if (parsed.length === 0) return
                  setIcsImport({ events: parsed, filename: file.name })
                }
                reader.readAsText(file)
              }} />
            <button onClick={() => icsFileRef.current?.click()}
              style={{ display:'flex', alignItems:'center', gap:10,
                padding:'12px 14px', borderRadius:10, cursor:'pointer',
                border:`1px solid ${colors.border}`, background:'transparent', fontFamily:FONT }}>
              <UploadSimple size={18} weight="thin" color="var(--color-accent)" />
              <div style={{ flex:1, textAlign:'left' }}>
                <div style={{ fontSize:14, color: colors.text.primary }}>Import Events</div>
                <div style={{ fontSize:11, color:colors.text.muted }}>Import from .ics file</div>
              </div>
            </button>
            <button onClick={() => {
              const nonHoliday = (events ?? []).filter(e => !e.id?.startsWith('holiday-'))
              if (!nonHoliday.length || !sync) return
              sync.exportIcs(generateIcs(nonHoliday))
            }}
              style={{ display:'flex', alignItems:'center', gap:10,
                padding:'12px 14px', borderRadius:10, cursor:'pointer',
                border:`1px solid ${colors.border}`, background:'transparent', fontFamily:FONT }}>
              <DownloadSimple size={18} weight="thin" color="var(--color-accent)" />
              <div style={{ flex:1, textAlign:'left' }}>
                <div style={{ fontSize:14, color: colors.text.primary }}>Export Events</div>
                <div style={{ fontSize:11, color:colors.text.muted }}>Export all events as .ics</div>
              </div>
            </button>
        </div>
      </div>

      {/* Connection — the off-LAN relay backstop (TODO #130) */}
      {relayStatus?.configured && (<>
        <div style={{ fontSize:11, color:colors.text.muted, letterSpacing:'0.08em', textAlign:'center', marginTop:16, marginBottom:8 }}>
          CONNECTION
        </div>
        <div style={{ marginBottom:12 }}>
          <div style={{ padding:'0 16px 14px' }}>
            <div style={{ padding:'12px 14px', borderRadius:10, border:`1px solid ${colors.border}`,
              display:'flex', flexDirection:'column', gap:10 }}>
              <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                <Broadcast size={18} weight="thin" color="var(--color-accent)" style={{ flexShrink:0 }} />
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:14, color: colors.text.primary }}>Use a relay when direct fails</div>
                  <div style={{ fontSize:11, color: colors.text.muted, lineHeight:1.4 }}>
                    Some mobile networks block phones from connecting straight to each
                    other. When that happens, PearCal routes through a relay run by
                    PeerLoom. It only ever carries scrambled data it can’t read, and
                    it’s only used after a direct connection has already failed.
                  </div>
                </div>
                <Toggle val={relayStatus.useRelay !== false} accent={colors.primary}
                  onChange={async (v) => {
                    window.__pearSync?.haptic('light')
                    setRelayStatus(prev => prev ? { ...prev, useRelay: v } : prev)
                    await db.setUseRelay?.(v).catch(() => {})
                    loadRelayStatus()
                  }} />
              </div>
              {relayStatus.useRelay !== false && (relayStatus.offers > 0 || (relayStatus.relaying?.successes ?? 0) > 0) && (
                <div style={{ fontSize:11, color: colors.text.muted, paddingLeft:28 }}>
                  Used since the app started: {relayStatus.offers} outgoing
                  {(relayStatus.relaying?.successes ?? 0) > 0
                    ? `, ${relayStatus.relaying.successes} incoming`
                    : ''}
                </div>
              )}
              {relayStatus.useRelay === false && (
                <div style={{ fontSize:11, color: colors.text.muted, paddingLeft:28, lineHeight:1.4 }}>
                  Off — connections stay strictly device to device. On a network that
                  blocks them, syncing may not work at all.
                </div>
              )}
            </div>
          </div>
        </div>
      </>)}

      {/* Blind peer (always-on group replicator) */}
      <div style={{ fontSize:11, color:colors.text.muted, letterSpacing:'0.08em', textAlign:'center', marginTop:16, marginBottom:8 }}>
        BLIND PEER
      </div>
      <div style={{ marginBottom:12 }}>
        <div style={{ padding:'0 16px 14px', display:'flex', flexDirection:'column', gap:10 }}>
          {blindPeers.map(bp => {
            const confirming = removeBpConfirm === bp.pubkey
            const renaming = renameBpKey === bp.pubkey
            return (
              <div key={bp.pubkey}
                style={{ padding:'12px 14px', borderRadius:10, border:`1px solid ${colors.border}`,
                  display:'flex', flexDirection:'column', gap:10 }}>
                {renaming ? (
                  <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                    <input autoFocus type="text" value={bpRenameDraft} maxLength={32}
                      onChange={e => setBpRenameDraft(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter')  { e.preventDefault(); saveRenameBp(bp.pubkey) }
                        if (e.key === 'Escape') { e.preventDefault(); cancelRenameBp() }
                      }}
                      placeholder={bp.seederName || 'Blind peer'}
                      style={{ fontSize:14, fontFamily:FONT,
                        background:'transparent', border:`1px solid ${colors.border}`,
                        borderRadius:8, padding:'8px 10px', color:colors.text.primary, outline:'none' }} />
                    <div style={{ fontSize:11, color:colors.text.muted, lineHeight:1.4 }}>
                      A name just for this device. Leave blank to use the seeder’s own name.
                    </div>
                    <div style={{ display:'flex', justifyContent:'flex-end', gap:8 }}>
                      <button onClick={cancelRenameBp} disabled={bpRenameSaving}
                        style={{ padding:'6px 12px', borderRadius:8, fontSize:13,
                          fontFamily:FONT, border:`1px solid ${colors.border}`, background:'transparent',
                          color:colors.text.muted, cursor:'pointer' }}>
                        Cancel
                      </button>
                      <button onClick={() => saveRenameBp(bp.pubkey)} disabled={bpRenameSaving}
                        style={{ padding:'6px 12px', borderRadius:8, fontSize:13,
                          fontFamily:FONT, border:`1px solid var(--color-accent)`, background:'transparent',
                          color:'var(--color-accent)', cursor:'pointer', opacity: bpRenameSaving ? 0.5 : 1 }}>
                        {bpRenameSaving ? 'Saving…' : 'Save'}
                      </button>
                    </div>
                  </div>
                ) : (<>
                <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                  <ShieldCheck size={18} weight="thin" color="#5DBF8A" style={{ flexShrink:0 }} />
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:13, color: colors.text.primary }}>
                      {bp.nickname || 'Blind peer'}
                    </div>
                    <div style={{ fontSize:11, color: colors.text.muted, fontFamily:'monospace',
                      overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                      {String(bp.pubkey).slice(0, 16)}…
                    </div>
                    {/* TODO #125 - `groupCount` was the number cached when this
                        seeder was paired and never revisited, so it could claim
                        "Seeding 2 groups" for a seeder serving one group this
                        device is not even in. bare.js now counts live coverage on
                        every read and hands the wording over with it. A null
                        label means the question has no useful answer - this
                        device has no groups - so nothing is shown rather than
                        accusing the seeder of serving none of them. */}
                    {bp.coverageLabel && (
                      <div style={{ fontSize:11,
                        color: bp.coverageLabel.tone === 'warn' ? '#e0a458' : colors.text.muted }}>
                        {bp.coverageLabel.text}
                      </div>
                    )}
                  </div>
                  {confirming ? (
                    <div style={{ display:'flex', gap:6, flexShrink:0 }}>
                      <button onClick={async () => { window.__pearSync?.haptic('medium'); await db.removeBlindPeer?.(bp.pubkey).catch(() => {}); setRemoveBpConfirm(null); loadBlindPeers() }}
                        style={{ padding:'6px 10px', fontSize:12, borderRadius:8, cursor:'pointer', fontFamily:FONT,
                          border:'1px solid #e67b7b', background:'transparent', color:'#e67b7b' }}>
                        Remove
                      </button>
                      <button onClick={() => setRemoveBpConfirm(null)}
                        style={{ padding:'6px 10px', fontSize:12, borderRadius:8, cursor:'pointer', fontFamily:FONT,
                          border:`1px solid ${colors.border}`, background:'transparent', color: colors.text.muted }}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div style={{ display:'flex', alignItems:'center', gap:2, flexShrink:0 }}>
                      <button onClick={() => { window.__pearSync?.haptic('light'); startRenameBp(bp) }}
                        aria-label="Rename blind peer"
                        style={{ background:'none', border:'none', padding:6, cursor:'pointer',
                          display:'flex', alignItems:'center', color: colors.text.muted }}>
                        <PencilSimple size={16} weight="thin" />
                      </button>
                      <button onClick={() => { window.__pearSync?.haptic('light'); setRemoveBpConfirm(bp.pubkey) }}
                        aria-label="Remove blind peer"
                        style={{ background:'none', border:'none', padding:6, cursor:'pointer',
                          display:'flex', alignItems:'center', color: colors.text.muted }}>
                        <X size={16} weight="thin" />
                      </button>
                    </div>
                  )}
                </div>
                <div style={{ display:'flex', alignItems:'center', gap:10, paddingLeft:28 }}>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:12, color: colors.text.primary }}>Auto-follow new groups</div>
                    <div style={{ fontSize:11, color: colors.text.muted }}>
                      Seeds groups you create later. Shares topic keys — it still can’t read them.
                    </div>
                  </div>
                  <Toggle val={!!bp.autoFollow} accent={colors.primary}
                    onChange={async (v) => { window.__pearSync?.haptic('light'); await db.setSeederAutoFollow?.(bp.pubkey, v).catch(() => {}); loadBlindPeers() }} />
                </div>
                </>)}
              </div>
            )
          })}
          <button onClick={() => { window.__pearSync?.haptic('light'); setBlindPeerOpen(true) }}
            style={{ display:'flex', alignItems:'center', gap:12, width:'100%',
              padding:'12px 14px', borderRadius:10, cursor:'pointer',
              border:`1px solid var(--color-accent)`, background:'transparent', fontFamily:FONT }}>
            <ShieldCheck size={18} weight="thin" color="var(--color-accent)" />
            <div style={{ flex:1, textAlign:'left' }}>
              <div style={{ fontSize:14, fontWeight:400, color:'var(--color-accent)' }}>
                {blindPeers.length ? 'Admit another blind peer' : 'Admit a blind peer'}
              </div>
              <div style={{ fontSize:11, color:colors.text.muted }}>
                {blindPeers.length
                  ? 'Scan another blind peer’s QR to add it'
                  : 'Keep groups synced when no one else is online — it can’t read them'}
              </div>
            </div>
          </button>
        </div>
      </div>

      {/* Storage */}
      {reportOpen && reclaimResult && (
        <div onClick={() => setReportOpen(null)}
          style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:1000,
            display:'flex', alignItems:'center', justifyContent:'center', padding:'24px' }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: colors.surface.card, borderRadius:14, padding:'20px', maxWidth:460, width:'100%',
              maxHeight:'80vh', overflowY:'auto', border:`1px solid ${colors.border}` }}>
            <div style={{ fontSize:16, fontWeight:400, marginBottom:14, textAlign:'center', color: colors.text.primary }}>
              {reportOpen === 'breakdown' ? 'Storage Breakdown' : 'Reclaimable Storage'}
            </div>
            {reportOpen === 'breakdown' && reclaimResult.breakdown && (() => {
              const b = reclaimResult.breakdown
              const typeLabel = { blob:'Large values', log_old:'Old log files', sst:'Index data',
                log:'Current logs', wal:'Write-ahead log', manifest:'Manifests', other:'Other' }
              const cats = Object.entries(b.cats).filter(([,v]) => v.count > 0).sort((a,c) => c[1].size - a[1].size)
              const dirs = Object.entries(b.perDir).sort((a,c) => c[1] - a[1]).slice(0, 6)
              const Bar = ({ size, total }) => (
                <div style={{ height:6, borderRadius:3, background:colors.border, overflow:'hidden', marginTop:4 }}>
                  <div style={{ height:'100%', width:(100 * size / Math.max(total, 1)) + '%', background:colors.primary }} />
                </div>
              )
              return (
                <>
                  <div style={{ textAlign:'center', marginBottom:18 }}>
                    <div style={{ fontSize:28, color: colors.text.primary }}>{formatBytes(b.total)}</div>
                    <div style={{ fontSize:12, color:colors.text.muted }}>Total on disk</div>
                  </div>
                  <div style={{ fontSize:12, fontWeight:400, color:colors.text.muted, letterSpacing:'0.06em', marginBottom:8 }}>BY TYPE</div>
                  {cats.map(([k,v]) => (
                    <div key={k} style={{ marginBottom:10 }}>
                      <div style={{ display:'flex', justifyContent:'space-between', fontSize:13, color: colors.text.primary }}>
                        <span>{typeLabel[k] || k}</span>
                        <span style={{ color:colors.text.muted }}>{formatBytes(v.size)}</span>
                      </div>
                      <Bar size={v.size} total={b.total} />
                    </div>
                  ))}
                  <div style={{ fontSize:12, fontWeight:400, color:colors.text.muted, letterSpacing:'0.06em', margin:'16px 0 8px' }}>BY LOCATION</div>
                  {dirs.map(([k,v]) => (
                    <div key={k} style={{ marginBottom:10 }}>
                      <div style={{ display:'flex', justifyContent:'space-between', fontSize:13, color: colors.text.primary }}>
                        <span style={{ fontFamily:'monospace' }}>{k || '.'}</span>
                        <span style={{ color:colors.text.muted }}>{formatBytes(v)}</span>
                      </div>
                      <Bar size={v} total={b.total} />
                    </div>
                  ))}
                </>
              )
            })()}
            {reportOpen === 'analyze' && reclaimResult.analyze && (() => {
              const a = reclaimResult.analyze
              return (
                <>
                  <div style={{ textAlign:'center', marginBottom:18 }}>
                    <div style={{ fontSize:28, color: colors.text.primary }}>{formatBytes(a.reclaimableBytes)}</div>
                    <div style={{ fontSize:12, color:colors.text.muted }}>
                      reclaimable ({a.pct}% of {formatBytes(a.totalBytes)})
                    </div>
                  </div>
                  <div style={{ height:8, borderRadius:4, background:colors.border, overflow:'hidden', marginBottom:18 }}>
                    <div style={{ height:'100%', width:a.pct + '%', background:colors.primary }} />
                  </div>
                  {(() => {
                    const sections = [
                      { heading: 'LOCAL DATABASE', match: g => g.id === '__local__' },
                      { heading: 'GROUPS',         match: g => g.id !== '__local__' && g.id !== '__orphans__' },
                      { heading: 'ORPHANED CORES', match: g => g.id === '__orphans__' },
                    ]
                    const Row = g => (
                      <div key={g.id} style={{ marginBottom:10 }}>
                        <div style={{ display:'flex', justifyContent:'space-between', fontSize:13, color: colors.text.primary }}>
                          <span>{g.name}</span>
                          <span style={{ color:colors.text.muted }}>
                            {formatBytes(g.bytes)}{g.reclaim > 0 ? ' · ' + formatBytes(g.reclaim) + ' reclaimable' : ''}
                          </span>
                        </div>
                        <div style={{ height:6, borderRadius:3, background:colors.border, overflow:'hidden', marginTop:4, position:'relative' }}>
                          <div style={{ height:'100%', width:(100 * g.bytes / Math.max(a.totalBytes, 1)) + '%', background:colors.text.muted, opacity:0.35 }} />
                          <div style={{ position:'absolute', top:0, left:0, height:'100%', width:(100 * g.reclaim / Math.max(a.totalBytes, 1)) + '%', background:colors.primary }} />
                        </div>
                      </div>
                    )
                    return sections.map(s => {
                      const items = a.groups.filter(s.match).sort((x,y) => y.bytes - x.bytes)
                      if (!items.length) return null
                      return (
                        <div key={s.heading}>
                          <div style={{ fontSize:12, fontWeight:400, color:colors.text.muted, letterSpacing:'0.06em', margin:'0 0 8px' }}>{s.heading}</div>
                          {items.map(Row)}
                          <div style={{ height:8 }} />
                        </div>
                      )
                    })
                  })()}
                </>
              )
            })()}
            <button onClick={() => setReportOpen(null)}
              style={{ marginTop:18, width:'100%', padding:'10px 16px', borderRadius:8,
                border:`1px solid ${colors.border}`, background:'transparent', color:colors.text.primary,
                fontFamily:FONT, fontSize:13, cursor:'pointer' }}>
              Close
            </button>
          </div>
        </div>
      )}
      {rebuildConfirm && (
        <div onClick={() => !reclaimBusy && setRebuildConfirm(false)}
          style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:1000,
            display:'flex', alignItems:'center', justifyContent:'center', padding:'24px' }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: colors.surface.card, borderRadius:14, padding:'20px', maxWidth:420, width:'100%', border:`1px solid ${colors.border}` }}>
            <div style={{ fontSize:16, fontWeight:400, marginBottom:10, textAlign:'center', color: colors.text.primary }}>
              Reclaim Storage?
            </div>
            <div style={{ fontSize:13, color:colors.text.muted, lineHeight:1.5, marginBottom:16, textAlign:'center' }}>
              This rebuilds your local database to drop stale event history. Your groups, memberships, and settings stay intact. Events re-sync from each group's peers and local cache automatically.
            </div>
            <div style={{ display:'flex', gap:10 }}>
              <button onClick={() => setRebuildConfirm(false)} disabled={reclaimBusy}
                style={{ flex:1, padding:'10px 16px', borderRadius:8, border:`1px solid ${colors.border}`,
                  background:'transparent', color:colors.text.primary, fontFamily:FONT, fontSize:13, 
                  cursor: reclaimBusy ? 'wait' : 'pointer', opacity: reclaimBusy ? 0.5 : 1 }}>
                Cancel
              </button>
              <button data-haptic="medium" onClick={async () => {
                window.__pearSync?.haptic('medium')
                setReclaimBusy(true)
                setReclaimResult(null)
                try {
                  const r = await sync.rebuildLocalDb()
                  setReclaimResult(r)
                } catch (e) {
                  setReclaimResult({ error: e.message })
                } finally {
                  setReclaimBusy(false)
                  setRebuildConfirm(false)
                }
              }} disabled={reclaimBusy}
                style={{ flex:1, padding:'10px 16px', borderRadius:8, border:'none',
                  background: colors.primary, color: colors.text.onPrimary, fontFamily:FONT, fontSize:13, fontWeight:400,
                  cursor: reclaimBusy ? 'wait' : 'pointer', opacity: reclaimBusy ? 0.7 : 1 }}>
                {reclaimBusy ? 'Reclaiming…' : 'Reclaim'}
              </button>
            </div>
          </div>
        </div>
      )}
      {sweepReport && (
        <div onClick={() => !sweepBusy && (sweepResult ? (setSweepReport(null), setSweepResult(null)) : setSweepReport(null))}
          style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:1000,
            display:'flex', alignItems:'center', justifyContent:'center', padding:'24px' }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: colors.surface.card, borderRadius:14, padding:'20px', maxWidth:460, width:'100%',
              maxHeight:'80vh', overflowY:'auto', border:`1px solid ${colors.border}` }}>
            <div style={{ fontSize:16, fontWeight:400, marginBottom:10, textAlign:'center', color: colors.text.primary }}>
              {sweepResult ? 'Sweep Complete' : 'Sweep Orphaned Group Data?'}
            </div>
            {!sweepResult && (
              <>
                <div style={{ textAlign:'center', marginBottom:16 }}>
                  <div style={{ fontSize:28, color: colors.text.primary }}>{formatBytes(sweepReport.orphanBytes ?? 0)}</div>
                  <div style={{ fontSize:12, color:colors.text.muted }}>
                    across {sweepReport.orphans} orphan core{sweepReport.orphans === 1 ? '' : 's'}
                  </div>
                </div>
                <div style={{ fontSize:13, color:colors.text.muted, lineHeight:1.5, marginBottom:12 }}>
                  Cores belonging to groups you've left, deleted, or that were rekeyed.
                  They sit in <span style={{ fontFamily:'monospace' }}>pearcal/store</span> and aren't
                  freed by the normal Reclaim flow. Purging them is permanent.
                </div>
                <div style={{ fontSize:12, fontWeight:400, color:'#d04', background:'rgba(221,0,68,0.08)',
                  border:'1px solid rgba(221,0,68,0.3)', borderRadius:8, padding:'10px 12px', marginBottom:14, lineHeight:1.5 }}>
                  ⚠ Reports of sync breakage after sweeping. Some devices have been unable to join new groups afterward, requiring a reinstall. Cause under investigation. Only proceed if you understand the risk and have backups or can rebuild your data.
                </div>
                <div style={{ fontSize:12, color:colors.text.muted, marginBottom:14 }}>
                  Total cores on disk: {sweepReport.totalCores} · reachable: {sweepReport.reachableCount} · groups tracked: {sweepReport.groupCount}
                </div>
                {sweepReport.liveWithoutBase?.length > 0 && (
                  <div style={{ fontSize:12, color:'#d04', background:'rgba(221,0,68,0.08)',
                    border:'1px solid rgba(221,0,68,0.3)', borderRadius:8, padding:'10px 12px', marginBottom:14 }}>
                    ⚠ {sweepReport.liveWithoutBase.length} live group{sweepReport.liveWithoutBase.length === 1 ? '' : 's'} {sweepReport.liveWithoutBase.length === 1 ? 'is' : 'are'} not loaded yet
                    ({sweepReport.liveWithoutBase.join(', ')}).
                    Sweeping now could mistakenly purge their data. Open the group in the app first, then retry.
                  </div>
                )}
                {sweepReport.personalWithoutBase && (
                  <div style={{ fontSize:12, color:'#d04', background:'rgba(221,0,68,0.08)',
                    border:'1px solid rgba(221,0,68,0.3)', borderRadius:8, padding:'10px 12px', marginBottom:14 }}>
                    ⚠ Multi-device sync is configured but the personal data store hasn't loaded yet.
                    Sweeping now could mistakenly purge sibling-device data. Reopen the app and retry.
                  </div>
                )}
                <div style={{ display:'flex', gap:10 }}>
                  <button onClick={() => setSweepReport(null)} disabled={sweepBusy}
                    style={{ flex:1, padding:'10px 16px', borderRadius:8, border:`1px solid ${colors.border}`,
                      background:'transparent', color:colors.text.primary, fontFamily:FONT, fontSize:13, 
                      cursor: sweepBusy ? 'wait' : 'pointer', opacity: sweepBusy ? 0.5 : 1 }}>
                    Cancel
                  </button>
                  <button data-haptic="medium" onClick={async () => {
                    if (sweepReport.liveWithoutBase?.length > 0) return
                    if (sweepReport.personalWithoutBase) return
                    window.__pearSync?.haptic('medium')
                    setSweepBusy(true)
                    try {
                      const r = await sync.auditStorage({ purge: true })
                      setSweepResult(r)
                    } catch (e) {
                      setSweepResult({ error: e.message })
                    } finally {
                      setSweepBusy(false)
                    }
                  }} disabled={sweepBusy || sweepReport.orphans === 0 || sweepReport.liveWithoutBase?.length > 0 || sweepReport.personalWithoutBase}
                    style={{ flex:1, padding:'10px 16px', borderRadius:8, border:'none',
                      background: colors.primary, color: colors.text.onPrimary, fontFamily:FONT, fontSize:13, fontWeight:400,
                      cursor: sweepBusy ? 'wait' : 'pointer',
                      opacity: (sweepBusy || sweepReport.orphans === 0 || sweepReport.liveWithoutBase?.length > 0 || sweepReport.personalWithoutBase) ? 0.5 : 1 }}>
                    {sweepBusy ? 'Sweeping…' : sweepReport.orphans === 0 ? 'Nothing to sweep' : 'Purge'}
                  </button>
                </div>
              </>
            )}
            {sweepResult && (
              <>
                {sweepResult.error ? (
                  <div style={{ fontSize:13, color:'#d04', textAlign:'center', marginBottom:16 }}>
                    Error: {sweepResult.error}
                  </div>
                ) : (
                  <>
                    <div style={{ textAlign:'center', marginBottom:16 }}>
                      <div style={{ fontSize:28, color: colors.text.primary }}>
                        {formatBytes(sweepResult.reclaim?.freed ?? 0)}
                      </div>
                      <div style={{ fontSize:12, color:colors.text.muted }}>freed from disk</div>
                    </div>
                    <div style={{ fontSize:13, color:colors.text.muted, lineHeight:1.7, marginBottom:14 }}>
                      Purged {sweepResult.purged} core{sweepResult.purged === 1 ? '' : 's'}
                      {sweepResult.dataRangesCleared > 0 ? ` · cleared ${sweepResult.dataRangesCleared} data range${sweepResult.dataRangesCleared === 1 ? '' : 's'}` : ''}
                      {sweepResult.reclaim?.before !== undefined ? <><br />{formatBytes(sweepResult.reclaim.before)} → {formatBytes(sweepResult.reclaim.after)}</> : null}
                      {sweepResult.purgeErrors?.length > 0 ? <><br /><span style={{ color:'#d04' }}>{sweepResult.purgeErrors.length} error{sweepResult.purgeErrors.length === 1 ? '' : 's'} (first: {sweepResult.purgeErrors[0]})</span></> : null}
                    </div>
                  </>
                )}
                <button onClick={() => { setSweepReport(null); setSweepResult(null) }}
                  style={{ width:'100%', padding:'10px 16px', borderRadius:8,
                    border:`1px solid ${colors.border}`, background:'transparent', color:colors.text.primary,
                    fontFamily:FONT, fontSize:13, cursor:'pointer' }}>
                  Close
                </button>
              </>
            )}
          </div>
        </div>
      )}
      <div style={{ fontSize:11, color:colors.text.muted, letterSpacing:'0.08em', textAlign:'center', marginTop:16, marginBottom:8 }}>
        STORAGE
      </div>
      <div style={{ marginBottom:12 }}>
        <div style={{ padding:'14px 16px', display:'flex', flexDirection:'column', gap:8 }}>
        <button onClick={async () => {
          try {
            const b = await sync.storageBreakdown()
            setReclaimResult({ breakdown: b })
            setReportOpen('breakdown')
          } catch (e) { setReclaimResult({ error: e.message }) }
        }}
          style={{ display:'flex', alignItems:'center', gap:10, width:'100%',
            padding:'12px 14px', borderRadius:10, cursor:'pointer',
            border:`1px solid ${colors.border}`, background:'transparent', fontFamily:FONT }}>
          <div style={{ flex:1, textAlign:'left' }}>
            <div style={{ fontSize:14, color: colors.text.primary }}>Storage Breakdown</div>
            <div style={{ fontSize:11, color:colors.text.muted }}>Show where disk space is used</div>
          </div>
        </button>
        <button onClick={async () => {
          try {
            const a = await sync.analyzeStorage({ keepTail: 100 })
            setReclaimResult({ analyze: a })
            setReportOpen('analyze')
          } catch (e) { setReclaimResult({ error: e.message }) }
        }}
          style={{ display:'flex', alignItems:'center', gap:10, width:'100%',
            padding:'12px 14px', borderRadius:10, cursor:'pointer',
            border:`1px solid ${colors.border}`, background:'transparent', fontFamily:FONT }}>
          <div style={{ flex:1, textAlign:'left' }}>
            <div style={{ fontSize:14, color: colors.text.primary }}>Analyze Reclaimable</div>
            <div style={{ fontSize:11, color:colors.text.muted }}>Estimate reclaimable per group (keep last 100 blocks)</div>
          </div>
        </button>
        {/* Reclaim Storage hidden 2026-08-05, same treatment as Sweep Orphaned
            Data below. It rebuilds the local database, and a device that ends up
            missing blocks the SHARED history still references cannot recover on
            its own: the engine re-queues the unreadable dependency instead of
            fetching it, saturating the loop so hard that no peer connection ever
            completes, so it cannot even reach a blind seeder holding the data
            (#154, diagnosed on a real install 2026-08-05 - zero peers connected
            in 90s while a core burned). Repair currently needs an external tool.
            NOT known to have caused that incident: Tim reports never having used
            this feature, so the origin of those gaps is still unexplained. It is
            hidden because the downside is unrecoverable and the upside has
            largely gone - the main source of storage bloat was addressed
            elsewhere. Analyze Reclaimable above is read-only and stays.
            Re-enable once a device can heal a block gap by itself. */}
        {false && (() => {
          const pct = reclaimResult?.analyze?.pct ?? -1
          const enabled = !reclaimBusy && pct >= 21
          return (
            <button onClick={() => {
              if (!enabled) return
              setRebuildConfirm(true)
            }} disabled={!enabled}
              style={{ display:'flex', alignItems:'center', gap:10, width:'100%',
                padding:'12px 14px', borderRadius:10, cursor: enabled ? 'pointer' : 'not-allowed',
                border:`1px solid ${colors.border}`, background:'transparent', fontFamily:FONT,
                opacity: enabled ? 1 : 0.4 }}>
              <div style={{ flex:1, textAlign:'left' }}>
                <div style={{ fontSize:14, color: colors.text.primary }}>
                  {reclaimBusy ? 'Reclaiming…' : 'Reclaim Storage'}
                </div>
                <div style={{ fontSize:11, color:colors.text.muted }}>
                  {pct < 0
                    ? 'Run Analyze first to check reclaimable space'
                    : pct < 21
                      ? 'Not enough reclaimable space (need ≥ 21%; currently ' + pct + '%)'
                      : 'Rebuild local database to free ~' + pct + '% of storage'}
                </div>
              </div>
            </button>
          )
        })()}
        {/* Sweep Orphaned Data hidden — see PR #143. Reports of post-sweep
            "can't join new groups" failures (devices required reinstall).
            Root cause not yet identified; re-enable once auditStorage's
            reachability traversal and purgeOrphanDataRanges' live-dp set
            are hardened against blind-peer-mirrored / transitively-dependent
            cores. */}
        {false && (
          <button onClick={async () => {
            setSweepBusy(true)
            setSweepResult(null)
            try {
              const r = await sync.auditStorage({ purge: false })
              setSweepReport(r)
            } catch (e) {
              setSweepReport({ error: e.message, orphans: 0, orphanBytes: 0, totalCores: 0, reachableCount: 0, groupCount: 0 })
            } finally {
              setSweepBusy(false)
            }
          }} disabled={sweepBusy}
            style={{ display:'flex', alignItems:'center', gap:10, width:'100%',
              padding:'12px 14px', borderRadius:10, cursor: sweepBusy ? 'wait' : 'pointer',
              border:`1px solid ${colors.border}`, background:'transparent', fontFamily:FONT,
              opacity: sweepBusy ? 0.6 : 1 }}>
            <div style={{ flex:1, textAlign:'left' }}>
              <div style={{ fontSize:14, color: colors.text.primary }}>
                {sweepBusy && !sweepReport ? 'Scanning…' : 'Sweep Orphaned Data'}
              </div>
              <div style={{ fontSize:11, color:colors.text.muted }}>
                Purge cores from deleted / left groups (shows report first)
              </div>
            </div>
          </button>
        )}
        {reclaimResult?.analyze && (
          <div style={{ fontSize:12, color:colors.text.muted, textAlign:'center', padding:'4px 0' }}>
            {reclaimResult.analyze.pct}% reclaimable — tap Reclaim below to continue
          </div>
        )}
        {reclaimResult?.error && (
          <div style={{ fontSize:12, color:'#d04', textAlign:'center', padding:'4px 0' }}>
            Error: {reclaimResult.error}
          </div>
        )}
        {reclaimResult?.freed !== undefined && (
          <div style={{ fontSize:12, color:colors.text.muted, textAlign:'center', padding:'4px 0' }}>
            Freed {formatBytes(reclaimResult.freed)} ({formatBytes(reclaimResult.before)} → {formatBytes(reclaimResult.after)})
          </div>
        )}
        </div>
      </div>

      <div style={{ fontSize:11, color:colors.text.muted, letterSpacing:'0.08em', textAlign:'center', marginTop:16, marginBottom:8 }}>
        RESET
      </div>
      <div style={{ marginBottom:12 }}>
        <div style={{ padding:'14px 16px' }}>
          <button onClick={() => {
            setResetMode(null); setResetTyped(''); setResetError(null)
            setResetSheet(true)
          }}
            style={{ display:'flex', alignItems:'center', gap:10, width:'100%',
              padding:'12px 14px', borderRadius:10, cursor:'pointer',
              border:`1px solid ${colors.border}`, background:'transparent', fontFamily:FONT }}>
            <div style={{ flex:1, textAlign:'left' }}>
              <div style={{ fontSize:14, color:'#d04' }}>Reset app data</div>
              <div style={{ fontSize:11, color:colors.text.muted }}>
                Clear this device's calendar and groups, and optionally start over as a new user
              </div>
            </div>
          </button>
        </div>
      </div>

      {resetSheet && (
        <BottomSheet closeRef={closeResetSheetRef}
          onClose={() => { if (!resetBusy) { setResetSheet(false); setResetMode(null) } }}>
          <div style={{ padding:'0 20px 20px' }}>
            <div style={{ fontSize:17, color:colors.text.primary, marginBottom:6 }}>
              {resetMode === null ? 'Reset app data'
                : resetMode === 'keep' ? 'Clear calendar and groups?'
                : 'Start over as a new user?'}
            </div>

            {resetMode === null && (
              <>
                <div style={{ fontSize:13, color:colors.text.muted, lineHeight:1.55, marginBottom:16 }}>
                  Both options clear this device. Only the second one tells anybody else.
                </div>
                <button onClick={() => { setResetMode('keep'); setResetError(null) }}
                  style={{ display:'block', width:'100%', textAlign:'left', marginBottom:10,
                    padding:'14px 16px', borderRadius:12, cursor:'pointer',
                    border:`1px solid ${colors.border}`, background:'transparent', fontFamily:FONT }}>
                  <div style={{ fontSize:14, color:colors.text.primary, marginBottom:3 }}>Clear calendar and groups</div>
                  <div style={{ fontSize:12, color:colors.text.muted, lineHeight:1.5 }}>
                    You stay the same person. Your events and groups are removed from this
                    device, and you can rejoin a group with its invite link to get everything back.
                  </div>
                </button>
                <button onClick={() => { setResetMode('full'); setResetError(null) }}
                  style={{ display:'block', width:'100%', textAlign:'left',
                    padding:'14px 16px', borderRadius:12, cursor:'pointer',
                    border:'1px solid #d04', background:'transparent', fontFamily:FONT }}>
                  <div style={{ fontSize:14, color:'#d04', marginBottom:3 }}>Start over as a new user</div>
                  <div style={{ fontSize:12, color:colors.text.muted, lineHeight:1.5 }}>
                    Everything above, and this device stops being you. It gets a brand new
                    identity, with no way back to the account you are using now. You also leave
                    every group, so you stop showing in their member lists. Groups you run are
                    handed to another member, or deleted if you are the only one in them.
                  </div>
                </button>
              </>
            )}

            {resetMode === 'keep' && (
              <div style={{ fontSize:13, color:colors.text.muted, lineHeight:1.55, marginBottom:16 }}>
                Your events and groups will be removed from this device. You stay signed in
                as yourself and keep your name, so you can rejoin any group with its invite
                link and your calendar comes back from the other members. Nobody else is told,
                and you stay in their member lists.
              </div>
            )}

            {resetMode === 'full' && (
              <>
                <div style={{ fontSize:13, color:colors.text.muted, lineHeight:1.55, marginBottom:14 }}>
                  This device stops being you. It gets a brand new identity, so there is no way
                  back to the account you are using now, and anything only this device was
                  holding is gone for good. You will also leave every group you are in, and any
                  group you run is handed to another member or deleted if nobody else is in it.
                </div>
                {/* The departure only reaches peers connected at that moment: the
                    durable pending-leave record lives in the database the reset is
                    about to delete, so there is no second attempt. Say so plainly
                    here rather than let a member discover it by still seeing a
                    person who left. */}
                <div style={{ fontSize:12, color:colors.text.muted, lineHeight:1.55, marginBottom:14,
                  padding:'11px 13px', borderRadius:10, border:`1px solid ${colors.border}` }}>
                  <span style={{ color:colors.text.primary }}>One thing to know:</span> leaving
                  only reaches people who have the app open at that moment. Anyone offline may
                  still see you in their group's member list, and once your data is gone there is
                  no way to tell them. If that matters, leave your groups by hand first, while
                  the other members are around.
                </div>
                <div style={{ fontSize:12, color:colors.text.muted, marginBottom:6 }}>
                  Type RESET to confirm
                </div>
                <input value={resetTyped} onChange={e => setResetTyped(e.target.value)}
                  autoCapitalize="characters" autoCorrect="off" spellCheck={false}
                  style={{ width:'100%', boxSizing:'border-box', padding:'11px 14px', borderRadius:10,
                    marginBottom:14, border:`1px solid ${colors.border}`, background:'transparent',
                    color:colors.text.primary, fontFamily:FONT, fontSize:14 }} />
              </>
            )}

            {resetError && (
              <div style={{ fontSize:12, color:'#d04', lineHeight:1.5, marginBottom:12 }}>
                {resetError}
              </div>
            )}

            {resetMode !== null && (
              <div style={{ display:'flex', gap:10 }}>
                <button onClick={() => { setResetMode(null); setResetTyped(''); setResetError(null) }}
                  disabled={resetBusy}
                  style={{ flex:1, padding:'12px 16px', borderRadius:10, border:`1px solid ${colors.border}`,
                    background:'transparent', color:colors.text.primary, fontFamily:FONT, fontSize:14,
                    cursor: resetBusy ? 'wait' : 'pointer', opacity: resetBusy ? 0.5 : 1 }}>
                  Back
                </button>
                <button data-haptic="medium"
                  disabled={resetBusy || (resetMode === 'full' && resetTyped.trim().toUpperCase() !== 'RESET')}
                  onClick={async () => {
                    window.__pearSync?.haptic('medium')
                    setResetBusy(true); setResetError(null)
                    try {
                      // The shell reloads (mobile) or relaunches (desktop) when
                      // this lands, so there is no success state to render here.
                      await sync.resetAppData({ keepIdentity: resetMode === 'keep' })
                    } catch (e) {
                      setResetError(e.message)
                      setResetBusy(false)
                    }
                  }}
                  style={{ flex:1, padding:'12px 16px', borderRadius:10, border:'none',
                    background:'#d04', color:'#fff', fontFamily:FONT, fontSize:14,
                    cursor: resetBusy ? 'wait' : 'pointer',
                    opacity: (resetBusy || (resetMode === 'full' && resetTyped.trim().toUpperCase() !== 'RESET')) ? 0.5 : 1 }}>
                  {resetBusy ? 'Resetting…' : resetMode === 'keep' ? 'Clear it' : 'Delete everything'}
                </button>
              </div>
            )}
          </div>
        </BottomSheet>
      )}

      {icsImport && (
        <ImportIcsSheet events={icsImport.events} filename={icsImport.filename}
          groups={groups}
          existingEventIds={new Set((events ?? []).map(e => e.id))}
          onImport={(toImport) => {
            if (!saveEvent) return
            for (const r of toImport) {
              const { ev, uid, keptGroups } = r
              const id = uid || ('e' + Date.now() + '-' + Math.random().toString(36).slice(2, 7))
              // Pick color from first matched group if available
              const firstGroup = keptGroups.length
                ? (groups ?? []).find(g => g.id === keptGroups[0])
                : null
              saveEvent({
                id, title: ev.title, date: ev.date,
                allDay: ev.allDay ?? true, start: ev.start ?? '', end: ev.end ?? '',
                endDate: ev.endDate ?? '', desc: ev.desc ?? '', location: ev.location ?? '',
                meetingLink: ev.meetingLink ?? '',
                groups: keptGroups, invitees: [],
                color: firstGroup?.color ?? '#6C9BF5', colors: [], reminder: 0,
                recurrence: 'none', recurrenceId: '', recurrenceEnd: '',
                recurrenceNth: 0, recurrenceWeekday: 0,
                editPermission: 'everyone', creatorId: profile?.id ?? '',
              }, 'one', {}, [])
            }
            setIcsImport(null)
          }}
          onClose={() => setIcsImport(null)} />
      )}

      </div>

      {pairHost && (
        <PairingHostModal data={pairHost} error={pairHostError}
          onRegenerate={async () => { await cancelDevicePairing(); startDevicePairing() }}
          onCancel={cancelDevicePairing} />
      )}
      {blindPeerOpen && (
        <BlindPeerSheet db={db} sync={sync} qrScanModeRef={qrScanModeRef} onClose={() => setBlindPeerOpen(false)} />
      )}
    </div>
  )
}
