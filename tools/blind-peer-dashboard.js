#!/usr/bin/env node
// Blind Peer Dashboard — lightweight status page for blind-peer-cli
// Run on the same machine as blind-peer. Tails stdout.log and serves a live UI.

const http = require('http')
const fs = require('fs')
const path = require('path')

const LOG_PATH = process.argv[2] || path.join(process.env.HOME, 'blind-peer-data/stdout.log')
const PORT = parseInt(process.argv[3] || '7390', 10)

// ── Favicon ──────────────────────────────────────────────────────────────────
const FAVICON_B64 = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAEvUlEQVR4nL1XXWtcVRRde58z987HTZsmU9Omo6mNlEpbf4FQadEK4mN/gAq+CaJQECm1GAStYMUH3+wP8MEH8UURsVYQK6K0pdbYr5ik0bZpMsnMnbn3nL19uJM0aSfJTBtdMDBc7r5r7a+z9wFWwuC/xwoOWvafAciePc8+Uo3/PuidqwBK99s/CEjZmBuFaOu3Y+e+udLi1eUCDEC+smPvkaRZOyoqEVQ3hntJA0AwcRCW3p8aP/+2qjIyDw8b4DNfeezJN5qN+Q9cmgCAo7V8VwBEd+UrANWV8bzXJPPHWhsgCEujk9fPHwVgCAAe37e/Mndz/E/nEktE1ErH2lCFesmcYwa4o2yJqoi1oYl6h3Zf/f3MHwwAjYU7hxQStnxZn1wUCAzC3dsRPjEIFGz2bH0NTCCoCjXj2RewSCbeDUGha4Z9GRSKcGQA+ZpFvmqQ37kNWUY7MKbWF9QPYZm3ik70t96knIExOchMAzITg9mAApNFoXMoANhuLNCSrE2PZLaKwkgvIEA6X4XWHShn0G33dC9AAbIMmawiSQhKgP9nDmS5a/IHEwAFswUIkJm6ZmVLxGQhLs3aswusX/H3gcDGqnepp5wlCix5nwqz0W7J0XUEVME2BxVPUBipJzMgCEBlEQ9jcvAu6SoK3QkgVmajabPhzGDP8eJbByZQT2j+vdNlf6t+PBfmi8QM1c5nSOcpUIWxVsQ7pm3RO9GJ5yMe7v3UPj1yasv3rwybgdJR8Y7Y5LSbYuxYALFRYja+1pjZdOzAOOX4zfiTn0z64zhwO361dOK5WVdvTBATkzHa2am0ngDCUj6NsfA+haqIb6RstvUgeGZEm19cVLkxD46sUe/F+xSGbWv80br1sLaAVKDNFKwMUU/inC/2lct68tet0h9+HOzfSaXXnmI3F5/y7/4SFrf0PyrOiYgnBkObKTT1DyZAvYC3b0K4rwIz0AMWRinqZ1HR+vXpY9WDpy4nZ6+/JHHycnzyzNmFn8dGwaSlqJ9ICVyOEO6rwA5tXpqa7XB/FxABqYcZiFAsl0HTMXSoD54DxDdukZCADZdwMz5ZffHzCRLyVLDDZBiNxjyMGoQDfTADPaCJOnSgH3VV+Klq26O6bRuqKHhTAXwngczUQUUDF3qQADYfAqIKgtqoWMkMVKAgZiJtpEgDBzubQu/UQZZhNhfgJ+Y6jIAqyDL89BzcyCBMvhcuAtKxOYAESJPWJnV3r1tKpc+eyt9VuF0R7I5e+Ijgrt0Gmfazov1BZAi6kKA+NgneUoRM1oCGByzds0q2GeEGQNMjvjQFLpcg0zFQSwDLbTuzvQBFZhA7+IXZbNItka8DbW16qcD/NZt5vgr56gIWP8QEMjYLXTeTtrXeULC+7WIb0qoL1cOs52vb0pIAYjMNgDb6KtBeVMZtmKeXBESb+74iYtdStfqpsQH0CgURIyz0ftkScNhc+u27a2G+NGptYFSVoOoAOEA36AcHVaeqam1gc0Hxw8sXf7iweDGhbKkiPzi8ZzRp1I6oSk5bJbERl8OsJglErLl84aPJqxdeb12AViwOBEB37d2/u7Ywc0jUVyBKoIfUIAAYao2ZygV9X1+5dPrcWkX/v1/P/wX3VkaTlaWs5gAAAABJRU5ErkJggg=='
const FAVICON_BUF = Buffer.from(FAVICON_B64, 'base64')

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  status: 'starting',
  publicKey: null,
  encryptionKey: null,
  localAddress: null,
  bytesAllocated: null,
  maxStorage: null,
  startedAt: null,
  logs: [],          // last 200 parsed log entries
  connections: [],   // tracked peer connections
  coreCount: 0
}

const MAX_LOGS = 200
const sseClients = new Set()

// ── Log parsing ──────────────────────────────────────────────────────────────
function parseLine (line) {
  try {
    const entry = JSON.parse(line)
    const { msg, time } = entry

    if (msg && msg.startsWith('Listening at ')) {
      state.publicKey = msg.replace('Listening at ', '')
      state.status = 'online'
      if (!state.startedAt) state.startedAt = time
    } else if (msg && msg.startsWith('Encryption public key is ')) {
      state.encryptionKey = msg.replace('Encryption public key is ', '')
    } else if (msg && msg.startsWith('Blind peer listening')) {
      const m = msg.match(/address is (.+)/)
      if (m) state.localAddress = m[1]
    } else if (msg && msg.startsWith('Bytes allocated:')) {
      const m = msg.match(/Bytes allocated: (.+) of (.+)/)
      if (m) { state.bytesAllocated = m[1]; state.maxStorage = m[2] }
    } else if (msg && msg.startsWith('Shutting down')) {
      state.status = 'offline'
    } else if (msg && msg.startsWith('Starting blind peer')) {
      state.status = 'starting'
      state.startedAt = time
    } else if (msg && msg.includes('core')) {
      const m = msg.match(/(\d+)\s*core/)
      if (m) state.coreCount = parseInt(m[1], 10)
    }

    // Track connections
    if (msg && (msg.includes('connect') || msg.includes('peer') || msg.includes('replicating'))) {
      state.connections.push({ time, msg })
      if (state.connections.length > 50) state.connections.shift()
    }

    state.logs.push({ time, msg: msg || JSON.stringify(entry), level: entry.level })
    if (state.logs.length > MAX_LOGS) state.logs.shift()

    broadcast()
  } catch {}
}

// ── File tail ────────────────────────────────────────────────────────────────
let fileSize = 0
function tailLog () {
  try {
    const stat = fs.statSync(LOG_PATH)
    if (stat.size < fileSize) fileSize = 0 // log rotated
    if (stat.size > fileSize) {
      const stream = fs.createReadStream(LOG_PATH, { start: fileSize, encoding: 'utf-8' })
      let buf = ''
      stream.on('data', chunk => {
        buf += chunk
        const lines = buf.split('\n')
        buf = lines.pop()
        for (const l of lines) if (l.trim()) parseLine(l)
      })
      stream.on('end', () => { if (buf.trim()) parseLine(buf) })
      fileSize = stat.size
    }
  } catch {}
}

// Initial read of full log
tailLog()
// Poll every 2s
setInterval(tailLog, 2000)

// ── SSE ──────────────────────────────────────────────────────────────────────
function broadcast () {
  const data = JSON.stringify(state)
  for (const res of sseClients) {
    try { res.write(`data: ${data}\n\n`) } catch { sseClients.delete(res) }
  }
}

// ── HTML ─────────────────────────────────────────────────────────────────────
function renderHTML () {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Blind Peer</title>
<link rel="icon" href="/favicon.png" type="image/png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg: #0a0c10;
    --surface: #12151c;
    --surface-2: #181c25;
    --border: #1e2330;
    --border-bright: #2a3045;
    --text: #c8cdd8;
    --text-dim: #5c6478;
    --text-bright: #e8ecf4;
    --accent: #22c97a;
    --accent-dim: rgba(34, 201, 122, 0.12);
    --accent-glow: rgba(34, 201, 122, 0.25);
    --warn: #e8a33c;
    --err: #e84057;
    --blue: #4a9eff;
  }

  body {
    font-family: 'DM Sans', sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    overflow-x: hidden;
  }

  /* Subtle grid background */
  body::before {
    content: '';
    position: fixed;
    inset: 0;
    background-image:
      linear-gradient(var(--border) 1px, transparent 1px),
      linear-gradient(90deg, var(--border) 1px, transparent 1px);
    background-size: 60px 60px;
    opacity: 0.3;
    pointer-events: none;
    z-index: 0;
  }

  .shell {
    position: relative;
    z-index: 1;
    max-width: 860px;
    margin: 0 auto;
    padding: 40px 24px;
  }

  /* ── Header ──────────────────────────── */
  header {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-bottom: 40px;
  }

  .status-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--text-dim);
    flex-shrink: 0;
  }
  .status-dot.online {
    background: var(--accent);
    box-shadow: 0 0 8px var(--accent-glow), 0 0 20px var(--accent-dim);
    animation: pulse 2.5s ease-in-out infinite;
  }
  .status-dot.offline { background: var(--err); }
  .status-dot.starting { background: var(--warn); animation: pulse 1s ease-in-out infinite; }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }

  h1 {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 18px;
    font-weight: 600;
    color: var(--text-bright);
    letter-spacing: -0.02em;
  }

  .status-label {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 11px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    padding: 3px 10px;
    border-radius: 4px;
    background: var(--accent-dim);
    color: var(--accent);
  }
  .status-label.offline { background: rgba(232,64,87,0.12); color: var(--err); }
  .status-label.starting { background: rgba(232,163,60,0.12); color: var(--warn); }

  .uptime {
    margin-left: auto;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 12px;
    color: var(--text-dim);
  }

  /* ── Cards ───────────────────────────── */
  .cards {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 12px;
    margin-bottom: 24px;
  }

  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 20px;
    transition: border-color 0.2s;
  }
  .card:hover { border-color: var(--border-bright); }

  .card-label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-dim);
    margin-bottom: 8px;
  }

  .card-value {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 22px;
    font-weight: 600;
    color: var(--text-bright);
  }

  .card-sub {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 11px;
    color: var(--text-dim);
    margin-top: 4px;
  }

  /* ── Key display ─────────────────────── */
  .key-section {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px 20px;
    margin-bottom: 24px;
  }

  .key-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 6px 0;
  }
  .key-row + .key-row { border-top: 1px solid var(--border); padding-top: 12px; margin-top: 6px; }

  .key-label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-dim);
    min-width: 90px;
    flex-shrink: 0;
  }

  .key-value {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 12px;
    color: var(--blue);
    word-break: break-all;
    cursor: pointer;
    padding: 4px 8px;
    border-radius: 4px;
    transition: background 0.15s;
  }
  .key-value:hover { background: rgba(74, 158, 255, 0.08); }
  .key-value:active::after { content: ' copied'; color: var(--accent); font-size: 10px; }

  /* ── Log ─────────────────────────────── */
  .log-section {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
  }

  .log-header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 14px 20px;
    border-bottom: 1px solid var(--border);
  }

  .log-header h2 {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-bright);
  }

  .log-count {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 11px;
    color: var(--text-dim);
    margin-left: auto;
  }

  .log-entries {
    max-height: 380px;
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: var(--border-bright) transparent;
  }

  .log-entry {
    display: flex;
    gap: 16px;
    padding: 8px 20px;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 12px;
    line-height: 1.5;
    border-bottom: 1px solid var(--border);
    transition: background 0.1s;
  }
  .log-entry:hover { background: var(--surface-2); }
  .log-entry:last-child { border-bottom: none; }

  .log-time {
    color: var(--text-dim);
    flex-shrink: 0;
    min-width: 70px;
  }

  .log-msg { color: var(--text); word-break: break-word; }
  .log-entry.warn .log-msg { color: var(--warn); }
  .log-entry.error .log-msg { color: var(--err); }

  .empty-state {
    padding: 40px 20px;
    text-align: center;
    font-size: 13px;
    color: var(--text-dim);
  }

  @media (max-width: 600px) {
    .shell { padding: 24px 16px; }
    .cards { grid-template-columns: 1fr; }
    header { flex-wrap: wrap; }
    .uptime { margin-left: 0; width: 100%; margin-top: 4px; }
  }
</style>
</head>
<body>
<div class="shell">
  <header>
    <div class="status-dot" id="dot"></div>
    <h1>blind-peer</h1>
    <span class="status-label" id="statusLabel">--</span>
    <span class="uptime" id="uptime"></span>
  </header>

  <div class="cards">
    <div class="card">
      <div class="card-label">Storage</div>
      <div class="card-value" id="storage">--</div>
      <div class="card-sub" id="storageMax"></div>
    </div>
    <div class="card">
      <div class="card-label">Address</div>
      <div class="card-value" id="addr" style="font-size:14px">--</div>
    </div>
    <div class="card">
      <div class="card-label">Events</div>
      <div class="card-value" id="eventCount">0</div>
      <div class="card-sub">log entries</div>
    </div>
  </div>

  <div class="key-section" id="keySection" style="display:none">
    <div class="key-row">
      <span class="key-label">Public key</span>
      <span class="key-value" id="pubKey" onclick="copy(this)"></span>
    </div>
    <div class="key-row">
      <span class="key-label">Encryption</span>
      <span class="key-value" id="encKey" onclick="copy(this)"></span>
    </div>
  </div>

  <div class="log-section">
    <div class="log-header">
      <h2>Event log</h2>
      <span class="log-count" id="logCount"></span>
    </div>
    <div class="log-entries" id="logEntries">
      <div class="empty-state">Waiting for events...</div>
    </div>
  </div>
</div>

<script>
function copy (el) {
  navigator.clipboard.writeText(el.textContent).catch(() => {})
}

function formatUptime (startMs) {
  if (!startMs) return ''
  const s = Math.floor((Date.now() - startMs) / 1000)
  if (s < 60) return s + 's'
  if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's'
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h < 24) return h + 'h ' + m + 'm'
  return Math.floor(h / 24) + 'd ' + (h % 24) + 'h'
}

function formatTime (ms) {
  if (!ms) return ''
  const d = new Date(ms)
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function levelClass (level) {
  if (level >= 50) return 'error'
  if (level >= 40) return 'warn'
  return ''
}

let autoScroll = true
const logEl = document.getElementById('logEntries')
logEl.addEventListener('scroll', () => {
  autoScroll = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 30
})

function render (state) {
  // Status
  const dot = document.getElementById('dot')
  const label = document.getElementById('statusLabel')
  dot.className = 'status-dot ' + state.status
  label.className = 'status-label ' + state.status
  label.textContent = state.status
  document.getElementById('uptime').textContent = state.startedAt ? 'up ' + formatUptime(state.startedAt) : ''

  // Cards
  document.getElementById('storage').textContent = state.bytesAllocated || '--'
  document.getElementById('storageMax').textContent = state.maxStorage ? 'of ' + state.maxStorage : ''
  document.getElementById('addr').textContent = state.localAddress || '--'
  document.getElementById('eventCount').textContent = state.logs.length

  // Keys
  if (state.publicKey) {
    document.getElementById('keySection').style.display = ''
    document.getElementById('pubKey').textContent = state.publicKey
    document.getElementById('encKey').textContent = state.encryptionKey || '--'
  }

  // Log entries
  document.getElementById('logCount').textContent = state.logs.length + ' entries'
  const entries = state.logs.slice(-80).reverse()
  logEl.innerHTML = entries.length
    ? entries.map(e =>
        '<div class="log-entry ' + levelClass(e.level) + '">' +
          '<span class="log-time">' + formatTime(e.time) + '</span>' +
          '<span class="log-msg">' + esc(e.msg) + '</span>' +
        '</div>'
      ).join('')
    : '<div class="empty-state">Waiting for events...</div>'
}

function esc (s) {
  const d = document.createElement('div')
  d.textContent = s
  return d.innerHTML
}

// SSE
const evtSource = new EventSource('/events')
evtSource.onmessage = (e) => {
  try { render(JSON.parse(e.data)) } catch {}
}
evtSource.onerror = () => {
  document.getElementById('dot').className = 'status-dot offline'
  document.getElementById('statusLabel').className = 'status-label offline'
  document.getElementById('statusLabel').textContent = 'disconnected'
}

// Update uptime counter every second
setInterval(() => {
  const el = document.getElementById('uptime')
  if (window._startedAt) el.textContent = 'up ' + formatUptime(window._startedAt)
}, 1000)
const origRender = render
render = function (state) {
  window._startedAt = state.startedAt
  origRender(state)
}
</script>
<script>
// Force favicon via JS to bypass caching
(function(){
  var link = document.querySelector("link[rel='icon']") || document.createElement('link');
  link.rel = 'icon';
  link.type = 'image/png';
  link.href = 'data:image/png;base64,${FAVICON_B64}';
  document.head.appendChild(link);
})();
</script>
</body>
</html>`
}

// ── HTTP Server ──────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === '/favicon.ico' || req.url === '/favicon.png') {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' })
    res.end(FAVICON_BUF)
    return
  }

  if (req.url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    })
    res.write(`data: ${JSON.stringify(state)}\n\n`)
    sseClients.add(res)
    req.on('close', () => sseClients.delete(res))
    return
  }

  if (req.url === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(state))
    return
  }

  res.writeHead(200, { 'Content-Type': 'text/html' })
  res.end(renderHTML())
})

server.listen(PORT, () => {
  console.log(`Blind peer dashboard: http://localhost:${PORT}`)
  console.log(`Tailing: ${LOG_PATH}`)
})
