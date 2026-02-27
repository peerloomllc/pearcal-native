import { useState, useEffect, useRef, useCallback } from 'react'
import { View, Text, StyleSheet, NativeModules, Platform } from 'react-native'
import { WebView } from 'react-native-webview'
import { Worklet } from 'react-native-bare-kit'
import b4a from 'b4a'
import { Asset } from 'expo-asset'
import * as FileSystem from 'expo-file-system/legacy'

const { PearCalNotifications } = NativeModules

let _worklet: any = null
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

function calcFireTime (event: any): number | null {
  const [y, mo, d] = event.date.split('-').map(Number)
  let h = 9, m = 0
  if (!event.allDay && event.start) {
    const parts = event.start.split(':').map(Number)
    h = parts[0]; m = parts[1]
  }
  return new Date(y, mo - 1, d, h, m, 0, 0).getTime() - event.reminder * 60 * 1000
}

async function handleNotification (msg: any, webViewRef: any) {
  console.log("handleNotification:", msg.method, JSON.stringify(msg.args?.[0]?.reminder))
  console.log("PearCalNotifications available:", !!PearCalNotifications)
  try {
    if (msg.method === 'scheduleForEvent') {
      const ev = msg.args[0]
      if (ev && ev.reminder && ev.reminder > 0) {
        const fireAt = calcFireTime(ev)
        console.log("fireAt:", fireAt, "now:", Date.now(), "diff mins:", ((fireAt - Date.now())/60000).toFixed(1))
          if (fireAt && fireAt > Date.now()) {
          console.log("Calling schedule...")
          try { await PearCalNotifications?.schedule?.({
            id:      notifId(ev.id),
            title:   'X ' + ev.title,
            body:    ev.allDay ? 'All day reminder' : ev.start + ' to ' + ev.end,
            fireAt,
            eventId: ev.id,
          }) } catch(schedErr) { console.log('Alarm schedule error (non-fatal):', schedErr?.message) }
          console.log("Schedule call completed")
        }
      } else if (ev) {
        await PearCalNotifications?.cancel?.(notifId(ev.id))
      }
    } else if (msg.method === 'cancelForEvent') {
      await PearCalNotifications?.cancel?.(notifId(msg.args[0]))
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
  const html = [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="UTF-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no, viewport-fit=cover" />',
    '<style>',
    '* { box-sizing: border-box; margin: 0; padding: 0; }',
    'html, body, #root { height: 100%; width: 100%; padding-top: env(safe-area-inset-top); padding-bottom: env(safe-area-inset-bottom); }',
    '</style>',
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
  const [dbReady, setDbReady] = useState(false)
  const [error,   setError]   = useState<string | null>(null)
  const [html,    setHtml]    = useState<string | null>(null)
  const [pendingInvite, setPendingInvite] = useState<string | null>(null)
  const webViewRef = useRef<any>(null)
  const dbReadyRef = useRef(false)

  // Poll for pending invite links every 2 seconds
  useEffect(() => {
    if (!dbReady) return
    const { PearCalLink } = NativeModules
    if (!PearCalLink) return
    const interval = setInterval(async () => {
      try {
        const link = await PearCalLink.getPendingLink()
        if (link) {
          console.log('Poll found invite link:', link)
          setPendingInvite(link)
        }
      } catch(e) {}
    }, 2000)
    return () => clearInterval(interval)
  }, [dbReady])

  // Inject pending invite link when WebView and DB are ready
  useEffect(() => {
    console.log('invite useEffect fired, pendingInvite:', !!pendingInvite, 'dbReady:', dbReady, 'webView:', !!webViewRef.current)
    if (pendingInvite && dbReady && webViewRef.current) {
      console.log('Injecting invite into WebView:', pendingInvite)
      const url = pendingInvite
      setPendingInvite(null)
      console.log('Injecting invite into WebView:', url)
      webViewRef.current?.injectJavaScript(
        `if(window.__pearHandleInvite) { window.__pearHandleInvite(${JSON.stringify(url)}); } true;`
      )
    }
  }, [pendingInvite, dbReady])

  const onWebViewMessage = useCallback((e: any) => {
    try {
      const msg = JSON.parse(e.nativeEvent.data)

      if (['scheduleForEvent', 'cancelForEvent', 'restoreAll'].includes(msg.method)) {
        handleNotification(msg, webViewRef)
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
      const docDir = FileSystem.documentDirectory!
      const dataUri = docDir + 'pearcal'
      await FileSystem.makeDirectoryAsync(dataUri, { intermediates: true }).catch(() => {})
      const dataDir = dataUri.replace(/^file:\/\//, '')

            // Request notification permission on first launch (Android 13+)
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
      const jsAsset = Asset.fromModule(require('../assets/app-ui.bundle'))
      await jsAsset.downloadAsync()
      const appBundleJs = await fetch(jsAsset.localUri!).then(r => r.text())
      setHtml(buildHtml(appBundleJs))

      const bundleAsset = Asset.fromModule(require('../assets/bare-universal.bundle'))
      await bundleAsset.downloadAsync()
      const source = await fetch(bundleAsset.localUri!).then(r => r.text())

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
      onEvent('ready', () => { setDbReady(true); dbReadyRef.current = true })
      onEvent('error', (msg: string) => setError(msg))
      onEvent('groupKeyUpdated', (group: any) => {
webViewRef.current?.injectJavaScript(
          'window.__pearEvent("groupKeyUpdated",' + JSON.stringify(group) + ');true;'
        )
      })
      onEvent('sync', (groupId: string) => {
        webViewRef.current?.injectJavaScript(
          'window.__pearEvent("sync",' + JSON.stringify(groupId) + ');true;'
        )
      })

      _worklet.start('/bare.bundle', source)

      // Initial check for link set before React loaded
      const { PearCalLink } = NativeModules
      if (PearCalLink) {
        try {
          const link = await PearCalLink.getPendingLink()
          if (link) {
            console.log('Startup invite link found:', link)
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
        }, 1000)
      }
    }
  }, [])

  if (error) return (
    <View style={styles.center}>
      <Text style={styles.emoji}>warning</Text>
      <Text style={styles.errorText}>Failed to start PearCal</Text>
      <Text style={styles.errorDetail}>{error}</Text>
    </View>
  )

  if (!dbReady || !html) return (
    <View style={styles.center}>
      <Text style={styles.emoji}>pear</Text>
      <Text style={styles.loadingText}>Loading PearCal</Text>
    </View>
  )

  return (
    <WebView
      ref={webViewRef}
      source={{ html, baseUrl: 'https://localhost' }}
      style={styles.webview}
      onMessage={onWebViewMessage}
      javaScriptEnabled
      domStorageEnabled
      originWhitelist={['*']}
      onError={e => setError(e.nativeEvent.description)}
    />
  )
}

const styles = StyleSheet.create({
  webview: { flex: 1, backgroundColor: '#111' },
  center:  { flex: 1, backgroundColor: '#111', alignItems: 'center', justifyContent: 'center', gap: 12 },
  emoji:       { fontSize: 48 },
  loadingText: { color: '#888', fontSize: 14, fontWeight: '300', letterSpacing: 1 },
  errorText:   { color: '#D45F7A', fontSize: 14 },
  errorDetail: { color: '#888', fontSize: 11, fontFamily: 'monospace', textAlign: 'center', padding: 16 },
})