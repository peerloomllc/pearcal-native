// Monitoring + management dashboard for the PearCal seeder launcher — a faithful
// port of PearCircle's current seeder dashboard layout (topbar with brand image
// + inline nickname + live/version pill + theme toggle + gear menu; a hero stats
// row; a groups panel; a bottom action bar carrying identity + Add; modals for
// Add-a-device / Maintenance / Support; a custom confirm dialog; a top toast),
// restyled in PearCal's palette (gold #C8922A) + Manrope, with light + dark.
//
// Extras kept: token auth (auth.js), live push via Server-Sent Events, offline
// fonts + brand image (inlined when staged), and blind-safe metrics.
// Not applicable to PearCal yet: auto-update bar, per-group revoke/retention.

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const auth = require('./auth')

// PeerLoom donation channels (identical to the mobile app's donation modal).
const DONATE = {
  ln: 'peerloomllc@strike.me',
  onchain: 'bc1q0kksenz3j4u9ppe6f4krclvzwxk7sjy00cc9cf',
  bmc: 'https://buymeacoffee.com/peerloomllc?new=1',
}
const LN_WALLETS = [
  { name: 'Strike', url: 'https://strike.me' },
  { name: 'Cash App', url: 'https://cash.app' },
  { name: 'Wallet of Satoshi', url: 'https://walletofsatoshi.com' },
  { name: 'Phoenix', url: 'https://phoenix.acinq.co' },
]

function sendJson (res, body, status = 200) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
function readBody (req) {
  return new Promise((resolve) => {
    let b = ''
    req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy() })
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}) } catch { resolve({}) } })
    req.on('error', () => resolve({}))
  })
}
async function snapshot (worklet) {
  const [status, enrolled] = await Promise.all([
    worklet.call('seeder:status', {}).catch((e) => ({ error: e.message })),
    worklet.call('seeder:enrolled:list', {}).catch(() => []),
  ])
  return { status, enrolled }
}

function startDashboard ({ worklet, port = 8731, host = '0.0.0.0', token = null, version = null, log }) {
  let fontStyle
  try { fontStyle = '<style>' + fs.readFileSync(path.join(__dirname, 'fonts.css'), 'utf8') + '</style>' }
  catch { fontStyle = "<style>@import url('https://fonts.googleapis.com/css2?family=Manrope:wght@300;400;500;600;700&display=swap');</style>" }
  let brand = ''
  try { brand = 'data:image/png;base64,' + fs.readFileSync(path.join(__dirname, 'brand.png')).toString('base64') } catch {}
  const page = PAGE
    .replace('<!--FONTS-->', fontStyle)
    .replace('<!--BRAND-->', brand)
    .replace('<!--VERSION-->', version ? 'v' + version : '')

  const authed = (req) => !token || auth.verify(req, token)
  const clients = new Set()
  const broadcast = (event, data) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const res of clients) { try { res.write(payload) } catch {} }
  }
  worklet.on('event', ({ name, data }) => { if (name === 'seeder:pair:result') broadcast('pair', data || {}) })

  const srv = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost'); const p = url.pathname
      if (req.method === 'GET' && p === '/') {
        if (!authed(req)) { res.writeHead(401, { 'content-type': 'text/html' }); res.end(UNAUTH); return }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(page); return
      }
      if (!authed(req)) return sendJson(res, { error: 'unauthorized' }, 401)
      if (req.method === 'GET' && p === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
        res.write('retry: 3000\n\n'); clients.add(res)
        snapshot(worklet).then((s) => { try { res.write(`event: status\ndata: ${JSON.stringify(s)}\n\n`) } catch {} })
        req.on('close', () => clients.delete(res)); return
      }
      if (req.method === 'GET' && p === '/api/status') return sendJson(res, await snapshot(worklet))
      if (req.method === 'GET' && p === '/api/donate') {
        const t = url.searchParams.get('tab'); const tab = DONATE[t] ? t : 'ln'; const value = DONATE[tab]
        let qr = null; try { qr = await require('qrcode').toDataURL(value, { width: 220, margin: 1, errorCorrectionLevel: 'M' }) } catch {}
        return sendJson(res, { tab, value, qr, wallets: tab === 'ln' ? LN_WALLETS : [] })
      }
      if (req.method === 'POST' && p === '/api/pair/open') {
        const r = await worklet.call('seeder:pair:open', {}).catch((e) => ({ error: e.message }))
        let qr = null; if (r && r.link) { try { qr = await require('qrcode').toDataURL(r.link, { width: 320, margin: 2 }) } catch {} }
        return sendJson(res, { ...r, qr })
      }
      if (req.method === 'POST' && p === '/api/pair/close') return sendJson(res, await worklet.call('seeder:pair:close', {}).catch((e) => ({ error: e.message })))
      if (req.method === 'POST' && p === '/api/enroll') {
        const { invite } = await readBody(req); if (!invite) return sendJson(res, { error: 'invite required' }, 400)
        const r = await worklet.call('seeder:enroll', { invite }).catch((e) => ({ error: e.message })); broadcast('status', await snapshot(worklet)); return sendJson(res, r)
      }
      if (req.method === 'POST' && p === '/api/leave') {
        const { groupId } = await readBody(req); if (!groupId) return sendJson(res, { error: 'groupId required' }, 400)
        const r = await worklet.call('seeder:leave', { groupId }).catch((e) => ({ error: e.message })); broadcast('status', await snapshot(worklet)); return sendJson(res, r)
      }
      if (req.method === 'POST' && p === '/api/nickname') {
        const { name } = await readBody(req)
        const r = await worklet.call('seeder:nickname:set', { name: name || '' }).catch((e) => ({ error: e.message })); broadcast('status', await snapshot(worklet)); return sendJson(res, r)
      }
      if (req.method === 'POST' && p === '/api/restart') { worklet.stop().catch(() => {}); return sendJson(res, { ok: true }) }
      res.writeHead(404); res.end('not found')
    } catch (e) { res.writeHead(500); res.end(String(e && e.message || e)) }
  })
  const ticker = setInterval(async () => { if (clients.size) { try { broadcast('status', await snapshot(worklet)) } catch {} } }, 2000)
  if (typeof ticker.unref === 'function') ticker.unref()
  srv.on('error', (e) => log && log('dashboard', 'error: ' + e.message))
  srv.listen(port, host, () => { const shown = host === '0.0.0.0' ? 'localhost' : host; log && log('dashboard', `listening on http://${shown}:${port}/` + (token ? `?t=${token}` : '')) })
  return srv
}

const UNAUTH = '<!doctype html><meta charset=utf-8><body style="font-family:sans-serif;background:#0E0D0C;color:#F2EFE8;padding:40px"><h2>Unauthorized</h2><p>Open the dashboard with the token URL printed in the seeder logs (…/?t=…).</p>'

const SVG = (b) => `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${b}</svg>`
const I = {
  gear: SVG('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  wrench: SVG('<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>'),
  heart: SVG('<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>'),
  sun: SVG('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4"/>'),
  moon: SVG('<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'),
  plus: SVG('<path d="M12 5v14M5 12h14"/>'),
  copy: SVG('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>PearCal Seeder</title>
<!--FONTS-->
<style>
  :root{
    --bg:#0E0D0C; --bg-accent:radial-gradient(1200px 600px at 50% -12%, rgba(200,146,42,.10) 0%, transparent 60%);
    --surface:#1A1916; --surface-2:#252220; --surface-hover:#2C2A26; --border:#2C2A26; --border-strong:#3A372F;
    --text:#F2EFE8; --muted:#B8B2A6; --subtle:#8A8478; --primary:#C8922A; --primary-strong:#A5761F; --on-primary:#1A1916;
    --good:#5DBF8A; --warn:#E5864A; --bad:#C0504A; --faint:rgba(200,146,42,.12);
    --shadow:0 1px 2px #00000040,0 8px 24px #00000030; --radius:14px; --radius-sm:9px;
  }
  @media(prefers-color-scheme:light){:root{
    --bg:#F7F5F0; --bg-accent:radial-gradient(1200px 600px at 50% -12%, rgba(176,125,32,.10) 0%, transparent 60%);
    --surface:#FFFFFF; --surface-2:#EFECE4; --surface-hover:#E9E5DC; --border:#E5E1D8; --border-strong:#D6D0C4;
    --text:#1A1916; --muted:#55514A; --subtle:#6E6A5E; --primary:#B07D20; --primary-strong:#8E6318; --on-primary:#FFFFFF;
    --good:#4A9E6E; --warn:#A85F1E; --bad:#C0504A; --faint:rgba(176,125,32,.10);
    --shadow:0 1px 2px #1b19140f,0 10px 30px #24201914;
  }}
  :root[data-theme='dark']{--bg:#0E0D0C;--bg-accent:radial-gradient(1200px 600px at 50% -12%, rgba(200,146,42,.10) 0%, transparent 60%);--surface:#1A1916;--surface-2:#252220;--surface-hover:#2C2A26;--border:#2C2A26;--border-strong:#3A372F;--text:#F2EFE8;--muted:#B8B2A6;--subtle:#8A8478;--primary:#C8922A;--primary-strong:#A5761F;--on-primary:#1A1916;--good:#5DBF8A;--warn:#E5864A;--bad:#C0504A;--faint:rgba(200,146,42,.12);--shadow:0 1px 2px #00000040,0 8px 24px #00000030;}
  :root[data-theme='light']{--bg:#F7F5F0;--bg-accent:radial-gradient(1200px 600px at 50% -12%, rgba(176,125,32,.10) 0%, transparent 60%);--surface:#FFFFFF;--surface-2:#EFECE4;--surface-hover:#E9E5DC;--border:#E5E1D8;--border-strong:#D6D0C4;--text:#1A1916;--muted:#55514A;--subtle:#6E6A5E;--primary:#B07D20;--primary-strong:#8E6318;--on-primary:#FFFFFF;--good:#4A9E6E;--warn:#A85F1E;--bad:#C0504A;--faint:rgba(176,125,32,.10);--shadow:0 1px 2px #1b19140f,0 10px 30px #24201914;}
  *{box-sizing:border-box} html,body{height:100%}
  body{margin:0;background:var(--bg);background-image:var(--bg-accent);color:var(--text);
    font-family:'Manrope',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:15px;font-weight:300;line-height:1.45;-webkit-font-smoothing:antialiased}
  button,input,textarea{font-family:inherit} svg{display:block}
  .app{height:100dvh;max-width:940px;margin:0 auto;padding:0 18px;display:flex;flex-direction:column}
  .topbar{flex:0 0 auto;display:flex;align-items:center;gap:12px;padding:16px 2px 14px}
  .brand{display:flex;align-items:center;gap:10px;min-width:0}
  .brand-mark{width:30px;height:30px;flex:0 0 auto;border-radius:8px;object-fit:cover;box-shadow:0 1px 5px #00000038}
  .brand-fallback{width:30px;height:30px;border-radius:8px;background:var(--faint);border:1px solid var(--border);display:grid;place-items:center;color:var(--primary);font-size:16px}
  .brand-name{font-size:15px;font-weight:600;letter-spacing:-.01em;white-space:nowrap}
  .brand-sub{color:var(--subtle);font-size:12px;white-space:nowrap}
  .nick{display:flex;align-items:center;gap:6px;margin-left:6px;min-width:0;flex:1}
  .nick input{background:transparent;border:1px solid transparent;color:var(--text);font-size:14px;font-weight:500;padding:5px 8px;border-radius:8px;min-width:0;width:100%;max-width:220px}
  .nick input::placeholder{color:var(--subtle);font-weight:300}
  .nick input:hover{border-color:var(--border)} .nick input:focus{outline:none;border-color:var(--primary);background:var(--surface)}
  .nick .save{flex:0 0 auto;font-size:12px;padding:5px 10px;opacity:0;transition:opacity .15s} .nick.dirty .save,.nick .save.show{opacity:1}
  .topbar-right{margin-left:auto;display:flex;align-items:center;gap:8px}
  .pill{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;color:var(--muted);background:var(--surface);border:1px solid var(--border);padding:5px 11px;border-radius:999px;white-space:nowrap}
  .pill .v{color:var(--subtle)}
  .dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:var(--subtle)} .dot.good{background:var(--good);box-shadow:0 0 7px var(--good)} .dot.bad{background:var(--bad)}
  .iconbtn{width:34px;height:34px;flex:0 0 auto;display:grid;place-items:center;background:var(--surface);color:var(--muted);border:1px solid var(--border);border-radius:9px;cursor:pointer}
  .iconbtn:hover{background:var(--surface-hover);color:var(--text);border-color:var(--border-strong)}
  .iconbtn.sm{width:28px;height:28px} .iconbtn.sm svg{width:15px;height:15px}
  .menuwrap{position:relative}
  .menu{position:absolute;right:0;top:40px;background:var(--surface-2);border:1px solid var(--border);border-radius:10px;box-shadow:var(--shadow);padding:6px;min-width:210px;z-index:20;display:none}
  .menu.open{display:block}
  .menu button{display:flex;align-items:center;gap:9px;width:100%;text-align:left;background:transparent;border:0;color:var(--text);font-size:14px;padding:9px 10px;border-radius:7px;cursor:pointer;font-weight:400;white-space:nowrap}
  .menu button:hover{background:var(--surface-hover)} .menu button svg{color:var(--muted)}
  .toast{flex:0 0 auto;display:none;background:color-mix(in srgb,var(--bad) 14%,var(--surface));border:1px solid color-mix(in srgb,var(--bad) 40%,var(--border));color:var(--text);border-radius:var(--radius-sm);padding:9px 13px;margin-bottom:10px;font-size:13.5px}
  .toast.show{display:block}
  .main{flex:1 1 auto;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:14px;padding-bottom:4px}
  .stats{flex:0 0 auto;display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
  .stat{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:15px 16px;box-shadow:var(--shadow)}
  .stat.hero{background:linear-gradient(180deg,var(--faint),transparent),var(--surface);border-color:var(--border-strong)}
  .stat .num{font-size:32px;font-weight:600;letter-spacing:-.02em;line-height:1.1;color:var(--primary)}
  .stat .num.small{font-size:22px;color:var(--text)}
  .stat .lbl{color:var(--muted);font-size:12.5px;margin-top:3px} .stat .sub{color:var(--subtle);font-size:11.5px;margin-top:3px}
  @media(max-width:560px){.stats{grid-template-columns:1fr 1fr}.stat.hero{grid-column:span 2}}
  .panel{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow)}
  .panel-head{display:flex;align-items:center;gap:10px;padding:14px 16px 12px;border-bottom:1px solid var(--border)}
  .panel-head h2{font-size:14px;font-weight:600;margin:0} .count{color:var(--subtle);font-size:12px}
  .list{padding:8px} .empty{color:var(--subtle);font-size:13.5px;text-align:center;padding:26px 12px;line-height:1.6}
  .gitem{display:flex;align-items:center;gap:12px;padding:11px 12px;border-radius:10px} .gitem:hover{background:var(--surface-hover)}
  .live{width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:var(--good);box-shadow:0 0 6px var(--good)} .live.off{background:var(--subtle);box-shadow:none}
  .gmain{flex:1;min-width:0} .gname{font-size:14px;font-weight:500} .gname .id{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--subtle);margin-left:7px}
  .gstate{color:var(--subtle);font-size:12px;margin-top:2px}
  .actionbar{flex:0 0 auto;display:flex;align-items:center;gap:12px;padding:12px 2px 16px}
  .identity{display:flex;align-items:center;gap:8px;min-width:0}
  .identity .mono{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--subtle);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:340px}
  .spacer{flex:1}
  button.primary{display:inline-flex;align-items:center;gap:7px;font-weight:600;font-size:14px;padding:10px 16px;border-radius:10px;cursor:pointer;border:1px solid var(--primary);background:var(--primary);color:var(--on-primary)}
  button.primary:hover{filter:brightness(1.06)} button:disabled{opacity:.5;cursor:default}
  button.ghost{font-weight:600;font-size:13px;padding:8px 14px;border-radius:9px;cursor:pointer;background:transparent;color:var(--muted);border:1px solid var(--border)}
  button.ghost:hover{border-color:var(--border-strong);color:var(--text)}
  button.danger{background:transparent;color:var(--bad);border:1px solid transparent;font-size:12px;padding:6px 10px;border-radius:8px;cursor:pointer;font-weight:600} button.danger:hover{border-color:var(--bad)}
  .overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);display:none;align-items:center;justify-content:center;padding:18px;z-index:50} .overlay.open{display:flex}
  .modal{background:var(--surface);border:1px solid var(--border-strong);border-radius:16px;box-shadow:var(--shadow);width:420px;max-width:100%;padding:20px}
  .modal.confirm{width:360px} .modal.confirm h3{margin:0 0 8px;font-size:16px} .confirm-actions{display:flex;gap:10px;justify-content:flex-end;margin-top:16px}
  .modal-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px} .modal-head h3{margin:0;font-size:16px;font-weight:600}
  .tabs{display:flex;gap:8px;margin-bottom:14px} .tabs button{flex:1;justify-content:center}
  .qr img{width:280px;max-width:100%;background:#fff;padding:12px;border-radius:12px}
  textarea{width:100%;background:var(--bg);border:1px solid var(--border);border-radius:9px;color:var(--text);font-family:ui-monospace,Menlo,monospace;font-size:12px;padding:10px 12px;min-height:80px;resize:vertical;font-weight:300} textarea:focus{outline:none;border-color:var(--primary)}
  .hint{color:var(--subtle);font-size:12.5px;line-height:1.5} .center{text-align:center}
  .flash{font-size:13px;margin-top:10px} .flash.ok{color:var(--good)} .flash.err{color:var(--bad)}
  .stack{display:flex;flex-direction:column;gap:12px;align-items:center}
</style></head>
<body><div class="app">
  <header class="topbar">
    <div class="brand"><img class="brand-mark" id="brandmark" src="<!--BRAND-->" alt=""/><div><div class="brand-name">PearCal Seeder</div><div class="brand-sub">blind group replicator</div></div></div>
    <div class="nick" id="nickwrap"><input id="nick" placeholder="Nickname" maxlength="64"/><button class="ghost save" id="nicksave">Save</button></div>
    <div class="topbar-right">
      <span class="pill"><span id="dot" class="dot"></span><span id="live">offline</span><span class="v" id="ver"><!--VERSION--></span></span>
      <button class="iconbtn" id="theme" title="Toggle theme"></button>
      <div class="menuwrap"><button class="iconbtn" id="menubtn" title="Menu"></button>
        <div class="menu" id="menu"><button id="m-maint"></button><button id="m-support"></button></div></div>
    </div>
  </header>
  <div class="toast" id="toast"></div>
  <div class="main">
    <div class="stats">
      <div class="stat hero"><div class="num" id="s-groups">—</div><div class="lbl" id="s-groupslbl">groups kept alive</div><div class="sub" id="s-peers"></div></div>
      <div class="stat"><div class="num small" id="s-up">—</div><div class="lbl">uptime</div></div>
      <div class="stat"><div class="num small" id="s-data">—</div><div class="lbl">replicated</div></div>
    </div>
    <div class="panel">
      <div class="panel-head"><h2>Groups</h2><span class="count" id="gcount"></span></div>
      <div class="list" id="groups"><div class="empty">Connecting to the seeder…</div></div>
    </div>
  </div>
  <div class="actionbar">
    <div class="identity"><span class="mono" id="pk">—</span><button class="iconbtn sm" id="copy" title="Copy seeder ID"></button></div>
    <div class="spacer"></div>
    <button class="primary" id="add"></button>
  </div>
</div>

<div class="overlay" id="addov"><div class="modal">
  <div class="modal-head"><h3>Add a device</h3><button class="iconbtn" id="add-x" style="font-size:15px">✕</button></div>
  <div class="tabs"><button class="primary" id="tab-pair">Pair a device</button><button class="ghost" id="tab-paste">Paste invite</button></div>
  <div id="pane-pair" class="stack">
    <div class="hint center">Scan in PearCal → Profile → Advanced → Blind peer → Admit a blind peer.</div>
    <div id="qrbox" class="qr" style="display:none;text-align:center"><img id="qr" alt="pairing QR"/><div class="hint" id="pairmsg" style="margin-top:8px"></div></div>
    <button class="primary" id="pairbtn">Show pairing QR</button>
  </div>
  <div id="pane-paste" class="stack" style="display:none;align-items:stretch">
    <div class="hint">Paste a seed invite or an all-groups bundle:</div>
    <textarea id="inv" placeholder="https://peerloomllc.com/seed?..."></textarea>
    <div style="display:flex;gap:10px;align-items:center"><button class="primary" id="enroll">Enroll</button><span id="enrollmsg" class="flash"></span></div>
  </div>
</div></div>

<div class="overlay" id="maintov"><div class="modal">
  <div class="modal-head"><h3>Maintenance</h3><button class="iconbtn" id="maint-x" style="font-size:15px">✕</button></div>
  <div class="stack"><div class="hint center">Restart briefly disconnects, then re-syncs and re-mounts all groups on boot.</div>
    <div style="display:flex;gap:10px;align-items:center;justify-content:center"><button class="ghost" id="restart">Restart seeder</button><span id="restartmsg" class="flash"></span></div></div>
</div></div>

<div class="overlay" id="supov"><div class="modal">
  <div class="modal-head"><h3>Support Development</h3><button class="iconbtn" id="sup-x" style="font-size:15px">✕</button></div>
  <div class="stack">
    <div class="hint center">No accounts, no servers, no subscriptions. If running this seeder is useful, a tip helps keep PearCal free — entirely optional.</div>
    <div class="tabs" style="width:100%"><button class="primary" id="sup-ln">⚡ Lightning</button><button class="ghost" id="sup-onchain">₿ On-chain</button><button class="ghost" id="sup-bmc">💲 Card</button></div>
    <img class="qr" id="supqr" alt="donation QR" style="width:190px;background:#fff;padding:10px;border-radius:12px"/>
    <div class="hint center" id="suphint"></div>
    <div class="mono center" id="supval" style="color:var(--muted);font-size:12px;word-break:break-all"></div>
    <div style="display:flex;gap:10px"><button class="ghost" id="supcopy">Copy</button><button class="primary" id="supopen" style="display:none">Open</button></div>
    <div id="supwallets" style="display:none;width:100%"><div class="hint" style="margin-bottom:6px">New to Lightning? Try a wallet:</div><div id="walletrow" style="display:flex;flex-wrap:wrap;gap:8px"></div></div>
  </div>
</div></div>

<div class="overlay" id="confov"><div class="modal confirm">
  <h3 id="conf-title">Confirm</h3><p class="hint" id="conf-msg"></p>
  <div class="confirm-actions"><button class="ghost" id="conf-cancel">Cancel</button><button class="danger" id="conf-ok" style="border-color:var(--bad);padding:8px 16px">Confirm</button></div>
</div></div>

<script>
const ICONS=${JSON.stringify(I)};
const $=id=>document.getElementById(id);
const T=new URLSearchParams(location.search).get('t')||'';
const q=p=>p+(p.includes('?')?'&':'?')+'t='+encodeURIComponent(T);
const post=(p,b)=>fetch(q(p),{method:'POST',headers:b?{'content-type':'application/json'}:{},body:b?JSON.stringify(b):undefined}).then(r=>r.json());
function fmtUp(ms){if(!ms)return'—';const s=Math.floor(ms/1000),d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);return (d?d+'d ':'')+(h?h+'h ':'')+m+'m';}
function fmtBytes(n){if(!n)return'0 B';const u=['B','KB','MB','GB','TB'];const i=Math.min(Math.floor(Math.log(n)/Math.log(1024)),u.length-1);return (n/Math.pow(1024,i)).toFixed(i?1:0)+' '+u[i];}
// icons + brand
$('menubtn').innerHTML=ICONS.gear;$('copy').innerHTML=ICONS.copy;$('add').innerHTML=ICONS.plus+'<span>Add a device</span>';
$('m-maint').innerHTML=ICONS.wrench+'<span>Maintenance</span>';$('m-support').innerHTML=ICONS.heart+'<span>Support Development</span>';
// brand: server injected a data URI into #brandmark src; empty -> ◆ fallback
if(!$('brandmark').getAttribute('src'))$('brandmark').replaceWith(Object.assign(document.createElement('span'),{className:'brand-fallback',textContent:'◆'}));
// theme
function sysDark(){return !matchMedia('(prefers-color-scheme: light)').matches;}
function curTheme(){return document.documentElement.dataset.theme||(sysDark()?'dark':'light');}
function applyThemeIcon(){$('theme').innerHTML=curTheme()==='dark'?ICONS.sun:ICONS.moon;}
{const s=localStorage.getItem('theme');if(s)document.documentElement.dataset.theme=s;}
applyThemeIcon();
$('theme').onclick=()=>{const n=curTheme()==='dark'?'light':'dark';document.documentElement.dataset.theme=n;localStorage.setItem('theme',n);applyThemeIcon();};
// toast
let toastT;function toast(m){$('toast').textContent=m;$('toast').classList.add('show');clearTimeout(toastT);toastT=setTimeout(()=>$('toast').classList.remove('show'),5000);}
// confirm
let confResolve;function askConfirm(title,msg){$('conf-title').textContent=title;$('conf-msg').textContent=msg;$('confov').classList.add('open');return new Promise(r=>confResolve=r);}
$('conf-cancel').onclick=()=>{$('confov').classList.remove('open');confResolve&&confResolve(false);};
$('conf-ok').onclick=()=>{$('confov').classList.remove('open');confResolve&&confResolve(true);};
// nickname
let nickDirty=false;$('nick').addEventListener('input',()=>{nickDirty=true;$('nickwrap').classList.add('dirty');});
$('nicksave').onclick=async()=>{await post('/api/nickname',{name:$('nick').value});nickDirty=false;$('nickwrap').classList.remove('dirty');$('nicksave').classList.add('show');setTimeout(()=>$('nicksave').classList.remove('show'),1200);};
// render
function render(r){
  const s=r.status||{},en=r.enrolled||[];
  $('s-groups').textContent=s.enrolled??en.length;$('s-groupslbl').textContent=((s.enrolled??en.length)===1?'group kept alive':'groups kept alive');
  $('s-peers').textContent=(s.peers??0)+' peer'+((s.peers??0)===1?'':'s')+' connected';
  $('s-up').textContent=fmtUp(s.uptime);$('s-data').textContent=fmtBytes(s.bytes||0);
  $('pk').textContent=s.pubkey||'—';$('pk').dataset.full=s.pubkey||'';
  if(!nickDirty&&document.activeElement!==$('nick'))$('nick').value=s.nickname||'';
  $('gcount').textContent=en.length?'· '+en.length:'';
  const list=$('groups');list.innerHTML='';
  if(!en.length){list.innerHTML='<div class="empty"><strong>No groups yet.</strong><br>Add one below — pair a phone, or paste a seed invite from a member\\'s Profile → Advanced → Blind peer.</div>';return;}
  for(const g of en){
    const row=document.createElement('div');row.className='gitem';
    row.innerHTML='<span class="live'+(s.booted?'':' off')+'"></span><div class="gmain"><div class="gname">'+(g.name||'Group').replace(/[<>]/g,'')+'<span class="id">'+String(g.groupId||'').slice(0,8)+'</span></div><div class="gstate">'+fmtBytes(g.bytes||0)+' · '+(g.blocks||0).toLocaleString()+' blocks · '+(g.writers||0)+' writer'+((g.writers||0)===1?'':'s')+'</div></div>';
    const b=document.createElement('button');b.className='danger';b.textContent='Leave';
    b.onclick=async()=>{if(!await askConfirm('Stop seeding?','The seeder will drop "'+(g.name||g.groupId)+'" and its stored data.'))return;const r=await post('/api/leave',{groupId:g.groupId});if(r.error)toast(r.error);};
    row.appendChild(b);list.appendChild(row);
  }
}
// live push (SSE); pill = dashboard↔seeder connection
function setLive(on){$('dot').className='dot '+(on?'good':'bad');$('live').textContent=on?'live':'offline';}
function connect(){const es=new EventSource(q('/api/events'));
  es.addEventListener('status',e=>{setLive(true);try{render(JSON.parse(e.data));}catch(_){}} );
  es.addEventListener('pair',e=>{try{const d=JSON.parse(e.data);$('qrbox').style.display='block';$('qr').style.display='none';$('pairmsg').textContent='✓ Paired — now seeding '+(d.enrolled||0)+' group'+((d.enrolled||0)===1?'':'s')+(d.names&&d.names.length?': '+d.names.join(', '):'');}catch(_){}} );
  es.onerror=()=>setLive(false);}
connect();
// copy
$('copy').onclick=()=>{const v=$('pk').dataset.full;if(!v)return;navigator.clipboard?.writeText(v);$('copy').style.color='var(--good)';setTimeout(()=>$('copy').style.color='',900);};
// menu
$('menubtn').onclick=e=>{e.stopPropagation();$('menu').classList.toggle('open');};
document.addEventListener('click',()=>$('menu').classList.remove('open'));
$('m-maint').onclick=()=>{$('menu').classList.remove('open');$('maintov').classList.add('open');};
$('maint-x').onclick=()=>$('maintov').classList.remove('open');
// add
function setTab(t){const pair=t==='pair';$('tab-pair').className=pair?'primary':'ghost';$('tab-paste').className=pair?'ghost':'primary';$('pane-pair').style.display=pair?'flex':'none';$('pane-paste').style.display=pair?'none':'flex';}
$('add').onclick=()=>{$('addov').classList.add('open');setTab('pair');};
$('add-x').onclick=()=>{$('addov').classList.remove('open');post('/api/pair/close').catch(()=>{});};
$('tab-pair').onclick=()=>setTab('pair');$('tab-paste').onclick=()=>setTab('paste');
$('pairbtn').onclick=async()=>{$('pairbtn').textContent='…';try{const r=await post('/api/pair/open');if(r.qr){$('qr').src=r.qr;$('qr').style.display='';$('qrbox').style.display='block';$('pairmsg').textContent='Valid ~5 min · scan in PearCal';}else{$('qrbox').style.display='block';$('pairmsg').textContent=r.error||'could not open pairing';}}catch(e){toast(e.message);}$('pairbtn').textContent='Show pairing QR';};
$('enroll').onclick=async()=>{const inv=$('inv').value.trim();if(!inv)return;$('enroll').disabled=true;$('enrollmsg').textContent='';try{const r=await post('/api/enroll',{invite:inv});if(r.error){$('enrollmsg').className='flash err';$('enrollmsg').textContent=r.error;}else{$('enrollmsg').className='flash ok';$('enrollmsg').textContent='Enrolled';$('inv').value='';}}catch(e){$('enrollmsg').className='flash err';$('enrollmsg').textContent=e.message;}$('enroll').disabled=false;};
// support
let supTab='ln';
const SUP_HINTS={ln:'Scan with any Lightning wallet (pick your own amount), or copy the address.',onchain:'On-chain BTC — higher fees, so Lightning is cheaper for small tips.',bmc:'Scan to open Buy Me a Coffee, or open it here to pay by card.'};
async function loadDonate(){try{const r=await fetch(q('/api/donate?tab='+supTab)).then(x=>x.json());
  $('supqr').src=r.qr||'';$('supval').textContent=r.value||'';$('suphint').textContent=SUP_HINTS[supTab]||'';
  $('supopen').style.display=supTab==='bmc'?'':'none';
  for(const [id,t] of [['sup-ln','ln'],['sup-onchain','onchain'],['sup-bmc','bmc']])$(id).className=supTab===t?'primary':'ghost';
  const w=r.wallets||[];$('supwallets').style.display=w.length?'block':'none';
  $('walletrow').innerHTML=w.map(x=>'<a href="'+x.url+'" target="_blank" rel="noopener" style="text-decoration:none"><button class="ghost" style="font-size:12px;padding:6px 12px">'+x.name+'</button></a>').join('');
}catch(_){}}
$('m-support').onclick=()=>{$('menu').classList.remove('open');$('supov').classList.add('open');loadDonate();};
$('sup-x').onclick=()=>$('supov').classList.remove('open');
$('sup-ln').onclick=()=>{supTab='ln';loadDonate();};$('sup-onchain').onclick=()=>{supTab='onchain';loadDonate();};$('sup-bmc').onclick=()=>{supTab='bmc';loadDonate();};
$('supcopy').onclick=()=>{navigator.clipboard?.writeText($('supval').textContent);$('supcopy').textContent='Copied';setTimeout(()=>$('supcopy').textContent='Copy',1200);};
$('supopen').onclick=()=>window.open($('supval').textContent,'_blank','noopener');
// maintenance
$('restart').onclick=async()=>{if(!await askConfirm('Restart the seeder?','It will briefly disconnect, then re-sync on boot.'))return;$('restart').disabled=true;$('restartmsg').className='flash';$('restartmsg').textContent='Restarting…';try{await post('/api/restart');}catch(e){}setTimeout(()=>{$('restart').disabled=false;$('restartmsg').textContent='';$('maintov').classList.remove('open');},6000);};
</script>
</body></html>`

module.exports = { startDashboard }
