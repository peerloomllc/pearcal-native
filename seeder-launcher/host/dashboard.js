// Minimal monitoring + pairing dashboard for the PearCal seeder launcher.
// Serves a single self-contained page that polls status and drives QR pairing
// against the LIVE worklet (so admitting a group needs no stop/restart). A
// focused port of PearCircle's host/server.js (auth, WebSocket, update, and
// retention endpoints are follow-ups). No external deps — QR codes are rendered
// server-side via the bundled `qrcode` lib and returned as data URLs.

const http = require('node:http')

function sendJson (res, body, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function startDashboard ({ worklet, port = 8730, host = '0.0.0.0', log }) {
  const srv = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost')
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(PAGE)
        return
      }
      if (req.method === 'GET' && url.pathname === '/api/status') {
        const [status, enrolled] = await Promise.all([
          worklet.call('seeder:status', {}).catch((e) => ({ error: e.message })),
          worklet.call('seeder:enrolled:list', {}).catch(() => []),
        ])
        return sendJson(res, { status, enrolled })
      }
      if (req.method === 'POST' && url.pathname === '/api/pair/open') {
        const r = await worklet.call('seeder:pair:open', {}).catch((e) => ({ error: e.message }))
        let qr = null
        if (r && r.link) {
          try { qr = await require('qrcode').toDataURL(r.link, { width: 300, margin: 2 }) } catch {}
        }
        return sendJson(res, { ...r, qr })
      }
      if (req.method === 'POST' && url.pathname === '/api/pair/close') {
        return sendJson(res, await worklet.call('seeder:pair:close', {}).catch((e) => ({ error: e.message })))
      }
      res.writeHead(404); res.end('not found')
    } catch (e) {
      res.writeHead(500); res.end(String(e && e.message || e))
    }
  })
  srv.on('error', (e) => log && log('dashboard', 'error: ' + e.message))
  srv.listen(port, host, () => log && log('dashboard', `listening on http://${host}:${port}`))
  return srv
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PearCal Seeder</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
    background:#0e1116; color:#e6edf3; padding:24px; }
  .wrap { max-width:640px; margin:0 auto; }
  h1 { font-size:20px; font-weight:600; display:flex; align-items:center; gap:10px; }
  .dot { width:10px; height:10px; border-radius:50%; background:#3fb950; box-shadow:0 0 8px #3fb950; }
  .dot.off { background:#f85149; box-shadow:0 0 8px #f85149; }
  .card { background:#161b22; border:1px solid #30363d; border-radius:12px; padding:18px; margin:16px 0; }
  .grid { display:grid; grid-template-columns:auto 1fr; gap:6px 16px; font-size:14px; }
  .k { color:#8b949e; } .v { font-variant-numeric:tabular-nums; word-break:break-all; }
  .mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
  ul { margin:8px 0 0; padding-left:18px; } li { margin:2px 0; }
  button { font:inherit; font-weight:600; padding:11px 18px; border-radius:9px; cursor:pointer;
    border:1px solid #2f81f7; background:#1f6feb; color:#fff; }
  button.secondary { background:transparent; color:#8b949e; border-color:#30363d; }
  .qr { text-align:center; }
  .qr img { width:280px; max-width:100%; border-radius:10px; background:#fff; padding:10px; }
  .muted { color:#8b949e; font-size:13px; }
  .row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
</style></head>
<body><div class="wrap">
  <h1><span id="dot" class="dot off"></span> PearCal Blind Seeder</h1>
  <div class="card"><div class="grid">
    <div class="k">Status</div><div class="v" id="st">…</div>
    <div class="k">Seeder ID</div><div class="v mono" id="pk">…</div>
    <div class="k">Uptime</div><div class="v" id="up">…</div>
    <div class="k">Groups</div><div class="v" id="cnt">…</div>
  </div>
    <div id="groups"></div>
  </div>
  <div class="card">
    <div class="row" style="justify-content:space-between">
      <b>Admit a device</b>
      <div class="row">
        <button id="pair">Show pairing QR</button>
        <button id="close" class="secondary" style="display:none">Done</button>
      </div>
    </div>
    <div id="pairbox" style="display:none; margin-top:14px" class="qr">
      <img id="qr" alt="pairing QR"/>
      <div class="muted" id="pairmsg" style="margin-top:8px">Scan in PearCal → Profile → Advanced → Blind peer</div>
    </div>
    <div class="muted" style="margin-top:8px">On the phone: <b>Admit a blind peer → Scan blind peer QR</b>. The QR is single-use; press again for a new one.</div>
  </div>
</div>
<script>
const $ = id => document.getElementById(id);
function fmtUptime(ms){ if(!ms) return '—'; const s=Math.floor(ms/1000); const d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60); return (d?d+'d ':'')+(h?h+'h ':'')+m+'m'; }
async function refresh(){
  try{
    const r = await (await fetch('/api/status')).json();
    const s = r.status||{}; const en = r.enrolled||[];
    const ok = !!s.booted;
    $('dot').className = 'dot'+(ok?'':' off');
    $('st').textContent = ok ? 'running' : (s.error||'starting…');
    $('pk').textContent = s.pubkey||'—';
    $('up').textContent = fmtUptime(s.uptime);
    $('cnt').textContent = (s.enrolled??en.length)+' enrolled · '+(s.mounted??0)+' mounted';
    $('groups').innerHTML = en.length ? '<ul>'+en.map(g=>'<li>'+(g.name||g.groupId)+' <span class="muted mono">'+String(g.groupId||'').slice(0,8)+'</span></li>').join('')+'</ul>' : '<div class="muted" style="margin-top:8px">No groups yet — admit a device below.</div>';
  }catch(e){ $('st').textContent='dashboard unreachable'; $('dot').className='dot off'; }
}
$('pair').onclick = async () => {
  $('pair').textContent='…';
  try{
    const r = await (await fetch('/api/pair/open',{method:'POST'})).json();
    if(r.qr){ $('qr').src=r.qr; $('pairbox').style.display='block'; $('close').style.display=''; $('pairmsg').textContent='Valid ~5 min · scan in PearCal'; }
    else { $('pairmsg').textContent = r.error||'could not open pairing'; $('pairbox').style.display='block'; }
  }catch(e){ alert('pair failed: '+e.message); }
  $('pair').textContent='Show pairing QR';
};
$('close').onclick = async () => { try{ await fetch('/api/pair/close',{method:'POST'}); }catch(e){} $('pairbox').style.display='none'; $('close').style.display='none'; };
refresh(); setInterval(refresh, 3000);
</script>
</body></html>`

module.exports = { startDashboard }
