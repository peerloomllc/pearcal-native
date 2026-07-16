// Monitoring + management dashboard for the PearCal seeder launcher. A focused
// port of PearCircle's host/server.js + ui, in PearCal's palette + Manrope.
//
// - Overview: editable nickname, seeder ID, uptime, group counts, enrolled
//   groups with per-group leave.
// - Add a device: pairing QR (drives seeder:pair:open on the live worklet) +
//   paste-to-enroll for a seed invite / all-groups bundle.
// - Maintenance: restart.
//
// Extras: token auth (auth.js), live push via Server-Sent Events (no polling,
// instant pair-result feedback — SSE rather than raw WebSocket keeps the payload
// dependency-free while giving the same one-way live updates), and offline fonts
// (Manrope woff2 inlined when host/fonts.css is staged, else a Google Fonts
// fallback). Update/retention panels remain follow-ups (no such feature yet).

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const auth = require('./auth')

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
  // Inlined offline font CSS if the stage step produced host/fonts.css.
  let fontStyle
  try {
    const css = fs.readFileSync(path.join(__dirname, 'fonts.css'), 'utf8')
    fontStyle = '<style>' + css + '</style>'
  } catch {
    fontStyle = "<style>@import url('https://fonts.googleapis.com/css2?family=Manrope:wght@300;400;500;600;700&display=swap');</style>"
  }
  const page = PAGE.replace('<!--FONTS-->', fontStyle)

  const authed = (req) => !token || auth.verify(req, token)
  const clients = new Set() // SSE response streams

  const broadcast = (event, data) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const res of clients) { try { res.write(payload) } catch {} }
  }

  // Live pairing feedback: relay the worklet's pair result to all dashboards.
  worklet.on('event', ({ name, data }) => {
    if (name === 'seeder:pair:result') broadcast('pair', data || {})
  })

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
      if (req.method === 'POST' && p === '/api/pair/open') {
        const r = await worklet.call('seeder:pair:open', {}).catch((e) => ({ error: e.message }))
        let qr = null
        if (r && r.link) { try { qr = await require('qrcode').toDataURL(r.link, { width: 320, margin: 2 }) } catch {} }
        return sendJson(res, { ...r, qr })
      }
      if (req.method === 'POST' && p === '/api/pair/close') {
        return sendJson(res, await worklet.call('seeder:pair:close', {}).catch((e) => ({ error: e.message })))
      }
      if (req.method === 'POST' && p === '/api/enroll') {
        const { invite } = await readBody(req)
        if (!invite) return sendJson(res, { error: 'invite required' }, 400)
        const r = await worklet.call('seeder:enroll', { invite }).catch((e) => ({ error: e.message }))
        broadcast('status', await snapshot(worklet))
        return sendJson(res, r)
      }
      if (req.method === 'POST' && p === '/api/leave') {
        const { groupId } = await readBody(req)
        if (!groupId) return sendJson(res, { error: 'groupId required' }, 400)
        const r = await worklet.call('seeder:leave', { groupId }).catch((e) => ({ error: e.message }))
        broadcast('status', await snapshot(worklet))
        return sendJson(res, r)
      }
      if (req.method === 'POST' && p === '/api/nickname') {
        const { name } = await readBody(req)
        const r = await worklet.call('seeder:nickname:set', { name: name || '' }).catch((e) => ({ error: e.message }))
        broadcast('status', await snapshot(worklet))
        return sendJson(res, r)
      }
      if (req.method === 'POST' && p === '/api/restart') {
        worklet.stop().catch(() => {}) // launcher auto-respawns on exit
        return sendJson(res, { ok: true })
      }
      res.writeHead(404); res.end('not found')
    } catch (e) {
      res.writeHead(500); res.end(String(e && e.message || e))
    }
  })

  // Push a status snapshot to all live dashboards every 2s (server-driven — the
  // page never polls).
  const ticker = setInterval(async () => {
    if (clients.size === 0) return
    try { broadcast('status', await snapshot(worklet)) } catch {}
  }, 2000)
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
    --bg:#0E0D0C; --card:#1A1916; --elev:#252220; --border:#2C2A26; --divider:#232120;
    --tx:#F2EFE8; --tx2:#B8B2A6; --muted:#8A8478; --gold:#C8922A; --ink:#1A1916;
    --ok:#5DBF8A; --err:#C0504A; --faint:rgba(200,146,42,0.12); color-scheme:dark;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--tx);
    font-family:'Manrope',-apple-system,BlinkMacSystemFont,sans-serif;font-weight:300;
    -webkit-font-smoothing:antialiased;padding:28px 16px 60px}
  .wrap{max-width:640px;margin:0 auto}
  header{display:flex;align-items:center;gap:12px;margin-bottom:22px}
  .logo{width:34px;height:34px;border-radius:9px;background:var(--faint);border:1px solid var(--border);
    display:flex;align-items:center;justify-content:center;color:var(--gold);font-size:18px}
  h1{font-size:20px;font-weight:600;margin:0;letter-spacing:-.01em}
  .sub{font-size:12px;color:var(--muted);display:flex;align-items:center;gap:6px}
  .dot{width:8px;height:8px;border-radius:50%;background:var(--muted)}
  .dot.on{background:var(--ok);box-shadow:0 0 7px var(--ok)} .dot.off{background:var(--err);box-shadow:0 0 7px var(--err)}
  .panel{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:18px 20px;margin-bottom:16px}
  h2{font-size:12px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);margin:0 0 14px}
  .row{display:flex;justify-content:space-between;gap:14px;padding:9px 0;border-bottom:1px solid var(--divider);font-size:14px}
  .row:last-child{border-bottom:0}
  .label{color:var(--tx2)} .val{text-align:right;word-break:break-all}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--tx2)}
  .muted{color:var(--muted);font-size:13px}
  button{font-family:inherit;font-weight:600;font-size:14px;padding:10px 16px;border-radius:10px;cursor:pointer;
    border:1px solid var(--gold);background:var(--gold);color:var(--ink);transition:filter .15s}
  button:hover{filter:brightness(1.06)} button:disabled{opacity:.5;cursor:default}
  button.ghost{background:transparent;color:var(--tx2);border-color:var(--border)}
  button.danger{background:transparent;color:var(--err);border-color:var(--err);padding:6px 12px;font-size:12px}
  .glist{margin-top:10px;display:flex;flex-direction:column;gap:8px}
  .gitem{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--border);border-radius:10px}
  .gitem .nm{flex:1;min-width:0}
  input,textarea{width:100%;background:var(--bg);border:1px solid var(--border);border-radius:9px;color:var(--tx);
    font-family:inherit;font-size:14px;padding:10px 12px;font-weight:300}
  input:focus,textarea:focus{outline:none;border-color:var(--gold)}
  textarea{min-height:70px;resize:vertical;font-family:ui-monospace,Menlo,monospace;font-size:12px}
  .qr{text-align:center;margin-top:14px}
  .qr img{width:300px;max-width:100%;background:#fff;padding:12px;border-radius:12px}
  .rowbtns{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:12px}
  .flash{font-size:13px;margin-top:10px}
  .flash.ok{color:var(--ok)} .flash.err{color:var(--err)}
  .nick{display:flex;gap:8px;align-items:center} .nick input{max-width:220px}
</style></head>
<body><div class="wrap">
  <header>
    <div class="logo">◆</div>
    <div><h1>PearCal Seeder</h1>
      <div class="sub"><span id="dot" class="dot off"></span><span id="ststate">connecting…</span></div></div>
  </header>

  <div class="panel"><h2>Overview</h2>
    <div class="row"><div class="label">Nickname</div>
      <div class="val nick"><input id="nick" placeholder="Home server" maxlength="64"/><button id="nicksave" class="ghost" style="padding:7px 12px">Save</button></div></div>
    <div class="row"><div class="label">Seeder ID</div><div class="val mono" id="pk">—</div></div>
    <div class="row"><div class="label">Uptime</div><div class="val" id="up">—</div></div>
    <div class="row"><div class="label">Groups</div><div class="val" id="cnt">—</div></div>
    <div id="groups" class="glist"></div>
  </div>

  <div class="panel"><h2>Add a device</h2>
    <div class="muted">On the phone: <b>Profile → Advanced → Blind peer → Admit a blind peer → Scan</b>. The QR is single-use.</div>
    <div class="rowbtns"><button id="pair">Show pairing QR</button><button id="pairclose" class="ghost" style="display:none">Done</button></div>
    <div id="pairbox" style="display:none" class="qr"><img id="qr" alt="pairing QR"/><div class="muted" id="pairmsg" style="margin-top:8px"></div></div>
    <div style="margin-top:16px"><div class="muted" style="margin-bottom:6px">Or paste a seed invite / all-groups bundle:</div>
      <textarea id="inv" placeholder="https://peerloomllc.com/seed?..."></textarea>
      <div class="rowbtns"><button id="enroll" class="ghost">Enroll</button><span id="enrollmsg" class="flash"></span></div></div>
  </div>

  <div class="panel"><h2>Maintenance</h2>
    <div class="muted">Restart briefly disconnects, then re-syncs and re-mounts all groups on boot.</div>
    <div class="rowbtns"><button id="restart" class="ghost">Restart seeder</button><span id="restartmsg" class="flash"></span></div>
  </div>
</div>
<script>
const $=id=>document.getElementById(id);
const T=new URLSearchParams(location.search).get('t')||'';
const q=p=>p+(p.includes('?')?'&':'?')+'t='+encodeURIComponent(T);
const post=(p,b)=>fetch(q(p),{method:'POST',headers:b?{'content-type':'application/json'}:{},body:b?JSON.stringify(b):undefined}).then(r=>r.json());
function fmtUp(ms){if(!ms)return'—';const s=Math.floor(ms/1000),d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);return (d?d+'d ':'')+(h?h+'h ':'')+m+'m';}
let nickDirty=false;$('nick').addEventListener('input',()=>nickDirty=true);
function render(r){
  const s=r.status||{},en=r.enrolled||[],ok=!!s.booted;
  $('dot').className='dot '+(ok?'on':'off');
  $('ststate').textContent=ok?'running':(s.error||'starting…');
  $('pk').textContent=s.pubkey||'—';$('up').textContent=fmtUp(s.uptime);
  $('cnt').textContent=(s.enrolled??en.length)+' enrolled · '+(s.mounted??0)+' mounted';
  if(!nickDirty&&document.activeElement!==$('nick'))$('nick').value=s.nickname||'';
  $('groups').innerHTML='';
  if(en.length){for(const g of en){
    const row=document.createElement('div');row.className='gitem';
    row.innerHTML='<div class="nm">'+(g.name||'Group').replace(/[<>]/g,'')+' <span class="mono">'+String(g.groupId||'').slice(0,8)+'</span></div>';
    const b=document.createElement('button');b.className='danger';b.textContent='Leave';
    b.onclick=async()=>{if(!confirm('Stop seeding "'+(g.name||g.groupId)+'"?'))return;await post('/api/leave',{groupId:g.groupId});};
    row.appendChild(b);$('groups').appendChild(row);
  }}else{$('groups').innerHTML='<div class="muted" style="margin-top:8px">No groups yet — admit a device below.</div>';}
}
// Live updates via SSE (no polling).
let es;
function connect(){
  es=new EventSource(q('/api/events'));
  es.addEventListener('status',e=>{try{render(JSON.parse(e.data));}catch(_){}} );
  es.addEventListener('pair',e=>{try{const d=JSON.parse(e.data);$('pairbox').style.display='block';$('pairmsg').textContent='✓ Paired — now seeding '+(d.enrolled||0)+' group'+((d.enrolled||0)===1?'':'s')+(d.names&&d.names.length?': '+d.names.join(', '):'');$('qr').style.display='none';setTimeout(()=>{$('qr').style.display='';$('pairbox').style.display='none';$('pairclose').style.display='none';},6000);}catch(_){}} );
  es.onerror=()=>{$('ststate').textContent='reconnecting…';$('dot').className='dot off';};
}
connect();
$('nicksave').onclick=async()=>{await post('/api/nickname',{name:$('nick').value});nickDirty=false;$('nicksave').textContent='Saved';setTimeout(()=>$('nicksave').textContent='Save',1500);};
$('pair').onclick=async()=>{$('pair').textContent='…';try{const r=await post('/api/pair/open');if(r.qr){$('qr').src=r.qr;$('qr').style.display='';$('pairbox').style.display='block';$('pairclose').style.display='';$('pairmsg').textContent='Valid ~5 min · scan in PearCal';}else{$('pairbox').style.display='block';$('pairmsg').textContent=r.error||'could not open pairing';}}catch(e){alert(e.message);}$('pair').textContent='Show pairing QR';};
$('pairclose').onclick=async()=>{try{await post('/api/pair/close');}catch(e){}$('pairbox').style.display='none';$('pairclose').style.display='none';};
$('enroll').onclick=async()=>{const inv=$('inv').value.trim();if(!inv)return;$('enroll').disabled=true;$('enrollmsg').textContent='';try{const r=await post('/api/enroll',{invite:inv});if(r.error){$('enrollmsg').className='flash err';$('enrollmsg').textContent=r.error;}else{$('enrollmsg').className='flash ok';$('enrollmsg').textContent='Enrolled';$('inv').value='';}}catch(e){$('enrollmsg').className='flash err';$('enrollmsg').textContent=e.message;}$('enroll').disabled=false;};
$('restart').onclick=async()=>{if(!confirm('Restart the seeder?'))return;$('restart').disabled=true;$('restartmsg').className='flash';$('restartmsg').textContent='Restarting…';try{await post('/api/restart');}catch(e){}setTimeout(()=>{$('restart').disabled=false;$('restartmsg').textContent='';},6000);};
</script>
</body></html>`

module.exports = { startDashboard }
