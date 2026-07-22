// Populate the StartOS "Properties" page.
//
// compat.properties (scripts/procedures/properties.ts) renders whatever is in
// <volume>/start9/stats.yaml. Nothing ever wrote that file, so the menu item
// existed and showed nothing. This polls the seeder's own dashboard API and
// rewrites the file, so Properties reflects live state.
//
// The seeder public key is the point of this: it identifies the seeder and is
// what a member checks to confirm they admitted the right one. On StartOS there
// was previously no way to see it without opening the dashboard.
//
// Deliberately NOT written here: the dashboard auth token. StartOS runs the
// seeder with SEEDER_NO_AUTH=1 (the interface proxy gates access), so the token
// is not needed to reach the UI, and Properties is readable by anyone with
// server access.

const fs = require('fs')
const path = require('path')

const STATS_DIR = process.env.START9_STATS_DIR || '/root/start9'
const STATS_FILE = path.join(STATS_DIR, 'stats.yaml')
const API = `http://127.0.0.1:${process.env.SEEDER_PORT || 8731}/api/status`
// Steady-state refresh, once a file exists.
const INTERVAL_MS = Number(process.env.START9_STATS_INTERVAL_MS || 60000)
// Startup retry until the FIRST successful write. The seeder's HTTP API is not
// listening the instant this process starts, so the first poll always fails;
// waiting a full INTERVAL_MS to retry left Properties empty for well over a
// minute after every boot (observed ~100s), which read as "the feature does
// nothing". Poll quickly until stats.yaml exists, then fall back to INTERVAL_MS.
const STARTUP_INTERVAL_MS = Number(process.env.START9_STATS_STARTUP_INTERVAL_MS || 3000)

// Values land inside a YAML double-quoted scalar, so escape what would break it.
// The seeder nickname is user-supplied and reaches here verbatim.
const q = (v) => '"' + String(v ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'

function entry (name, value, description, copyable) {
  return [
    `  ${name}:`,
    '    type: string',
    `    value: ${q(value)}`,
    `    description: ${q(description)}`,
    `    copyable: ${copyable ? 'true' : 'false'}`,
    '    qr: false',
    '    masked: false',
  ].join('\n')
}

function render (s) {
  const st = s?.status ?? {}
  const enrolled = Array.isArray(s?.enrolled) ? s.enrolled.length : (st.enrolled ?? 0)
  const names = (Array.isArray(s?.enrolled) ? s.enrolled : [])
    .map(g => g?.name).filter(Boolean).join(', ')
  return [
    'version: 2',
    'data:',
    entry('Seeder Public Key', st.pubkey ?? 'unavailable',
      'Identifies this seeder. Check it matches what the PearCal app shows when you admit it.', true),
    entry('Nickname', st.nickname || 'not set',
      'Display name shown to members. Change it from the seeder dashboard.', false),
    entry('Groups Seeded', String(enrolled),
      names ? `Currently replicating: ${names}` : 'No groups enrolled yet. Admit this seeder from the PearCal app.', false),
    entry('Connected Peers', String(st.peers ?? 0),
      'Member devices currently replicating with this seeder.', false),
    entry('Stored', `${(Number(st.bytes ?? 0) / 1048576).toFixed(1)} MB in ${st.blocks ?? 0} blocks`,
      'Encrypted group data held on this server. The seeder cannot read any of it.', false),
    '',
  ].join('\n')
}

let _warnedOnce = false

// Poll the seeder once. Returns true iff stats.yaml was (re)written this call,
// which the startup loop uses to decide when to slow down. A failure is normal
// at boot (API not up yet) and while mid-restart, so it is not fatal; but the
// FIRST failure is logged once, because a silent catch is what made the two
// earlier versions of this bug undiagnosable from the outside.
async function tick () {
  try {
    const res = await fetch(API)
    if (!res.ok) return false
    const body = await res.json()
    fs.mkdirSync(STATS_DIR, { recursive: true })
    // Write-then-rename so StartOS never reads a half-written file.
    const tmp = STATS_FILE + '.tmp'
    fs.writeFileSync(tmp, render(body))
    fs.renameSync(tmp, STATS_FILE)
    return true
  } catch (e) {
    if (!_warnedOnce) {
      _warnedOnce = true
      console.warn('[stats] seeder API not ready yet (' + (e && e.message) + '); will keep retrying')
    }
    return false
  }
}

// Poll fast until the first successful write, then settle into the slow refresh.
// Written as a self-rescheduling timeout rather than setInterval so the two
// cadences share one code path and the process always has exactly one pending
// timer holding the event loop open.
async function loop () {
  const ok = await tick()
  const wrote = ok || fs.existsSync(STATS_FILE)
  setTimeout(loop, wrote ? INTERVAL_MS : STARTUP_INTERVAL_MS)
}

// Exported for tests. Requiring this module must not start a timer, so the
// poller only runs when this file is the process entry point.
module.exports = { render, tick, loop }

if (require.main === module) {
  // loop() self-reschedules with a live (never unref'd) timer. This runs as its
  // own process (`node write-stats.js &` from docker_entrypoint.sh), so that
  // pending timer is the only thing holding the event loop open. An unref'd
  // timer let the process exit as soon as the first tick settled — that first
  // tick fires before the seeder API is listening, so it wrote nothing and then
  // the process was gone, leaving Properties empty forever (the original bug).
  // unref() is right for a timer inside a host process with other work keeping
  // it alive; it is wrong for a standalone poller.
  loop()
}
