/* global Pear */
// Phase 1 stub bare worker. Phase 2 replaces this with a bundled src/bare.js.
//
// Same IPC envelope as mobile's BareKit.IPC and as desktop/app.js:
//   request:  {id, method, args}
//   response: {id, result} | {id, error}
//   event:    {event, data}

const pipe = Pear.worker.pipe()

const STUB_RESPONSES = {
  getProfile: { id: 'desktop-stub', name: 'Desktop User', color: '#3b82f6' },
  listEvents: [],
  listGroups: [],
  listMembers: [],
  listRsvps: [],
  listMyRsvps: [],
  getReminders: [],
  listMyReminders: [],
  getRsvp: null,
  getPrivateNote: '',
  hasMnemonic: true,
  getBackupStatus: { provider: null, available: false, enabled: false, latestBackup: null },
  isBlockedFromGroup: false
}

function reply (id, result) {
  pipe.write(Buffer.from(JSON.stringify({ id, result }) + '\n'))
}
function replyErr (id, error) {
  pipe.write(Buffer.from(JSON.stringify({ id, error }) + '\n'))
}

let _buf = ''
pipe.on('data', (chunk) => {
  _buf += chunk.toString('utf8')
  let i
  while ((i = _buf.indexOf('\n')) >= 0) {
    const line = _buf.slice(0, i); _buf = _buf.slice(i + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    if (typeof msg.id !== 'number' || typeof msg.method !== 'string') continue
    if (msg.method in STUB_RESPONSES) {
      reply(msg.id, STUB_RESPONSES[msg.method])
    } else {
      // Default to null so any uncovered method doesn't hang the UI.
      reply(msg.id, null)
    }
  }
})

pipe.on('error', (e) => console.error('[bare-worker] pipe error:', e.message))
pipe.on('close', () => console.warn('[bare-worker] pipe closed'))

console.log('[bare-worker] phase 1 stub ready')
