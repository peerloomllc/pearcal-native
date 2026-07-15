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

const { makeStartLock } = require('../src/lib/backendBootstrap')

let _worklet: any = null
let _workletStarted = false
let _ensureWorkletStarted: null | (() => Promise<any>) = null
let _nextId = 1
const _pending = new Map<number, (msg: any) => void>()
const _eventHandlers = new Map<string, ((data: any) => void)[]>()

function onEvent (event: string, fn: (data: any) => void) {
  const handlers = _eventHandlers.get(event) ?? []
  handlers.push(fn)
  _eventHandlers.set(event, handlers)
}

function sendToWorklet (msg: object) {
  _worklet?.IPC.write(b4a.from(JSON.stringify(msg) + '\n'))
}

const MNEMONIC_KEY = 'pearcal.identity.mnemonic'
const BACKUP_ENABLED_KEY = 'pearcal.identity.backupEnabled'

const platformBackup: any = Platform.OS === 'ios' ? PearCalICloudKeychain : PearCalBlockStore
const platformLabel: 'icloud' | 'blockstore' | null =
  Platform.OS === 'ios' ? 'icloud' : (Platform.OS === 'android' ? 'blockstore' : null)

async function isBackupEnabled (): Promise<boolean> {
  try {
    const v = await SecureStore.getItemAsync(BACKUP_ENABLED_KEY)
    return v !== '0' // default on
  } catch { return true }
}

async function platformIsAvailable (): Promise<boolean> {
  if (!platformBackup?.isAvailable) return false
  try { return !!(await platformBackup.isAvailable()) } catch { return false }
}

async function platformReadMnemonic (): Promise<string | null> {
  if (!platformBackup?.readMnemonic) return null
  try { return (await platformBackup.readMnemonic()) ?? null } catch { return null }
}

async function platformSaveMnemonic (value: string): Promise<boolean> {
  if (!platformBackup?.saveMnemonic) return false
  try { return !!(await platformBackup.saveMnemonic(value)) } catch { return false }
}

async function platformDeleteMnemonic (): Promise<boolean> {
  if (!platformBackup?.deleteMnemonic) return false
  try { return !!(await platformBackup.deleteMnemonic()) } catch { return false }
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
      case 'hasMnemonic': {
        const local = await SecureStore.getItemAsync(MNEMONIC_KEY)
        if (local) { result = true; break }
        // Auto-restore from platform backup before reporting "no mnemonic".
        if (await platformIsAvailable()) {
          const restored = await platformReadMnemonic()
          if (restored) {
            await localSetMnemonic(restored)
            result = true
            break
          }
        }
        result = false
        break
      }
      case 'getMnemonic': {
        const local = await SecureStore.getItemAsync(MNEMONIC_KEY)
        if (local) { result = local; break }
        if (await platformIsAvailable()) {
          const restored = await platformReadMnemonic()
          if (restored) {
            await localSetMnemonic(restored)
            result = restored
            break
          }
        }
        result = null
        break
      }
      case 'setMnemonic': {
        const value = args[0]
        if (typeof value !== 'string' || value.length === 0) {
          throw new Error('setMnemonic: value must be a non-empty string')
        }
        await localSetMnemonic(value)
        result = true
        if (await isBackupEnabled()) {
          // Fire-and-forget — never fail profile creation because backup wrote slowly.
          platformSaveMnemonic(value).catch(() => {})
        }
        break
      }
      case 'getBackupStatus': {
        const local = !!(await SecureStore.getItemAsync(MNEMONIC_KEY))
        const platformAvail = await platformIsAvailable()
        const enabled = await isBackupEnabled()
        let platformSynced = false
        let error: string | null = null
        if (platformAvail && enabled) {
          try {
            const v = await platformReadMnemonic()
            platformSynced = !!v
          } catch (e: any) { error = e?.message ?? String(e) }
        }
        result = {
          local,
          platform: platformAvail && enabled ? platformLabel : null,
          platformSynced,
          enabled,
          error,
        }
        break
      }
      case 'setBackupEnabled': {
        const enable = args[0] !== false && args[0] !== '0' && args[0] !== 0
        await SecureStore.setItemAsync(BACKUP_ENABLED_KEY, enable ? '1' : '0')
        if (!enable) {
          // User explicitly opted out — scrub any existing platform copy.
          platformDeleteMnemonic().catch(() => {})
        } else if (await platformIsAvailable()) {
          // Opted in — mirror current local value up.
          const local = await SecureStore.getItemAsync(MNEMONIC_KEY)
          if (local) platformSaveMnemonic(local).catch(() => {})
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

function flushSyncNotify () {
  _syncNotifyTimer = null
  const buf = _syncNotifyBuffer
  _syncNotifyBuffer = []
  if (buf.length === 0) return
  const id = Math.floor(Math.random() * 2000000) + 1000000
  if (buf.length === 1) {
    const { title, body, tab, groupSettingsId } = buf[0]
    PearCalNotifications?.postNow?.({ id, title, body, tab, groupSettingsId }).catch?.(() => {})
    return
  }
  PearCalNotifications?.postNow?.({
    id,
    title: 'Calendar updated',
    body: buf.length + ' changes',
    tab: buf[0].tab || 'calendar',
  }).catch?.(() => {})
}

function queueSyncNotify (data: any) {
  _syncNotifyBuffer.push({
    title: data?.title ?? 'Calendar updated',
    body:  data?.body  ?? '',
    tab:   data?.tab   ?? '',
    groupSettingsId: data?.groupSettingsId,
  })
  // Bypass the coalesce window for one-off important alerts (rejoin requests, etc),
  // AND whenever we're not in the foreground. The coalesce relies on a JS
  // setTimeout, but RN freezes JS timers while the app is backgrounded — so a
  // deferred flush never runs until the app is foregrounded again, which is
  // exactly why background sync notifications didn't fire until you opened the
  // app (#100). Posting synchronously here works because the syncNotify handler
  // itself still runs in the background (the worklet keeps applying remote ops).
  if (data?.immediate || AppState.currentState !== 'active') {
    if (_syncNotifyTimer) { clearTimeout(_syncNotifyTimer); _syncNotifyTimer = null }
    flushSyncNotify()
    return
  }
  if (!_syncNotifyTimer) {
    _syncNotifyTimer = setTimeout(flushSyncNotify, SYNC_NOTIFY_COALESCE_MS)
  }
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
      webViewRef.current?.injectJavaScript(
        `if(window.__pearHandleInvite) { window.__pearHandleInvite(${JSON.stringify(url)}); } true;`
      )
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
      if (msg.method === 'exportRecoveryPhrase') {
        PearCalShare?.shareRecoveryPhrase?.(msg.args?.[0] ?? '').catch?.(() => {})
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
        sendToWorklet({ method: 'init', dataDir, platform: Platform.OS })
        return
      }
      if (!_ensureWorkletStarted) {
        // Memoized single-writer bring-up (proposal 2026-07-11 Part 5): the body
        // runs exactly once even under a near-simultaneous re-entry, so the
        // Autobase writer core is never opened twice. Body kept at its existing
        // indent to keep the diff to the wrapper lines only.
        _ensureWorkletStarted = makeStartLock(async () => {
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
              (_eventHandlers.get(msg.event) ?? []).forEach(fn => fn(msg.data))
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
      onEvent('widgetCache', (payload: any) => {
        const mod = (NativeModules as any).WidgetCache
        if (mod?.writeCache) mod.writeCache(JSON.stringify(payload)).catch?.(() => {})
      })
      onEvent('ready', () => {
        setDbReady(true)
        dbReadyRef.current = true
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
      if (_worklet) {
        sendToWorklet({ method: 'shutdown', args: [], id: -1 })
        setTimeout(() => {
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
      if (state === 'active' && dbReadyRef.current) {
        sendToWorklet({ method: 'foregroundSync', id: -98, args: [] })
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