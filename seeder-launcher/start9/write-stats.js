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
const INTERVAL_MS = Number(process.env.START9_STATS_INTERVAL_MS || 60000)

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

async function tick () {
  try {
    const res = await fetch(API)
    if (!res.ok) return
    const body = await res.json()
    fs.mkdirSync(STATS_DIR, { recursive: true })
    // Write-then-rename so StartOS never reads a half-written file.
    const tmp = STATS_FILE + '.tmp'
    fs.writeFileSync(tmp, render(body))
    fs.renameSync(tmp, STATS_FILE)
  } catch {
    // The seeder may not be listening yet, or may be mid-restart. Properties
    // keeps showing the previous snapshot rather than going blank, so a failed
    // poll is not worth logging on every tick.
  }
}

// Exported for tests. Requiring this module must not start a timer, so the
// poller only runs when this file is the process entry point.
module.exports = { render, tick }

if (require.main === module) {
  tick()
  // NO unref() here. This runs as its own process (`node write-stats.js &` from
  // docker_entrypoint.sh), so this interval is the only thing holding the event
  // loop open — unref'ing it let the process exit as soon as the first tick
  // settled. That first tick fires at container boot, before the seeder's HTTP
  // API is listening, so it wrote nothing and Properties stayed empty forever,
  // which is the exact problem this file was added to solve.
  //
  // unref() is right for a timer inside a host process that has other work
  // keeping it alive. It is wrong for a standalone poller.
  setInterval(tick, INTERVAL_MS)
}
