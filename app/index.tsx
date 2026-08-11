import { useState, useEffect, useRef, useCallback } from 'react'

// Suppress non-fatal Bare runtime errors in dev mode
const originalHandler = (global as any).ErrorUtils?.getGlobalHandler?.()
;(global as any).ErrorUtils?.setGlobalHandler?.((error: any, isFatal: boolean) => {
  if (!isFatal && error?.message?.includes('keep awake')) return
  originalHandler?.(error, isFatal)
})
import { View, Text, StyleSheet, NativeModules, Platform, BackHandler, AppState, Animated, Easing, DeviceEventEmitter } from 'react-native'
import { WebView } from 'react-native-webview'
import { Worklet } from 'react-native-bare-kit'
import b4a from 'b4a'
import { Asset } from 'expo-asset'
import Constants from 'expo-constants'
import * as FileSystem from 'expo-file-system/legacy'
import * as SecureStore from 'expo-secure-store'
import * as Clipboard from 'expo-clipboard'
import { requestLocalNetworkPermission } from '../modules/local-network'

const { PearCalNotifications } = NativeModules
const { PearCalShare } = NativeModules
const { PearCalQRScanner } = NativeModules
const { PearCalCamera } = NativeModules
const { PearCalHaptic } = NativeModules
const { PearCalDeepLink } = NativeModules
const { PearCalBGSync } = NativeModules
const { PearCalBlockStore } = NativeModules
const { PearCalICloudKeychain } = NativeModules
// GrapheneOS/Vanadium WebView resume-freeze recovery (WEBVIEW_FREEZE_FIX_PORT.md).
// Android's cached-app freezer freezes the out-of-process Vanadium renderer while
// we're backgrounded; after the 2026-07-19 Vanadium 151 update its compositor
// never re-attaches to the new window surface on resume, so the screen never
// repaints even though JS, input and haptics all still work. Only a FRESH render
// process recovers it — a view-remount just rebinds the same pooled stale one.
const { WebViewRecovery } = NativeModules
// Shared by two consumers: the Android renderer recovery below, and the worklet's
// foreground swarm rebuild, which needs to know whether we were away long enough
// for the peer connections to have died.
let _backgroundedAt = 0
// Returning after a short background is fine and reloading then would be a
// gratuitous ~1-2s flash, so only recover after a background long enough for the
// freezer to have actually kicked in. Tunable up if it feels eager.
const WEBVIEW_RECOVERY_MIN_BG_MS = 20_000

const { makeStartLock } = require('../src/lib/backendBootstrap')
const { buildInviteInjection } = require('../src/lib/inviteDelivery')
const { createEventRegistry } = require('../src/lib/eventRegistry')
const {
  createSyncNotifyState, decideSyncNotify, contentId, contentKey,
  SUMMARY_ID: SYNC_SUMMARY_ID,
} = require('../src/lib/syncNotifyPolicy')

let _worklet: any = null
let _workletStarted = false
let _ensureWorkletStarted: null | (() => Promise<any>) = null
let _terminateTimer: any = null                 // pending delayed terminate from a prior Activity teardown
let _notifyReady: null | (() => void) = null    // current mount's dbReady setter (routes 'ready' to the live component)
let _remountWebView: null | (() => void) = null  // current mount's WebView remounter (routes 'appDataReset' to the live component)
let _nextId = 1
const _pending = new Map<number, (msg: any) => void>()
// Module-level, so it outlives any single mount. See src/lib/eventRegistry.js
// for why that lifetime mismatch mattered (TODO #126).
const _events = createEventRegistry()

function onEvent (event: string, fn: (data: any) => void) {
  _events.on(event, fn)
}

function sendToWorklet (msg: object) {
  _worklet?.IPC.write(b4a.from(JSON.stringify(msg) + '\n'))
}

const MNEMONIC_KEY = 'pearcal.identity.mnemonic'
// Set once the legacy cloud copy has been scrubbed; see scrubLegacyCloudBackup.
const CLOUD_SCRUBBED_KEY = 'pearcal.identity.cloudScrubbed'

// The seed phrase is NOT a user-facing feature. It is the seed the device
// identity derives from - profile.id, group.ownerId, writer proofs and
// multi-device pairing all come off it - and it is never shown, exported or
// uploaded. The reveal / copy / export / backup-toggle surfaces were removed
// 2026-07-27; what remains here is local storage of the seed, plus a one-time
// scrub of the cloud copies the old backup feature left behind.
const platformBackup: any = Platform.OS === 'ios' ? PearCalICloudKeychain : PearCalBlockStore

async function platformIsAvailable (): Promise<boolean> {
  if (!platformBackup?.isAvailable) return false
  try { return !!(await platformBackup.isAvailable()) } catch { return false }
}

async function platformReadMnemonic (): Promise<string | null> {
  if (!platformBackup?.readMnemonic) return null
  try { return (await platformBackup.readMnemonic()) ?? null } catch { return null }
}

async function platformDeleteMnemonic (): Promise<boolean> {
  if (!platformBackup?.deleteMnemonic) return false
  try { return !!(await platformBackup.deleteMnemonic()) } catch { return false }
}

// One-time cleanup for installs that ran the old backup feature.
//
// Backup defaulted to ON and had no reachable toggle, so every device that ever
// generated a seed also uploaded it to iCloud Keychain or Google Block Store.
// Removing the feature without this would leave those copies sitting there for
// good, which is the one outcome the removal is meant to prevent - a Block Store
// entry survives until it is explicitly deleted, and an iCloud Keychain item
// persists indefinitely.
//
// Best-effort and idempotent: it records a flag so it runs once, and a failure
// simply leaves the flag unset so the next launch tries again. Fire-and-forget,
// because nothing about starting the app depends on it.
//
// These native modules exist ONLY for this scrub now. Once installs have rolled
// past this release they can be deleted outright, along with
// modules/PearCalBlockStore + ios/PearCal/ICloudKeychain.*.
async function scrubLegacyCloudBackup (): Promise<void> {
  try {
    if (await SecureStore.getItemAsync(CLOUD_SCRUBBED_KEY)) return
    if (!(await platformIsAvailable())) {
      // No backend to scrub on this device (no Play Services, or desktop).
      // Nothing was ever uploaded, so mark it done rather than retry forever.
      await SecureStore.setItemAsync(CLOUD_SCRUBBED_KEY, '1')
      return
    }
    const existing = await platformReadMnemonic()
    if (existing) {
      await platformDeleteMnemonic()
      // Confirm by read-back: the two backends disagree about what a successful
      // delete returns, so the only trustworthy signal is whether it is gone.
      if (await platformReadMnemonic()) {
        console.warn('[identity] legacy cloud seed copy could not be removed; will retry next launch')
        return
      }
      console.log('[identity] removed the legacy cloud backup of the seed phrase')
    }
    await SecureStore.setItemAsync(CLOUD_SCRUBBED_KEY, '1')
  } catch (e: any) {
    console.warn('[identity] cloud scrub failed, will retry next launch:', e?.message ?? e)
  }
}

async function localSetMnemonic (value: string): Promise<void> {
  await SecureStore.setItemAsync(MNEMONIC_KEY, value, {
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  })
}

async function handleNativeRequest (msg: any) {
  const { nativeId, method, args = [] } = msg
  try {
    let result: any = null
    switch (method) {
      // The seed lives ONLY in this device's secure store. It used to be mirrored
      // to iCloud Keychain / Google Block Store and read back from there, which
      // meant a seed phrase sat in Apple's or Google's cloud for a feature the
      // user could not see, enable or disable. Removed 2026-07-27; see
      // scrubLegacyCloudBackup for the cleanup of copies already uploaded.
      case 'hasMnemonic': {
        result = !!(await SecureStore.getItemAsync(MNEMONIC_KEY))
        break
      }
      case 'getMnemonic': {
        result = await SecureStore.getItemAsync(MNEMONIC_KEY)
        break
      }
      case 'setMnemonic': {
        const value = args[0]
        if (typeof value !== 'string' || value.length === 0) {
          throw new Error('setMnemonic: value must be a non-empty string')
        }
        await localSetMnemonic(value)
        result = true
        break
      }
      case 'deleteMnemonic': {
        // Full reset (TODO #118). Nothing mirrors the seed to the cloud any more,
        // but an install that predates that removal may still have a copy up
        // there, and leaving it would hand the same identity back on the next
        // boot - making a full reset no reset at all. So the platform copy is
        // cleared here too, and confirmed by READ-BACK: the two backends
        // disagree about what a successful delete returns, so the only
        // trustworthy signal is whether the seed is still recoverable.
        await SecureStore.deleteItemAsync(MNEMONIC_KEY).catch(() => {})
        if (await platformIsAvailable()) {
          await platformDeleteMnemonic()
          if (await platformReadMnemonic()) {
            throw new Error('the cloud copy of the seed could not be removed')
          }
        }
        result = true
        break
      }
      default:
        throw new Error('Unknown native request: ' + method)
    }
    sendToWorklet({ type: 'nativeResponse', nativeId, result })
  } catch (e: any) {
    sendToWorklet({ type: 'nativeResponse', nativeId, error: e?.message ?? String(e) })
  }
}

function notifId (eventId: string): number {
  let h = 0
  for (const c of eventId) h = (Math.imul(31, h) + c.charCodeAt(0)) | 0
  return Math.abs(h)
}

// Format a "HH:mm" 24-hour time string as 12-hour with am/pm (e.g. "9:30am").
// Mirrors the bare-side formatTime helper — keeps notification copy consistent
// across the scheduler (RN) and sync-change notifications (bare).
function formatTime12h (t: string | undefined): string {
  if (!t) return ''
  const [hStr, mStr] = t.split(':')
  const h = parseInt(hStr, 10)
  if (isNaN(h)) return t
  const ampm = h >= 12 ? 'pm' : 'am'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return h12 + ':' + (mStr ?? '00') + ampm
}

const MORNING_DIGEST_BASE = 900000
const MORNING_DIGEST_SLOTS = 3

// Top-K reminder/start-time alarm slots (TODO #82 Phase 2). Reserves a fixed
// numeric range so reconciliation is a straight cancel-then-schedule over
// the same IDs every pass — no per-event ID bookkeeping needed. iOS caps
// pending local notifications at 64; we keep K=50 to leave headroom for the
// digest (3 slots) plus ad-hoc.
const TOPK_SCHEDULER_BASE = 800000
const TOPK_SCHEDULER_SLOTS = 50

// Serialize reconcileSchedule passes. Without this, two concurrent IPC
// messages each cancel-then-schedule the same fixed-id range and can
// interleave — the second pass's cancel runs while the first is still
// scheduling, leaving stale alarms armed in the range.
let _reconcileChain: Promise<void> = Promise.resolve()

// Coalesce syncNotify bursts. When the phone wakes on charger overnight, Autobase
// catch-up applies N buffered remote changes at once and each emits a syncNotify →
// postNow → a separate local notification. Without a window the user wakes to a
// flood. Buffer within a fixed window and collapse >1 into a single summary.
const SYNC_NOTIFY_COALESCE_MS = 5000
let _syncNotifyBuffer: Array<{ title: string, body: string, tab: string, groupSettingsId?: string }> = []
let _syncNotifyTimer: any = null
// Timer-free policy state for anything posted OUTSIDE the foreground buffer
// (TODO #128). See src/lib/syncNotifyPolicy.js for why it cannot use a timer.
const _syncNotifyState = createSyncNotifyState()

function postSyncNotification (opts: any) {
  PearCalNotifications?.postNow?.(opts).catch?.(() => {})
}

function flushSyncNotify () {
  _syncNotifyTimer = null
  const buf = _syncNotifyBuffer
  _syncNotifyBuffer = []
  if (buf.length === 0) return
  if (buf.length === 1) {
    const { title, body, tab, groupSettingsId } = buf[0]
    // Content-derived id, so an identical repeat REPLACES rather than stacks.
    postSyncNotification({ id: contentId(contentKey(title, body)), title, body, tab, groupSettingsId })
    return
  }
  postSyncNotification({
    id: SYNC_SUMMARY_ID,
    title: 'Calendar updated',
    body: buf.length + ' changes',
    tab: buf[0].tab || 'calendar',
  })
}

function queueSyncNotify (data: any) {
  // Foreground: buffer and coalesce on a timer. Safe here because JS timers run
  // while the app is active. Unchanged behaviour.
  if (AppState.currentState === 'active' && !data?.immediate) {
    _syncNotifyBuffer.push({
      title: data?.title ?? 'Calendar updated',
      body:  data?.body  ?? '',
      tab:   data?.tab   ?? '',
      groupSettingsId: data?.groupSettingsId,
    })
    if (!_syncNotifyTimer) {
      _syncNotifyTimer = setTimeout(flushSyncNotify, SYNC_NOTIFY_COALESCE_MS)
    }
    return
  }
  // Backgrounded, or a one-off important alert. A deferred flush would never run
  // here: RN freezes JS timers while the app is backgrounded, so the flush only
  // happens once the app is foregrounded again, which is why background sync
  // notifications used to not fire at all (#100). Measured 2026-07-23 on a Pixel
  // 9 Pro: a 3s timer scheduled at background time had still not fired after 12s
  // and only ran on resume. So post synchronously.
  //
  // But posting synchronously per event is what turned an overnight catch-up
  // into a wall of notifications, because the flood guard above is skipped
  // entirely. Route through the timer-free policy instead, which suppresses
  // exact repeats and collapses a burst into one summary that updates in place
  // (TODO #128).
  if (_syncNotifyTimer) { clearTimeout(_syncNotifyTimer); _syncNotifyTimer = null }
  // Don't strand anything the foreground path had already buffered.
  flushSyncNotify()
  const decision = decideSyncNotify(data, _syncNotifyState, Date.now())
  if (!decision.post) return
  postSyncNotification({
    id: decision.id,
    title: decision.title,
    body: decision.body,
    tab: decision.tab,
    groupSettingsId: decision.groupSettingsId,
  })
}

function calcFireTime (event: any): number | null {
  const [y, mo, d] = event.date.split('-').map(Number)
  let h = 9, m = 0
  if (!event.allDay && event.start) {
    const parts = event.start.split(':').map(Number)
    h = parts[0]; m = parts[1]
  }
  return new Date(y, mo - 1, d, h, m, 0, 0).getTime() - event.reminder * 60 * 1000
}

function calcReminderFireTime (ev: any, reminder: number): number | null {
  const [y, mo, d] = ev.date.split('-').map(Number)
  if (reminder === -1) {
    // MORNING_OF: 9 AM on the event date
    return new Date(y, mo - 1, d, 9, 0, 0, 0).getTime()
  }
  if (reminder === -2) {
    // DAY_BEFORE: 9 AM the day before
    return new Date(y, mo - 1, d - 1, 9, 0, 0, 0).getTime()
  }
  // Positive offset: minutes before event start (all-day uses 9 AM as base)
  let h = 9, m = 0
  if (!ev.allDay && ev.start) {
    const parts = ev.start.split(':').map(Number)
    h = parts[0]; m = parts[1]
  }
  const eventStartMs = new Date(y, mo - 1, d, h, m, 0, 0).getTime()
  return eventStartMs - reminder * 60 * 1000
}

async function handleNotification (msg: any, webViewRef: any) {
  try {
    if (msg.method === 'scheduleForEvent') {
      const ev       = msg.args[0]
      const reminders: number[] = msg.args[1] ?? []
      if (ev) {
        const base = notifId(ev.id)

        // Cancel all 4 slots first (3 reminder slots + 1 start-time slot)
        for (let i = 0; i < 4; i++) {
          await PearCalNotifications?.cancel?.(base + i).catch(() => {})
        }

        // Schedule up to 3 reminder alarms
        const OPTION_LABELS: Record<string, string> = {
          '5': '5 min', '10': '10 min', '15': '15 min', '30': '30 min',
          '60': '1 hr', '120': '2 hrs', '1440': '1 day',
          '10080': '1 wk', '20160': '2 wk',
          '-1': 'Morning of', '-2': 'Day before',
        }
        // Custom intervals (TODO #83 Part B) — fall back to a derived
        // short form like "3 day" / "90 min" instead of the raw `${n}min`.
        function deriveLabel (m: number): string {
          if (!Number.isFinite(m) || m <= 0) return ''
          if (m % 10080 === 0) { const w = m / 10080; return w + (w === 1 ? ' wk' : ' wks') }
          if (m % 1440 === 0)  { const d = m / 1440;  return d + (d === 1 ? ' day' : ' days') }
          if (m % 60 === 0)    { const h = m / 60;    return h + (h === 1 ? ' hr' : ' hrs') }
          return m + ' min'
        }
        for (let i = 0; i < Math.min(reminders.length, 3); i++) {
          const reminder = reminders[i]
          const fireAt = calcReminderFireTime(ev, reminder)
          if (!fireAt || fireAt <= Date.now()) continue
          const label = OPTION_LABELS[String(reminder)] ?? deriveLabel(reminder)
          const body = ev.allDay
            ? 'All day · ' + label
            : label + ' · ' + formatTime12h(ev.start) + '–' + formatTime12h(ev.end)
          try {
            await PearCalNotifications?.schedule?.({
              id:      base + i,
              title:   ev.title,
              body,
              fireAt,
              eventId: ev.id,
              tab:     'calendar',
            })
          } catch (schedErr: any) {
            console.log('Reminder alarm error (non-fatal):', schedErr?.message)
          }
        }

        // Schedule start-time alarm at slot base+3 (non-all-day only)
        if (!ev.allDay && ev.start) {
          const [y, mo, d] = ev.date.split('-').map(Number)
          const [h, m2] = ev.start.split(':').map(Number)
          const startFireAt = new Date(y, mo - 1, d, h, m2, 0, 0).getTime()
          if (startFireAt > Date.now()) {
            try {
              await PearCalNotifications?.schedule?.({
                id:      base + 3,
                title:   ev.title + ' is starting now',
                body:    formatTime12h(ev.start) + ' to ' + formatTime12h(ev.end),
                fireAt:  startFireAt,
                eventId: ev.id,
                tab:     'calendar',
              })
            } catch (schedErr: any) {
              console.log('Start alarm error (non-fatal):', schedErr?.message)
            }
          }
        }
      }
    } else if (msg.method === 'cancelForEvent') {
      const base = notifId(msg.args[0])
      for (let i = 0; i < 4; i++) {
        await PearCalNotifications?.cancel?.(base + i).catch(() => {})
      }
    } else if (msg.method === 'reconcileSchedule') {
      // Top-K next-firings reconcile (TODO #82 Phase 2). Triples come from
      // the worklet's `computeUpcomingReminders(K)` already sorted ascending
      // by fireAt. Schedule into a fixed ID range so cancellation is just a
      // tight loop over the same range; iOS's 64-slot quota stays honored
      // regardless of how many recurring-series occurrences exist.
      //
      // Chained off `_reconcileChain` so two concurrent calls serialize.
      const triples: any[] = msg.args?.[0] ?? []
      _reconcileChain = _reconcileChain.then(async () => {
        for (let i = 0; i < TOPK_SCHEDULER_SLOTS; i++) {
          await PearCalNotifications?.cancel?.(TOPK_SCHEDULER_BASE + i).catch(() => {})
        }
        const now = Date.now()
        for (let i = 0; i < Math.min(triples.length, TOPK_SCHEDULER_SLOTS); i++) {
          const t = triples[i]
          if (!t || !t.fireAt || t.fireAt <= now) continue
          try {
            await PearCalNotifications?.schedule?.({
              id:      TOPK_SCHEDULER_BASE + i,
              title:   t.title ?? '',
              body:    t.body ?? '',
              fireAt:  t.fireAt,
              eventId: t.eventId ?? '',
              tab:     t.tab ?? 'calendar',
            })
          } catch (e: any) {
            console.log('Top-K reminder schedule error (non-fatal):', e?.message)
          }
        }
      }).catch(() => {})
      await _reconcileChain
    }
    webViewRef.current?.injectJavaScript(
      'window.__pearResponse(' + JSON.stringify({ id: msg.id, result: null }) + ');true;'
    )
  } catch (e: any) {
    webViewRef.current?.injectJavaScript(
      'window.__pearResponse(' + JSON.stringify({ id: msg.id, error: e.message }) + ');true;'
    )
  }
}

function buildHtml (appBundleJs: string): string {
  // Prefer the NATIVE app version (Android versionName / iOS
  // CFBundleShortVersionString) so the About page always matches the installed
  // binary. The app.json require is baked into the JS bundle at Metro-bundle
  // time and can lag the native version by a release when Metro reuses a cached
  // app.json (the 1.0.32-on-a-1.0.33-build bug). Fall back to app.json where the
  // native value is unavailable (e.g. web).
  const APP_VERSION: string =
    Constants.nativeApplicationVersion || (require('../app.json') as any).expo.version
  const html = [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="UTF-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no, viewport-fit=cover" />',
    '<style>',
    '* { box-sizing: border-box; margin: 0; padding: 0; }',
    'html, body, #root { height: 100dvh; width: 100%; overflow: hidden; }',
    ':root { --sat: env(safe-area-inset-top); --sab: env(safe-area-inset-bottom); }',
    '</style>',
    '<script>window.__PEARCAL_VERSION__="' + APP_VERSION + '"</script>',
    '</head>',
    '<body>',
    '<div id="root"></div>',
    '<script>' + appBundleJs + '</script>',
    '</body>',
    '</html>',
  ]
  return html.join('\n')
}

export default function Root () {
  const [dbReady,      setDbReady]      = useState(false)
  const [webViewReady, setWebViewReady] = useState(false)
  // Bumped to force a fresh WebView after a reset wipes the data underneath
  // it; used as the component key so React drops the old tree entirely.
  const [webViewEpoch, setWebViewEpoch] = useState(0)
  const [error,        setError]        = useState<string | null>(null)
  const [html,         setHtml]         = useState<string | null>(null)
  const [pendingInvite, setPendingInvite] = useState<string | null>(null)
  const webViewRef = useRef<any>(null)
  const dbReadyRef = useRef(false)

  // Poll for pending tab navigation (from notification taps)
  useEffect(() => {
    if (!dbReady || !webViewReady) return
    const { PearCalLink } = NativeModules
    if (!PearCalLink) return
    const interval = setInterval(async () => {
      try {
        const tab = await PearCalLink.getPendingTab()
        if (tab && webViewRef.current) {
          webViewRef.current.injectJavaScript(
            `if(window.__pearSetTab) { window.__pearSetTab(${JSON.stringify(tab)}); } true;`
          )
        }
        if (PearCalLink.getPendingGroupSettingsId) {
          const gid = await PearCalLink.getPendingGroupSettingsId()
          if (gid && webViewRef.current) {
            webViewRef.current.injectJavaScript(
              `if(window.__pearOpenGroupSettings) { window.__pearOpenGroupSettings(${JSON.stringify(gid)}); } true;`
            )
          }
        }
      } catch(e) {}
    }, 1000)
    return () => clearInterval(interval)
  }, [dbReady, webViewReady])

  // Poll for pending invite links every 2 seconds
  useEffect(() => {
    if (!dbReady) return
    const { PearCalLink } = NativeModules
    if (!PearCalLink) return
    const interval = setInterval(async () => {
      try {
        const link = await PearCalLink.getPendingLink()
        if (link) {
          setPendingInvite(link)
        }
      } catch(e) {}
    }, 2000)
    return () => clearInterval(interval)
  }, [dbReady])

  // Reconcile alarms when the device's timezone changes. Events are stored as
  // wall-clock (date + "HH:mm") and turned into absolute UTC ms at schedule time
  // via `new Date(y,mo,d,h,m).getTime()` — that math is TZ-sensitive, so a
  // pending AlarmManager alarm armed in one zone fires at the wrong wall-clock
  // after the user crosses zones. Android NotificationsModule emits this event
  // on ACTION_TIMEZONE_CHANGED / ACTION_TIME_CHANGED.
  useEffect(() => {
    if (!dbReady || !webViewReady) return
    const sub = DeviceEventEmitter.addListener('pearcalTimezoneChanged', () => {
      webViewRef.current?.injectJavaScript(
        'if (window.__pearOnTimezoneChange) { window.__pearOnTimezoneChange(); } true;'
      )
    })
    return () => sub.remove()
  }, [dbReady, webViewReady])

  // Inject pending invite link when WebView, DB, and WebView DOM are all ready.
  // Device-pair URLs (pearcal://pair?...) bypass the WebView and go straight to
  // the bare worklet — pairing is backend-only in PR #B (no UI surface yet).
  useEffect(() => {
    if (pendingInvite && dbReady && webViewReady && webViewRef.current) {
      const url = pendingInvite
      setPendingInvite(null)
      if (url.startsWith('pearcal://pair') || url.startsWith('pear://pearcal/pair')) {
        const bareId = _nextId++
        _pending.set(bareId, () => {})
        sendToWorklet({ method: 'consumePairLink', args: [url], id: bareId })
        return
      }
      // TODO #148 - this used to be `if(window.__pearHandleInvite){…}`, which is
      // a SILENT no-op when the WebView's DOM has loaded but its bundle has not
      // run yet. By this point the link is already gone from native
      // (getPendingLink nulls it on read) and from React state (cleared just
      // above), so the invite was simply lost and the join sheet never appeared.
      // buildInviteInjection parks it on `window` instead, and the bundle drains
      // it the moment it defines the handler.
      webViewRef.current?.injectJavaScript(buildInviteInjection(url))
    }
  }, [pendingInvite, dbReady, webViewReady])

  const onWebViewMessage = useCallback((e: any) => {
    try {
      const msg = JSON.parse(e.nativeEvent.data)

      if (['scheduleForEvent', 'cancelForEvent', 'restoreAll', 'reconcileSchedule'].includes(msg.method)) {
        handleNotification(msg, webViewRef)
        return
      }
      if (msg.method === 'exitApp') { if (Platform.OS === 'android') BackHandler.exitApp(); return }
      if (msg.method === 'haptic') { PearCalHaptic?.impact?.(msg.args?.[0] ?? 'light'); return }
      if (msg.method === 'openURL') {
        PearCalDeepLink?.openURL?.(msg.args?.[0] ?? '').catch?.(() => {})
        return
      }
      if (msg.method === 'canOpenLightning') {
        PearCalDeepLink?.canOpenLightning?.().then((can: boolean) => {
          webViewRef.current?.injectJavaScript(
            'window.__pearEvent("canOpenLightning",' + JSON.stringify(can) + ');true;'
          )
        }).catch(() => {
          webViewRef.current?.injectJavaScript('window.__pearEvent("canOpenLightning",false);true;')
        })
        return
      }
      if (msg.method === 'openLightning') {
        PearCalDeepLink?.openLightning?.(msg.args?.[0] ?? '').catch?.(() => {})
        return
      }
      if (msg.method === 'copyText') {
        // navigator.clipboard is unreliable in the about:blank WebView, so
        // copying routes through the shell via expo-clipboard.
        const respond = (result: any) => {
          webViewRef.current?.injectJavaScript(
            'window.__pearResponse(' + JSON.stringify({ ...result, id: msg.id }) + ');true;'
          )
        }
        const text = msg.args?.[0]
        if (typeof text !== 'string' || text.length === 0) {
          respond({ ok: false, error: 'text must be a non-empty string' })
          return
        }
        Clipboard.setStringAsync(text)
          .then(() => respond({ ok: true }))
          .catch((err: any) => respond({ ok: false, error: err?.message ?? String(err) }))
        return
      }
      if (msg.method === 'exportIcs') {
        PearCalShare?.shareCalendar?.(msg.args?.[0] ?? '').catch?.(() => {})
        return
      }

      const bareId = _nextId++
      _pending.set(bareId, result => {
        webViewRef.current?.injectJavaScript(
          'window.__pearResponse(' + JSON.stringify({ ...result, id: msg.id }) + ');true;'
        )
      })
      sendToWorklet({ ...msg, id: bareId })
    } catch (err) { console.error('WebView msg error:', err) }
  }, [])

  useEffect(() => {
    let buf = ''

    // Adopt a worklet that survived a quick Activity teardown (force-close →
    // reopen within the cleanup's terminate window): cancel its pending
    // terminate so the reopen doesn't get its own worklet killed mid-init — the
    // stuck-on-loading bug. Route 'ready' to THIS mount so re-init leaves the
    // loading screen even though the once-registered handler closed over a
    // prior mount's setter.
    if (_terminateTimer) { clearTimeout(_terminateTimer); _terminateTimer = null }
    _notifyReady = () => { setDbReady(true); dbReadyRef.current = true }
    // Remount rather than reload: the WebView's source is inline HTML with
    // baseUrl 'https://localhost', and WKWebView's reload() re-requests that
    // baseUrl for real - so on iOS it tried to fetch https://localhost and
    // showed "Failed to start PearCal. Could not connect to the server"
    // (reported on-device 2026-07-27). Android re-renders the HTML instead,
    // which is why only iOS broke. Bumping the key drops the old React tree
    // and loads the same inline HTML fresh, which is what we actually wanted.
    _remountWebView = () => { setWebViewReady(false); setWebViewEpoch(n => n + 1) }

    async function start () {
      // Clear stale bundles — keep only the 2 most recent (bare + UI)
      try {
        const cacheDir = FileSystem.cacheDirectory!
        const cacheContents = await FileSystem.readDirectoryAsync(cacheDir)
        const bundles = cacheContents.filter(f => f.startsWith('ExponentAsset') && f.endsWith('.bundle'))
        if (bundles.length > 2) {
          const infos = await Promise.all(bundles.map(async f => {
            const info = await FileSystem.getInfoAsync(cacheDir + f)
            return { name: f, modificationTime: (info as any).modificationTime ?? 0 }
          }))
          infos.sort((a, b) => b.modificationTime - a.modificationTime)
          for (const info of infos.slice(2)) {
            await FileSystem.deleteAsync(cacheDir + info.name, { idempotent: true })
          }
        }
      } catch(e) {}
      const docDir = FileSystem.documentDirectory!
      const dataUri = docDir + 'pearcal'
      await FileSystem.makeDirectoryAsync(dataUri, { intermediates: true }).catch(() => {})
      const dataDir = dataUri.replace(/^file:\/\//, '')

      // Nudge iOS to show the Local Network prompt so same-WiFi peers connect
      // directly (see modules/local-network). Fire-and-forget; no-op off iOS.
      requestLocalNetworkPermission()

      // Remove any seed phrase the old backup feature left in iCloud Keychain /
      // Google Block Store. One-time, best-effort, and nothing here waits on it.
      scrubLegacyCloudBackup().catch(() => {})

            // Request notification permission on first launch (Android 13+)
            if (Platform.OS === 'android') {
              try {
                const { PermissionsAndroid } = require('react-native')
                await PermissionsAndroid.request(
                  'android.permission.POST_NOTIFICATIONS',
                  {
                    title: 'PearCal Reminders',
                    message: 'Allow PearCal to send event reminders',
                    buttonPositive: 'Allow',
                    buttonNegative: 'Deny',
                  }
                )
              } catch(e) { console.log('Permission request error:', e) }
            }
      const jsAsset = Asset.fromModule(require('../assets/app-ui.bundle'))
      await jsAsset.downloadAsync()
      const appBundleJs = await fetch(jsAsset.localUri!).then(r => r.text())
      setHtml(buildHtml(appBundleJs))

      const bareModule = Platform.OS === 'ios'
        ? (Constants.isDevice
            ? require('../assets/bare-ios.bundle')
            : require('../assets/bare-ios-sim.bundle'))
        : require('../assets/bare-universal.bundle')
      const bundleAsset = Asset.fromModule(bareModule)
      await bundleAsset.downloadAsync()
      const source = await fetch(bundleAsset.localUri!).then(r => r.text())

      if (_workletStarted && _worklet) {
        // Warm reopen: the worklet survived the Activity teardown (its pending
        // terminate was cancelled at the top of this effect). The teardown's
        // `shutdown` closed its DB, so re-init to reopen it; init() → 'ready'
        // then reaches THIS mount via _notifyReady.
        sendToWorklet({ method: 'init', dataDir, platform: Platform.OS })
        return
      }
      if (!_ensureWorkletStarted) {
        // Memoized single-writer bring-up (proposal 2026-07-11 Part 5): the body
        // runs exactly once even under a near-simultaneous re-entry, so the
        // Autobase writer core is never opened twice. Body kept at its existing
        // indent to keep the diff to the wrapper lines only.
        _ensureWorkletStarted = makeStartLock(async () => {
      // This body registers the COMPLETE set of IPC event handlers, and
      // `_eventHandlers` is module-level so it outlives any single mount. The
      // teardown below nulls `_ensureWorkletStarted` but cannot clear the map
      // (a warm reopen adopts the live worklet and its handlers), so without
      // this every cold re-entry appended a second, third, Nth copy of every
      // handler and each one fired on the same IPC message. One `syncNotify`
      // then became N identical notifications at the same instant (TODO #126).
      // Clearing here rather than in the teardown makes it idempotent by
      // construction: whatever path got us here, exactly one copy survives.
      _events.reset()
      _workletStarted = true
      _worklet = new Worklet()

      _worklet.IPC.on('data', (chunk: Uint8Array) => {
        buf += b4a.toString(chunk)
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const msg = JSON.parse(line)
            if (msg.type === 'event') {
              _events.dispatch(msg.event, msg.data)
            } else if (msg.type === 'response') {
              const resolve = _pending.get(msg.id)
              if (resolve) { _pending.delete(msg.id); resolve(msg) }
            } else if (msg.type === 'nativeRequest') {
              handleNativeRequest(msg)
            }
          } catch (e) { console.error('IPC parse error:', e) }
        }
      })

      onEvent('bareReady', () => sendToWorklet({ method: 'init', dataDir, platform: Platform.OS }))
      onEvent('appDataReset', (data: any) => {
        // The worklet has already wiped the data and re-init'd itself (TODO
        // #118). Two things it cannot do from in there, so they land here.
        //
        // 1. Cancel the scheduled OS alarms. Reminders live in AlarmManager /
        //    UNUserNotificationCenter, NOT in the database, so a wipe leaves
        //    them armed and the user keeps getting reminders for events that
        //    no longer exist. Same fixed ID range reconcileSchedule owns, so
        //    this is the cancel half of that loop.
        // 2. Reload the WebView. It still holds the previous user's React
        //    state - profile, groups, the open settings sheet - and rendering
        //    that over an empty database is how you get a UI insisting on
        //    groups that are gone.
        ;(async () => {
          for (let i = 0; i < TOPK_SCHEDULER_SLOTS; i++) {
            await PearCalNotifications?.cancel?.(TOPK_SCHEDULER_BASE + i).catch(() => {})
          }
          console.log('[reset] cleared scheduled reminders, remounting WebView (keepIdentity=' +
            !!data?.keepIdentity + ')')
          if (_remountWebView) _remountWebView()
        })().catch(() => {})
      })
      onEvent('widgetCache', (payload: any) => {
        const mod = (NativeModules as any).WidgetCache
        if (mod?.writeCache) mod.writeCache(JSON.stringify(payload)).catch?.(() => {})
      })
      onEvent('ready', () => {
        // Registered once per process, so route to the CURRENT mount via
        // _notifyReady rather than this closure's (possibly stale) setDbReady —
        // otherwise a warm remount's fresh component never leaves the loading screen.
        if (_notifyReady) _notifyReady()
        else { setDbReady(true); dbReadyRef.current = true }
        if (Platform.OS === 'ios') {
          PearCalBGSync?.checkPendingBGSync?.().then((pending: boolean) => {
            if (pending) sendToWorklet({ method: 'sync', id: -99, args: [] })
          }).catch(() => {})
        }
      })
      onEvent('error', (msg: string) => {
        if (msg && msg.includes('keep awake')) return // ignore second worklet startup error
        setError(msg)
      })
      onEvent('groupKeyUpdated', (group: any) => {
webViewRef.current?.injectJavaScript(
          'window.__pearEvent("groupKeyUpdated",' + JSON.stringify(group) + ');true;'
        )
      })
      onEvent('cancelNotification', (eventId: string) => {
        const base = notifId(eventId)
        for (let i = 0; i < 4; i++) {
          PearCalNotifications?.cancel?.(base + i).catch(() => {})
        }
      })
      onEvent('sync', (payload: any) => {
        webViewRef.current?.injectJavaScript(
          'window.__pearEvent("sync",' + JSON.stringify(payload) + ');true;'
        )
        // No-op if no BGTask is pending; harmless for foreground syncs
        if (Platform.OS === 'ios') PearCalBGSync?.completeBGSync?.(true)
      })
      onEvent('syncing', (data: any) => {
        webViewRef.current?.injectJavaScript(
          'window.__pearEvent("syncing",' + JSON.stringify(data) + ');true;'
        )
      })
      onEvent('synced', (data: any) => {
        webViewRef.current?.injectJavaScript(
          'window.__pearEvent("synced",' + JSON.stringify(data) + ');true;'
        )
      })

      onEvent('groupDeleted', (groupId: string) => {
        webViewRef.current?.injectJavaScript(
          'window.__pearEvent("groupDeleted",' + JSON.stringify(groupId) + ');true;'
        )
      })

      onEvent('pendingApproval', (groupId: string) => {
        webViewRef.current?.injectJavaScript(
          'window.__pearEvent("pendingApproval",' + JSON.stringify(groupId) + ');true;'
        )
      })

      onEvent('pendingApprovalCleared', (groupId: string) => {
        webViewRef.current?.injectJavaScript(
          'window.__pearEvent("pendingApprovalCleared",' + JSON.stringify(groupId) + ');true;'
        )
      })

      onEvent('pendingRejoin', (data: any) => {
        webViewRef.current?.injectJavaScript(
          'window.__pearEvent("pendingRejoin",' + JSON.stringify(data) + ');true;'
        )
      })

      onEvent('inviteBlocked', (groupId: string) => {
        webViewRef.current?.injectJavaScript(
          'window.__pearEvent("inviteBlocked",' + JSON.stringify(groupId) + ');true;'
        )
      })

      // Device-pair events (TODO #11 Phase 4). Forward to WebView so the
      // OnboardingModal + ProfileTab listeners react to pair lifecycle.
      onEvent('pairingStarted', (data: any) => {
        webViewRef.current?.injectJavaScript(
          'window.__pearEvent("pairingStarted",' + JSON.stringify(data) + ');true;'
        )
      })
      onEvent('pairingCompleted', (data: any) => {
        webViewRef.current?.injectJavaScript(
          'window.__pearEvent("pairingCompleted",' + JSON.stringify(data) + ');true;'
        )
      })
      onEvent('pairingFailed', (data: any) => {
        webViewRef.current?.injectJavaScript(
          'window.__pearEvent("pairingFailed",' + JSON.stringify(data) + ');true;'
        )
      })
      onEvent('pairingExpired', (data: any) => {
        webViewRef.current?.injectJavaScript(
          'window.__pearEvent("pairingExpired",' + JSON.stringify(data) + ');true;'
        )
      })

      // Identity-scoped profile sync (TODO #11 follow-up). Fires when a
      // sibling device edits name/avatar so the UI re-reads profile state.
      onEvent('profileChanged', (data: any) => {
        webViewRef.current?.injectJavaScript(
          'window.__pearEvent("profileChanged",' + JSON.stringify(data ?? null) + ');true;'
        )
      })

      // Linked-devices list change (TODO #95). Fires when any device's
      // deviceMeta row is added or renamed so the Profile → DEVICES list
      // refreshes.
      onEvent('linkedDevicesChanged', (data: any) => {
        webViewRef.current?.injectJavaScript(
          'window.__pearEvent("linkedDevicesChanged",' + JSON.stringify(data ?? null) + ');true;'
        )
      })

      // Blind-peer list change (#116 facet #2). Fires when a seederFollow row is
      // added/updated/removed — including a live seeder groupCount update — so the
      // Profile → Blind Peer list refreshes in place.
      onEvent('blindPeersChanged', (data: any) => {
        webViewRef.current?.injectJavaScript(
          'window.__pearEvent("blindPeersChanged",' + JSON.stringify(data ?? null) + ');true;'
        )
      })

      onEvent('scheduleMorningDigest', async (items: any) => {
        try {
          for (let i = 0; i < MORNING_DIGEST_SLOTS; i++) {
            await PearCalNotifications?.cancel?.(MORNING_DIGEST_BASE + i).catch(() => {})
          }
          if (!Array.isArray(items)) return
          for (const it of items) {
            if (!it || typeof it.slot !== 'number' || !it.fireAt) continue
            if (it.fireAt <= Date.now()) continue
            try {
              await PearCalNotifications?.schedule?.({
                id:    MORNING_DIGEST_BASE + it.slot,
                title: it.title ?? 'Good morning',
                body:  it.body ?? '',
                fireAt: it.fireAt,
                tab:   'calendar',
              })
            } catch (e: any) {
              console.log('Morning digest schedule error (non-fatal):', e?.message)
            }
          }
        } catch (e) {}
      })

      onEvent('cancelMorningDigest', async () => {
        for (let i = 0; i < MORNING_DIGEST_SLOTS; i++) {
          await PearCalNotifications?.cancel?.(MORNING_DIGEST_BASE + i).catch(() => {})
        }
      })

      onEvent('syncNotify', (data: any) => {
        try { queueSyncNotify(data) } catch (e) {}
      })

      // Handle share requests from WebView
      onEvent('canOpenLightning', (can: boolean) => {
        webViewRef.current?.injectJavaScript(
          'window.__pearEvent("canOpenLightning",' + JSON.stringify(can) + ');true;'
        )
      })
      onEvent('haptic', (style: string) => {
        PearCalHaptic?.impact?.(style ?? 'light')
      })
      onEvent('qrScanResult', (result: string) => {
        webViewRef.current?.injectJavaScript(
          'window.__pearEvent("qrScanResult",' + JSON.stringify(result) + ');true;'
        )
      })
      onEvent('nativeShare', (data: any) => {
        try {
          const { title, text } = data
          PearCalShare?.share?.(title ?? '', text ?? '').catch?.(() => {})
        } catch (e) {}
      })
      onEvent('takePhoto', () => {
        PearCalCamera?.capture?.()
          .then((base64: string) => {
            setTimeout(() => {
              webViewRef.current?.injectJavaScript(
                'window.__pearEvent("cameraResult",' + JSON.stringify(base64) + ');true;'
              )
            }, 500)
          })
          .catch(() => {})
      })
      onEvent('qrScan', () => {
        PearCalQRScanner?.scan?.()
          .then((result: string) => {
            webViewRef.current?.injectJavaScript(
              'window.__pearEvent("qrScanResult",' + JSON.stringify(result) + ');true;'
            )
          })
          .catch(() => {})
      })

      _worklet.start('/bare.bundle', source)
        })
      }
      await _ensureWorkletStarted()

      // Initial check for link set before React loaded
      const { PearCalLink } = NativeModules
      if (PearCalLink) {
        try {
          const link = await PearCalLink.getPendingLink()
          if (link) {
              setPendingInvite(link)
          }
        } catch(e) {}
      }
    }

    start().catch(e => setError(e.message))
    return () => {
      // This mount is going away; stop routing 'ready' into its (now stale)
      // setter. A reopen re-sends init and installs its own _notifyReady, so the
      // fresh mount gets the 'ready' that leaves the loading screen.
      _notifyReady = null
      _remountWebView = null
      if (_worklet) {
        sendToWorklet({ method: 'shutdown', args: [], id: -1 })
        // Delay the terminate so a quick reopen can adopt the worklet and CANCEL
        // this timer (see the effect top) — otherwise it would kill the worklet
        // out from under the reopened Activity mid-init → stuck loading screen.
        _terminateTimer = setTimeout(() => {
          _terminateTimer = null
          try { _worklet?.terminate() } catch(e) {}
          _worklet = null
          _workletStarted = false
          _ensureWorkletStarted = null
        }, 3000)
      }
    }
  }, [])
  useEffect(() => {
    if (Platform.OS !== 'android') return
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      webViewRef.current?.injectJavaScript('if(window.__pearBack) window.__pearBack(); true;')
      return true
    })
    return () => sub.remove()
  }, [])

  // Trigger resync when app returns to foreground
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state: string) => {
      // Renderer recovery runs BEFORE (and independently of) the resync branch
      // below: that one is gated on dbReadyRef, but a frozen WebView has nothing
      // to do with whether the DB is up, and gating it there would skip recovery
      // on exactly the slow-start cases most likely to have been backgrounded.
      //
      // How long we were away is tracked on BOTH platforms now, not just Android:
      // the worklet needs it to decide whether the swarm's connections are stale
      // enough to rebuild from scratch. Compute it once here, before either
      // consumer below, since the Android renderer-recovery branch used to clear
      // `_backgroundedAt` and would otherwise leave foregroundSync reading zero.
      let bgMs = 0
      if (state === 'background' || state === 'inactive') {
        if (_backgroundedAt === 0) _backgroundedAt = Date.now()
      } else if (state === 'active') {
        bgMs = _backgroundedAt ? Date.now() - _backgroundedAt : 0
        _backgroundedAt = 0
      }
      if (Platform.OS === 'android' && state === 'active') {
        if (bgMs >= WEBVIEW_RECOVERY_MIN_BG_MS && WebViewRecovery?.terminateRenderer) {
          WebViewRecovery.terminateRenderer().catch(() => {})
        }
      }
      if (state === 'active' && dbReadyRef.current) {
        sendToWorklet({ method: 'foregroundSync', id: -98, args: [{ bgMs, platform: Platform.OS }] })
        sendToWorklet({ method: 'refreshWidgetCache', id: -97, args: [] })
      } else if (state === 'background' && Platform.OS === 'android') {
        // react-native-bare-kit registers a global AppState listener that
        // suspend()s the worklet on 'background' (node_modules/react-native-bare-kit
        // /index.js: AppState 'change' → update('background') → suspend()). That
        // freezes the Bare event loop — the 15s sync tick stops, remote group ops
        // stop replicating/applying, and no syncNotify fires until the next
        // foreground catch-up (#100). We run BareService (a foreground service) +
        // a wake lock specifically to keep syncing in the background, so undo the
        // auto-suspend by resuming. Deferred to the next tick so it lands after
        // BareKit's synchronous suspend handler (which is registered earlier, at
        // module import, and so fires first). Android only — iOS genuinely
        // suspends the process in the background and has no foreground-service path.
        setTimeout(() => { try { _worklet?.resume() } catch (e) {} }, 0)
      }
    })
    return () => sub.remove()
  }, [])

  if (error) return (
    <View style={styles.center}>
      <Text style={styles.emoji}>warning</Text>
      <Text style={styles.errorText}>Failed to start PearCal</Text>
      <Text style={styles.errorDetail}>{error}</Text>
    </View>
  )

  if (!dbReady || !html) return <PearLoadingScreen />

  return (
    <WebView
      key={webViewEpoch}
      ref={webViewRef}
      source={{ html, baseUrl: 'https://localhost' }}
      style={styles.webview}
      onMessage={onWebViewMessage}
      javaScriptEnabled
      domStorageEnabled
      originWhitelist={['*']}
      injectedJavaScriptBeforeContentLoaded={`window.__pearPlatform=${JSON.stringify(Platform.OS)};${(() => {
        const mod = (NativeModules as any).PearCalScreenshot
        const scene = mod?.scene ?? 0
        const dark = mod?.dark ?? -1
        if (scene <= 0) return ''
        return `window.__PEARCAL_SCREENSHOT_SCENE=${scene};window.__PEARCAL_SCREENSHOT_DARK=${dark};`
      })()}true;`}
      onLoadEnd={() => setWebViewReady(true)}
      // Fires when the renderer dies — including the deliberate terminate above
      // (didCrash=false). Reloading rebinds a FRESH render process to the current
      // window surface, which is the whole point; without this the terminate
      // would leave a blank WebView. webViewReady must drop first, or the effects
      // gated on it would inject into a WebView that no longer exists.
      onRenderProcessGone={(e: any) => {
        console.warn('[webview] render process gone, didCrash=' + e?.nativeEvent?.didCrash + ' -> reload')
        setWebViewReady(false)
        webViewRef.current?.reload()
      }}
      onError={e => setError(e.nativeEvent.description)}
    />
  )
}

// Fills the brief gap between the native splash and the WebView being ready.
// The pear icon (frame-free) on the same dark background reads as a continuation
// of the native splash; a gentle breathing pulse signals that it is still loading.
function PearLoadingScreen() {
  const pulse = useRef(new Animated.Value(1)).current
  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1.06, duration: 1100, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1,    duration: 1100, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ])
    ).start()
  }, [])
  return (
    <View style={styles.center}>
      <Animated.Image source={require('../assets/images/icon.png')} style={[styles.icon, { transform: [{ scale: pulse }] }]} />
    </View>
  )
}

const styles = StyleSheet.create({
  webview: { flex: 1, backgroundColor: '#111' },
  center:  { flex: 1, backgroundColor: '#111', alignItems: 'center', justifyContent: 'center', gap: 12 },
  icon:        { width: 96, height: 96, borderRadius: 21 },
  errorText:   { color: '#D45F7A', fontSize: 14 },
  errorDetail: { color: '#888', fontSize: 11, fontFamily: 'monospace', textAlign: 'center', padding: 16 },
})