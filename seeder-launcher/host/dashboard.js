// Monitoring + management dashboard for the PearCal seeder launcher. Layout +
// hierarchy adapted from PearCircle's current seeder dashboard (topbar with
// brand + inline nickname + status pill + menu; a stats grid; identity row;
// groups panel; bottom actionbar; modals for Add-a-device and Maintenance),
// restyled in PearCal's palette (gold #C8922A) + Manrope.
//
// Extras: token auth (auth.js), live push via Server-Sent Events (no polling),
// offline fonts (host/fonts.css inlined when staged, else a Google Fonts
// fallback), and blind-safe metrics (storage/blocks/writers/peers — never event
// counts). Self-contained: one page, no build; QR rendered server-side.

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const auth = require('./auth')

// PeerLoom donation channels (shared across the app family).
const DONATE = { ln: 'peerloomllc@strike.me', bmc: 'https://buymeacoffee.com/peerloomllc?new=1' }

function sendJson (res, body, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
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

function startDashboard ({ worklet, port = 8731, host = '0.0.0.0', token = null, log }) {
  let fontStyle
  try {
    fontStyle = '<style>' + fs.readFileSync(path.join(__dirname, 'fonts.css'), 'utf8') + '</style>'
  } catch {
    fontStyle = "<style>@import url('https://fonts.googleapis.com/css2?family=Manrope:wght@300;400;500;600;700&display=swap');</style>"
  }
  const page = PAGE.replace('<!--FONTS-->', fontStyle)

  const authed = (req) => !token || auth.verify(req, token)
  const clients = new Set()
  const broadcast = (event, data) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const res of clients) { try { res.write(payload) } catch {} }
  }
  worklet.on('event', ({ name, data }) => { if (name === 'seeder:pair:result') broadcast('pair', data || {}) })

  const srv = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost')
      const p = url.pathname
      if (req.method === 'GET' && p === '/') {
        if (!authed(req)) { res.writeHead(401, { 'content-type': 'text/html' }); res.end(UNAUTH); return }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(page); return
      }
      if (!authed(req)) return sendJson(res, { error: 'unauthorized' }, 401)

      if (req.method === 'GET' && p === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
        res.write('retry: 3000\n\n')
        clients.add(res)
        snapshot(worklet).then((s) => { try { res.write(`event: status\ndata: ${JSON.stringify(s)}\n\n`) } catch {} })
        req.on('close', () => clients.delete(res))
        return
      }
      if (req.method === 'GET' && p === '/api/status') return sendJson(res, await snapshot(worklet))
      if (req.method === 'GET' && p === '/api/donate') {
        const tab = url.searchParams.get('tab') === 'bmc' ? 'bmc' : 'ln'
        const value = DONATE[tab]
        let qr = null
        try { qr = await require('qrcode').toDataURL(value, { width: 220, margin: 1, errorCorrectionLevel: 'M' }) } catch {}
        return sendJson(res, { tab, value, qr })
      }
      if (req.method === 'POST' && p === '/api/pair/open') {
        const r = await worklet.call('seeder:pair:open', {}).catch((e) => ({ error: e.message }))
        let qr = null
        if (r && r.link) { try { qr = await require('qrcode').toDataURL(r.link, { width: 320, margin: 2 }) } catch {} }
        return sendJson(res, { ...r, qr })
      }
      if (req.method === 'POST' && p === '/api/pair/close') return sendJson(res, await worklet.call('seeder:pair:close', {}).catch((e) => ({ error: e.message })))
      if (req.method === 'POST' && p === '/api/enroll') {
        const { invite } = await readBody(req)
        if (!invite) return sendJson(res, { error: 'invite required' }, 400)
        const r = await worklet.call('seeder:enroll', { invite }).catch((e) => ({ error: e.message }))
        broadcast('status', await snapshot(worklet)); return sendJson(res, r)
      }
      if (req.method === 'POST' && p === '/api/leave') {
        const { groupId } = await readBody(req)
        if (!groupId) return sendJson(res, { error: 'groupId required' }, 400)
        const r = await worklet.call('seeder:leave', { groupId }).catch((e) => ({ error: e.message }))
        broadcast('status', await snapshot(worklet)); return sendJson(res, r)
      }
      if (req.method === 'POST' && p === '/api/nickname') {
        const { name } = await readBody(req)
        const r = await worklet.call('seeder:nickname:set', { name: name || '' }).catch((e) => ({ error: e.message }))
        broadcast('status', await snapshot(worklet)); return sendJson(res, r)
      }
      if (req.method === 'POST' && p === '/api/restart') { worklet.stop().catch(() => {}); return sendJson(res, { ok: true }) }
      res.writeHead(404); res.end('not found')
    } catch (e) { res.writeHead(500); res.end(String(e && e.message || e)) }
  })

  const ticker = setInterval(async () => { if (clients.size) { try { broadcast('status', await snapshot(worklet)) } catch {} } }, 2000)
  if (typeof ticker.unref === 'function') ticker.unref()

  srv.on('error', (e) => log && log('dashboard', 'error: ' + e.message))
  srv.listen(port, host, () => {
    const shown = host === '0.0.0.0' ? 'localhost' : host
    log && log('dashboard', `listening on http://${shown}:${port}/` + (token ? `?t=${token}` : ''))
  })
  return srv
}

const UNAUTH = '<!doctype html><meta charset=utf-8><body style="font-family:sans-serif;background:#0E0D0C;color:#F2EFE8;padding:40px"><h2>Unauthorized</h2><p>Open the dashboard with the token URL printed in the seeder logs (…/?t=…).</p>'

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PearCal Seeder</title>
<!--FONTS-->
<style>
  :root{
    --bg:#0E0D0C; --bg-accent:radial-gradient(1200px 600px at 50% -12%, rgba(200,146,42,.10) 0%, transparent 60%);
    --surface:#1A1916; --surface-2:#252220; --surface-hover:#2C2A26; --border:#2C2A26; --border-strong:#3A372F;
    --text:#F2EFE8; --muted:#B8B2A6; --subtle:#8A8478; --primary:#C8922A; --primary-strong:#A5761F; --on-primary:#1A1916;
    --good:#5DBF8A; --warn:#E5864A; --bad:#C0504A; --faint:rgba(200,146,42,.12);
    --shadow:0 1px 2px #00000040, 0 8px 24px #00000030; --radius:14px; --radius-sm:9px; color-scheme:dark;
  }
  *{box-sizing:border-box}
  html,body{height:100%}
  body{margin:0;background:var(--bg);background-image:var(--bg-accent);color:var(--text);
    font-family:'Manrope',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:15px;font-weight:300;
    line-height:1.45;-webkit-font-smoothing:antialiased}
  button,input,textarea{font-family:inherit}
  .app{min-height:100dvh;max-width:940px;margin:0 auto;padding:0 18px 24px;display:flex;flex-direction:column}
  /* topbar */
  .topbar{display:flex;align-items:center;gap:12px;padding:16px 2px 14px}
  .brand{display:flex;align-items:center;gap:10px;min-width:0}
  .brand-mark{width:30px;height:30px;flex:0 0 auto;border-radius:8px;display:grid;place-items:center;
    background:var(--faint);border:1px solid var(--border);color:var(--primary);font-size:16px}
  .brand-name{font-size:15px;font-weight:600;letter-spacing:-.01em;white-space:nowrap}
  .brand-sub{color:var(--subtle);font-size:12px;white-space:nowrap}
  .nick{display:flex;align-items:center;gap:6px;margin-left:6px;min-width:0;flex:1}
  .nick input{background:transparent;border:1px solid transparent;color:var(--text);font-size:14px;font-weight:500;
    padding:5px 8px;border-radius:8px;min-width:0;width:100%;max-width:220px}
  .nick input::placeholder{color:var(--subtle);font-weight:300}
  .nick input:hover{border-color:var(--border)}
  .nick input:focus{outline:none;border-color:var(--primary);background:var(--surface)}
  .nick .save{flex:0 0 auto;font-size:12px;padding:5px 10px;opacity:0;transition:opacity .15s}
  .nick.dirty .save,.nick .save.show{opacity:1}
  .topbar-right{margin-left:auto;display:flex;align-items:center;gap:8px}
  .pill{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;color:var(--muted);background:var(--surface);
    border:1px solid var(--border);padding:5px 11px;border-radius:999px;white-space:nowrap}
  .pill .v{color:var(--subtle)}
  .dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:var(--subtle)}
  .dot.good{background:var(--good);box-shadow:0 0 7px var(--good)} .dot.bad{background:var(--bad)}
  .menuwrap{position:relative}
  .iconbtn{width:34px;height:34px;display:grid;place-items:center;background:var(--surface);color:var(--muted);
    border:1px solid var(--border);border-radius:9px;cursor:pointer;font-size:16px;line-height:1}
  .iconbtn:hover{background:var(--surface-hover);color:var(--text);border-color:var(--border-strong)}
  .menu{position:absolute;right:0;top:40px;background:var(--surface-2);border:1px solid var(--border);border-radius:10px;
    box-shadow:var(--shadow);padding:6px;min-width:210px;z-index:20;display:none}
  .menu.open{display:block}
  .menu button{display:flex;align-items:center;gap:8px;width:100%;text-align:left;background:transparent;border:0;
    color:var(--text);font-size:14px;padding:9px 10px;border-radius:7px;cursor:pointer;font-weight:400;white-space:nowrap}
  .menu button:hover{background:var(--surface-hover)}
  /* main */
  .main{display:flex;flex-direction:column;gap:14px;margin-top:2px}
  .stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
  .stat{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:15px 16px;box-shadow:var(--shadow)}
  .stat.hero{grid-column:span 1;background:linear-gradient(180deg,var(--faint),transparent),var(--surface);border-color:var(--border-strong)}
  .stat .num{font-size:26px;font-weight:600;letter-spacing:-.02em;line-height:1.1}
  .stat.hero .num{font-size:32px;color:var(--primary)}
  .stat .lbl{color:var(--muted);font-size:12.5px;margin-top:3px}
  .stat .sub{color:var(--subtle);font-size:11.5px;margin-top:2px}
  @media(max-width:560px){.stats{grid-template-columns:1fr 1fr}.stat.hero{grid-column:span 2}}
  /* identity */
  .identity{display:flex;align-items:center;gap:10px;background:var(--surface);border:1px solid var(--border);
    border-radius:var(--radius-sm);padding:11px 14px}
  .identity .lbl{color:var(--subtle);font-size:12px;flex:0 0 auto}
  .identity .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--muted);
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
  /* panel + groups */
  .panel{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow)}
  .panel-head{display:flex;align-items:center;gap:10px;padding:14px 16px 12px;border-bottom:1px solid var(--border)}
  .panel-head h2{font-size:14px;font-weight:600;margin:0}
  .count{color:var(--subtle);font-size:12px;background:var(--surface-2);border:1px solid var(--border);
    padding:1px 8px;border-radius:999px}
  .list{padding:8px}
  .empty{color:var(--subtle);font-size:13.5px;text-align:center;padding:26px 10px}
  .gitem{display:flex;align-items:center;gap:12px;padding:11px 12px;border-radius:10px}
  .gitem:hover{background:var(--surface-hover)}
  .live{width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:var(--good);box-shadow:0 0 6px var(--good)}
  .live.off{background:var(--subtle);box-shadow:none}
  .gmain{flex:1;min-width:0}
  .gname{font-size:14px;font-weight:500}
  .gname .id{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--subtle);margin-left:7px}
  .gstate{color:var(--subtle);font-size:12px;margin-top:2px}
  /* actionbar */
  .actionbar{display:flex;gap:10px;margin-top:16px}
  .spacer{flex:1}
  button.primary{font-weight:600;font-size:14px;padding:10px 18px;border-radius:10px;cursor:pointer;
    border:1px solid var(--primary);background:var(--primary);color:var(--on-primary)}
  button.primary:hover{filter:brightness(1.06)} button:disabled{opacity:.5;cursor:default}
  button.ghost{font-weight:600;font-size:13px;padding:8px 14px;border-radius:9px;cursor:pointer;
    background:transparent;color:var(--muted);border:1px solid var(--border)}
  button.ghost:hover{border-color:var(--border-strong);color:var(--text)}
  button.danger{background:transparent;color:var(--bad);border:1px solid transparent;font-size:12px;padding:6px 10px;
    border-radius:8px;cursor:pointer;font-weight:600}
  button.danger:hover{border-color:var(--bad)}
  /* modal */
  .overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);display:none;align-items:center;justify-content:center;
    padding:18px;z-index:50}
  .overlay.open{display:flex}
  .modal{background:var(--surface);border:1px solid var(--border-strong);border-radius:16px;box-shadow:var(--shadow);
    width:420px;max-width:100%;padding:20px}
  .modal-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
  .modal-head h3{margin:0;font-size:16px;font-weight:600}
  .tabs{display:flex;gap:8px;margin-bottom:14px}
  .tabs button{flex:1}
  .qr{text-align:center} .qr img{width:280px;max-width:100%;background:#fff;padding:12px;border-radius:12px}
  textarea{width:100%;background:var(--bg);border:1px solid var(--border);border-radius:9px;color:var(--text);
    font-family:ui-monospace,Menlo,monospace;font-size:12px;padding:10px 12px;min-height:80px;resize:vertical;font-weight:300}
  textarea:focus{outline:none;border-color:var(--primary)}
  .hint{color:var(--subtle);font-size:12.5px;line-height:1.5} .center{text-align:center}
  .flash{font-size:13px;margin-top:10px} .flash.ok{color:var(--good)} .flash.err{color:var(--bad)}
  .stack{display:flex;flex-direction:column;gap:12px}
</style></head>
<body><div class="app">
  <div class="topbar">
    <div class="brand"><div class="brand-mark">◆</div>
      <div><div class="brand-name">PearCal Seeder</div><div class="brand-sub">blind group replicator</div></div></div>
    <div class="nick" id="nickwrap"><input id="nick" placeholder="Nickname" maxlength="64"/><button class="ghost save" id="nicksave">Save</button></div>
    <div class="topbar-right">
      <span class="pill"><span id="dot" class="dot"></span><span id="ststate">connecting…</span><span class="v" id="uptime"></span></span>
      <div class="menuwrap"><button class="iconbtn" id="menubtn" title="Menu">⚙</button>
        <div class="menu" id="menu"><button id="m-maint">⟳ Maintenance</button><button id="m-support">♥ Support Development</button></div></div>
    </div>
  </div>

  <div class="main">
    <div class="stats">
      <div class="stat hero"><div class="num" id="s-groups">—</div><div class="lbl">Groups seeded</div><div class="sub" id="s-mounted"></div></div>
      <div class="stat"><div class="num" id="s-peers">—</div><div class="lbl">Peers connected</div></div>
      <div class="stat"><div class="num" id="s-data">—</div><div class="lbl">Data held</div><div class="sub" id="s-blocks"></div></div>
    </div>

    <div class="identity"><span class="lbl">Seeder ID</span><span class="mono" id="pk">—</span><button class="iconbtn" id="copy" title="Copy" style="width:30px;height:30px;font-size:13px">⧉</button></div>

    <div class="panel">
      <div class="panel-head"><h2>Groups</h2><span class="count" id="gcount">0</span></div>
      <div class="list" id="groups"><div class="empty">Loading…</div></div>
    </div>
  </div>

  <div class="actionbar"><div class="spacer"></div><button class="primary" id="add">+ Add a device</button></div>
</div>

<!-- Add-a-device modal -->
<div class="overlay" id="addov"><div class="modal">
  <div class="modal-head"><h3>Add a device</h3><button class="iconbtn" id="add-x" style="font-size:15px">✕</button></div>
  <div class="tabs"><button class="primary" id="tab-pair">Pair a device</button><button class="ghost" id="tab-paste">Paste invite</button></div>
  <div id="pane-pair" class="stack center">
    <div class="hint center">Scan in PearCal → Profile → Advanced → Blind peer → Admit a blind peer.</div>
    <div id="qrbox" class="qr" style="display:none"><img id="qr" alt="pairing QR"/><div class="hint" id="pairmsg" style="margin-top:8px"></div></div>
    <button class="primary" id="pairbtn">Show pairing QR</button>
  </div>
  <div id="pane-paste" class="stack" style="display:none">
    <div class="hint">Paste a seed invite or an all-groups bundle:</div>
    <textarea id="inv" placeholder="https://peerloomllc.com/seed?..."></textarea>
    <div style="display:flex;gap:10px;align-items:center"><button class="primary" id="enroll">Enroll</button><span id="enrollmsg" class="flash"></span></div>
  </div>
</div></div>

<!-- Maintenance modal -->
<div class="overlay" id="maintov"><div class="modal">
  <div class="modal-head"><h3>Maintenance</h3><button class="iconbtn" id="maint-x" style="font-size:15px">✕</button></div>
  <div class="stack"><div class="hint center">Restart briefly disconnects, then re-syncs and re-mounts all groups on boot.</div>
    <div style="display:flex;gap:10px;align-items:center;justify-content:center"><button class="ghost" id="restart">Restart seeder</button><span id="restartmsg" class="flash"></span></div></div>
</div></div>

<!-- Support modal -->
<div class="overlay" id="supov"><div class="modal">
  <div class="modal-head"><h3>Support development</h3><button class="iconbtn" id="sup-x" style="font-size:15px">✕</button></div>
  <div class="stack center">
    <div class="hint center">No accounts, no servers, no subscriptions. If running this seeder is useful, a tip helps keep PearCal free — entirely optional.</div>
    <div class="tabs" style="width:100%"><button class="primary" id="sup-ln">⚡ Bitcoin</button><button class="ghost" id="sup-bmc">💲 Card / USD</button></div>
    <img class="qr" id="supqr" alt="donation QR" style="width:200px;background:#fff;padding:10px;border-radius:12px"/>
    <div class="hint center" id="suphint"></div>
    <div class="mono center" id="supval" style="color:var(--muted);font-size:12px;word-break:break-all"></div>
    <div style="display:flex;gap:10px"><button class="ghost" id="supcopy">Copy</button><button class="primary" id="supopen" style="display:none">Open</button></div>
  </div>
</div></div>

<script>
const $=id=>document.getElementById(id);
const T=new URLSearchParams(location.search).get('t')||'';
const q=p=>p+(p.includes('?')?'&':'?')+'t='+encodeURIComponent(T);
const post=(p,b)=>fetch(q(p),{method:'POST',headers:b?{'content-type':'application/json'}:{},body:b?JSON.stringify(b):undefined}).then(r=>r.json());
function fmtUp(ms){if(!ms)return'';const s=Math.floor(ms/1000),d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);return (d?d+'d ':'')+(h?h+'h ':'')+m+'m';}
function fmtBytes(n){if(!n)return'0 B';const u=['B','KB','MB','GB','TB'];const i=Math.min(Math.floor(Math.log(n)/Math.log(1024)),u.length-1);return (n/Math.pow(1024,i)).toFixed(i?1:0)+' '+u[i];}
let live=false,nickDirty=false;
$('nick').addEventListener('input',()=>{nickDirty=true;$('nickwrap').classList.add('dirty');});
function render(r){
  const s=r.status||{},en=r.enrolled||[],ok=!!s.booted;live=ok;
  $('dot').className='dot '+(ok?'good':'bad');
  $('ststate').textContent=ok?'running':(s.error||'starting…');
  $('uptime').textContent=ok&&s.uptime?'· '+fmtUp(s.uptime):'';
  $('s-groups').textContent=s.enrolled??en.length;$('s-mounted').textContent=(s.mounted??0)+' mounted';
  $('s-peers').textContent=s.peers??0;
  $('s-data').textContent=fmtBytes(s.bytes||0);$('s-blocks').textContent=(s.blocks||0).toLocaleString()+' blocks';
  $('pk').textContent=s.pubkey||'—';$('pk').dataset.full=s.pubkey||'';
  if(!nickDirty&&document.activeElement!==$('nick'))$('nick').value=s.nickname||'';
  $('gcount').textContent=en.length;
  const list=$('groups');list.innerHTML='';
  if(!en.length){list.innerHTML='<div class="empty">No groups yet — add a device to start seeding.</div>';return;}
  for(const g of en){
    const row=document.createElement('div');row.className='gitem';
    row.innerHTML='<span class="live'+(ok?'':' off')+'"></span><div class="gmain"><div class="gname">'+(g.name||'Group').replace(/[<>]/g,'')+'<span class="id">'+String(g.groupId||'').slice(0,8)+'</span></div><div class="gstate">'+fmtBytes(g.bytes||0)+' · '+(g.blocks||0).toLocaleString()+' blocks · '+(g.writers||0)+' writer'+((g.writers||0)===1?'':'s')+'</div></div>';
    const b=document.createElement('button');b.className='danger';b.textContent='Leave';
    b.onclick=async()=>{if(!confirm('Stop seeding "'+(g.name||g.groupId)+'"?'))return;await post('/api/leave',{groupId:g.groupId});};
    row.appendChild(b);list.appendChild(row);
  }
}
// live push
function connect(){const es=new EventSource(q('/api/events'));
  es.addEventListener('status',e=>{try{render(JSON.parse(e.data));}catch(_){}} );
  es.addEventListener('pair',e=>{try{const d=JSON.parse(e.data);$('qrbox').style.display='block';$('qr').style.display='none';$('pairmsg').textContent='✓ Paired — now seeding '+(d.enrolled||0)+' group'+((d.enrolled||0)===1?'':'s')+(d.names&&d.names.length?': '+d.names.join(', '):'');}catch(_){}} );
  es.onerror=()=>{$('dot').className='dot bad';$('ststate').textContent='reconnecting…';};}
connect();
// nickname
$('nicksave').onclick=async()=>{await post('/api/nickname',{name:$('nick').value});nickDirty=false;$('nickwrap').classList.remove('dirty');$('nicksave').classList.add('show');setTimeout(()=>$('nicksave').classList.remove('show'),1200);};
// copy pubkey
$('copy').onclick=()=>{const v=$('pk').dataset.full;if(!v)return;navigator.clipboard?.writeText(v);$('copy').textContent='✓';setTimeout(()=>$('copy').textContent='⧉',1200);};
// menu
$('menubtn').onclick=e=>{e.stopPropagation();$('menu').classList.toggle('open');};
document.addEventListener('click',()=>$('menu').classList.remove('open'));
$('m-maint').onclick=()=>{$('menu').classList.remove('open');$('maintov').classList.add('open');};
$('maint-x').onclick=()=>$('maintov').classList.remove('open');
let supTab='ln';
async function loadDonate(){
  try{const r=await fetch(q('/api/donate?tab='+supTab)).then(x=>x.json());
    $('supqr').src=r.qr||'';$('supval').textContent=r.value||'';
    $('suphint').textContent=supTab==='ln'?'Scan with any Lightning wallet (pick your own amount), or copy the address.':'Scan to open Buy Me a Coffee, or open it here to pay by card.';
    $('supopen').style.display=supTab==='bmc'?'':'none';
    $('sup-ln').className=supTab==='ln'?'primary':'ghost';$('sup-bmc').className=supTab==='bmc'?'primary':'ghost';
  }catch(_){}
}
$('m-support').onclick=()=>{$('menu').classList.remove('open');$('supov').classList.add('open');loadDonate();};
$('sup-x').onclick=()=>$('supov').classList.remove('open');
$('sup-ln').onclick=()=>{supTab='ln';loadDonate();};
$('sup-bmc').onclick=()=>{supTab='bmc';loadDonate();};
$('supcopy').onclick=()=>{navigator.clipboard?.writeText($('supval').textContent);$('supcopy').textContent='Copied';setTimeout(()=>$('supcopy').textContent='Copy',1200);};
$('supopen').onclick=()=>window.open($('supval').textContent,'_blank','noopener');
// add-device modal + tabs
function openAdd(){$('addov').classList.add('open');setTab('pair');}
$('add').onclick=openAdd;$('add-x').onclick=()=>{$('addov').classList.remove('open');post('/api/pair/close').catch(()=>{});};
function setTab(t){const pair=t==='pair';$('tab-pair').className=pair?'primary':'ghost';$('tab-paste').className=pair?'ghost':'primary';$('pane-pair').style.display=pair?'flex':'none';$('pane-paste').style.display=pair?'none':'flex';}
$('tab-pair').onclick=()=>setTab('pair');$('tab-paste').onclick=()=>setTab('paste');
$('pairbtn').onclick=async()=>{$('pairbtn').textContent='…';try{const r=await post('/api/pair/open');if(r.qr){$('qr').src=r.qr;$('qr').style.display='';$('qrbox').style.display='block';$('pairmsg').textContent='Valid ~5 min · scan in PearCal';}else{$('qrbox').style.display='block';$('pairmsg').textContent=r.error||'could not open pairing';}}catch(e){alert(e.message);}$('pairbtn').textContent='Show pairing QR';};
$('enroll').onclick=async()=>{const inv=$('inv').value.trim();if(!inv)return;$('enroll').disabled=true;$('enrollmsg').textContent='';try{const r=await post('/api/enroll',{invite:inv});if(r.error){$('enrollmsg').className='flash err';$('enrollmsg').textContent=r.error;}else{$('enrollmsg').className='flash ok';$('enrollmsg').textContent='Enrolled';$('inv').value='';}}catch(e){$('enrollmsg').className='flash err';$('enrollmsg').textContent=e.message;}$('enroll').disabled=false;};
// maintenance
$('restart').onclick=async()=>{if(!confirm('Restart the seeder?'))return;$('restart').disabled=true;$('restartmsg').className='flash';$('restartmsg').textContent='Restarting…';try{await post('/api/restart');}catch(e){}setTimeout(()=>{$('restart').disabled=false;$('restartmsg').textContent='';$('maintov').classList.remove('open');},6000);};
</script>
</body></html>`

module.exports = { startDashboard }
