// Evaluate one expression in a running PearCal WebView or Electron window over
// the Chrome DevTools Protocol, and print the result.
//
//   adb -s <serial> forward tcp:9301 localabstract:webview_devtools_remote_<pid>
//   node test/harness/cdp.js 9301 "window.__pearDB.call('listGroups').then(g => g.length)"
//
// Electron: launch with --remote-debugging-port=<port> and pass that port.
// A string result prints as is; anything else as JSON. Exits 1 on timeout.
const [port, expr] = process.argv.slice(2)
;(async () => {
  const list = await (await fetch('http://127.0.0.1:' + port + '/json')).json()
  const page = list.find(p => p.type === 'page') || list[0]
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise(r => { ws.onopen = r })
  ws.onmessage = m => {
    const d = JSON.parse(m.data)
    if (d.id !== 1) return
    const r = d.result?.result
    console.log(d.result?.exceptionDetails
      ? 'EXC ' + (d.result.exceptionDetails.exception?.description || '').slice(0, 300)
      : (typeof r?.value === 'string' ? r.value : JSON.stringify(r?.value)))
    process.exit(0)
  }
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }))
  setTimeout(() => { console.log('timeout'); process.exit(1) }, 90000)
})()
