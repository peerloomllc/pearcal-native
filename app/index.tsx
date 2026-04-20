import { useState, useEffect, useRef, useCallback } from 'react'

// Suppress non-fatal Bare runtime errors in dev mode
const originalHandler = (global as any).ErrorUtils?.getGlobalHandler?.()
;(global as any).ErrorUtils?.setGlobalHandler?.((error: any, isFatal: boolean) => {
  if (!isFatal && error?.message?.includes('keep awake')) return
  originalHandler?.(error, isFatal)
})
import { View, Text, Image, StyleSheet, NativeModules, Platform, BackHandler, AppState, Animated, Easing } from 'react-native'
import { WebView } from 'react-native-webview'
import { Worklet } from 'react-native-bare-kit'
import b4a from 'b4a'
import { Asset } from 'expo-asset'
import Constants from 'expo-constants'
import * as FileSystem from 'expo-file-system/legacy'

const { PearCalNotifications } = NativeModules
const { PearCalShare } = NativeModules
const { PearCalQRScanner } = NativeModules
const { PearCalCamera } = NativeModules
const { PearCalHaptic } = NativeModules
const { PearCalDeepLink } = NativeModules
const { PearCalBGSync } = NativeModules

let _worklet: any = null
let _workletStarted = false
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

function notifId (eventId: string): number {
  let h = 0
  for (const c of eventId) h = (Math.imul(31, h) + c.charCodeAt(0)) | 0
  return Math.abs(h)
}

const MORNING_DIGEST_BASE = 900000
const MORNING_DIGEST_SLOTS = 3

// Coalesce syncNotify bursts. When the phone wakes on charger overnight, Autobase
// catch-up applies N buffered remote changes at once and each emits a syncNotify →
// postNow → a separate local notification. Without a window the user wakes to a
// flood. Buffer within a fixed window and collapse >1 into a single summary.
const SYNC_NOTIFY_COALESCE_MS = 5000
let _syncNotifyBuffer: Array<{ title: string, body: string, tab: string }> = []
let _syncNotifyTimer: any = null

function flushSyncNotify () {
  _syncNotifyTimer = null
  const buf = _syncNotifyBuffer
  _syncNotifyBuffer = []
  if (buf.length === 0) return
  const id = Math.floor(Math.random() * 2000000) + 1000000
  if (buf.length === 1) {
    const { title, body, tab } = buf[0]
    PearCalNotifications?.postNow?.({ id, title, body, tab }).catch?.(() => {})
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
  })
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
          '-1': 'Morning of', '-2': 'Day before',
        }
        for (let i = 0; i < Math.min(reminders.length, 3); i++) {
          const reminder = reminders[i]
          const fireAt = calcReminderFireTime(ev, reminder)
          if (!fireAt || fireAt <= Date.now()) continue
          const label = OPTION_LABELS[String(reminder)] ?? (reminder > 0 ? reminder + 'min' : '')
          const body = ev.allDay
            ? 'All day · ' + label
            : label + ' · ' + ev.start + '–' + ev.end
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
                body:    ev.start + ' to ' + ev.end,
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
  const APP_VERSION: string = (require('../app.json') as any).expo.version
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

  // Inject pending invite link when WebView, DB, and WebView DOM are all ready
  useEffect(() => {
    if (pendingInvite && dbReady && webViewReady && webViewRef.current) {
      const url = pendingInvite
      setPendingInvite(null)
      webViewRef.current?.injectJavaScript(
        `if(window.__pearHandleInvite) { window.__pearHandleInvite(${JSON.stringify(url)}); } true;`
      )
    }
  }, [pendingInvite, dbReady, webViewReady])

  const onWebViewMessage = useCallback((e: any) => {
    try {
      const msg = JSON.parse(e.nativeEvent.data)

      if (['scheduleForEvent', 'cancelForEvent', 'restoreAll'].includes(msg.method)) {
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
        sendToWorklet({ method: 'init', dataDir })
        return
      }
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
            }
          } catch (e) { console.error('IPC parse error:', e) }
        }
      })

      onEvent('bareReady', () => sendToWorklet({ method: 'init', dataDir }))
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

function PearLoadingScreen() {
  const pulseAnim = useRef(new Animated.Value(1)).current
  const pulse = pulseAnim
  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1.18, duration: 800, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 800, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ])
    ).start()
  }, [])
  return (
    <View style={styles.center}>
      <Animated.Image source={require('../assets/images/icon.png')} style={[styles.icon, { transform: [{ scale: pulse }] }]} />
      <Text style={styles.loadingText}>PearCal</Text>
      <Text style={styles.loadingSubtext}>Starting up…</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  webview: { flex: 1, backgroundColor: '#111' },
  center:  { flex: 1, backgroundColor: '#111', alignItems: 'center', justifyContent: 'center', gap: 12 },
  icon:        { width: 72, height: 72, borderRadius: 16 },
  loadingText: { color: '#ccc', fontSize: 18, fontWeight: '300', letterSpacing: 2, marginTop: 8 },
  loadingSubtext: { color: '#555', fontSize: 12, fontWeight: '300', letterSpacing: 1 },
  errorText:   { color: '#D45F7A', fontSize: 14 },
  errorDetail: { color: '#888', fontSize: 11, fontFamily: 'monospace', textAlign: 'center', padding: 16 },
})