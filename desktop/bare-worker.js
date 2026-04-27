/* global Pear */
// Phase 2 work-in-progress. The intent is for this to be a one-line shim:
//
//   require('./bare-desktop.bundle')
//
// scripts/desktop-bundle.sh produces bare-desktop.bundle from src/bare.js via
// bare-pack (--preset desktop). src/bare.js was already updated to abstract its
// IPC layer (BareKit.IPC vs Pear.worker.pipe()) and desktop/index.html sends an
// init message with Pear.config.storage immediately after spawning the worker.
//
// BLOCKER: requiring the .bundle from this .js entry, OR pointing
// Pear.worker.run() directly at the .bundle, both fail. With require, the
// `.js` extension handler walks up looking for the bundle.main's package.json
// and JSON.parse fails on 1042 bytes of binary content shaped like
// compact-encoding output (lots of embedded 0x00, small numerics like
// 0x14 0x27 0x21 0x07 0x35 0x52 ...) that is **not** present anywhere in
// bare-desktop.bundle on disk. Replacing the bundle's /package.json or adding
// a /src/package.json stub has no effect; stripping bundle.resolutions to
// force pure URL walk-up has no effect; killing the entire Pear sidecar
// before retry has no effect. The Keet-cross-contamination hypothesis was
// tested and ruled out (same binary garbage with Keet not running).
//
// Pointing Pear.worker.run() directly at the bundle produces no error but
// never executes the bundle's main entry — the worker inherits the parent
// project's `pear: { type: "desktop" }` from desktop/package.json (state.js:47)
// and tries to launch Electron through DESKTOP_RUNTIME instead of running as
// a bare terminal. A `worker/` subproject with `pear.type: "terminal"` reaches
// run.js:132's terminal-mode `Module.load(bundle.entrypoint)` but then hits
// the same binary-JSON error inside the .bundle extension handler.
//
// Until that's resolved, fall back to the Phase 1 stub so the renderer keeps
// rendering against canned data and the rest of Phase 2 (UI integration) can
// be developed in parallel. See docs/superpowers/plans/2026-04-27-pear-desktop.md
// Phase 2 section for full diagnostic history.
const pipe = Pear.worker.pipe()

// Mutable in-memory profile so updateProfile/getProfile round-trip during
// stubbed dev. Pre-completed onboarding so Phase 3 work doesn't have to click
// through the slides on every relaunch.
const _profile = {
  id: 'desktop-stub',
  name: 'Desktop User',
  color: '#3b82f6',
  onboardingComplete: true
}

const STUB_RESPONSES = {
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

let _buf = ''
pipe.on('data', (chunk) => {
  _buf += chunk.toString('utf8')
  let i
  while ((i = _buf.indexOf('\n')) >= 0) {
    const line = _buf.slice(0, i); _buf = _buf.slice(i + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    // The renderer's first message is now `init` (no id). Drop it on the floor;
    // the bundled bare.js would handle it, but the stub doesn't need a dataDir.
    if (msg.method === 'init') continue
    if (typeof msg.id !== 'number' || typeof msg.method !== 'string') continue
    if (msg.method === 'getProfile') {
      reply(msg.id, { ..._profile })
    } else if (msg.method === 'updateProfile') {
      Object.assign(_profile, msg.args?.[0] || {})
      reply(msg.id, { ..._profile })
    } else if (msg.method in STUB_RESPONSES) {
      reply(msg.id, STUB_RESPONSES[msg.method])
    } else {
      reply(msg.id, null)
    }
  }
})

pipe.on('error', (e) => console.error('[bare-worker] pipe error:', e.message))
pipe.on('close', () => console.warn('[bare-worker] pipe closed'))

console.log('[bare-worker] Phase 1 stub (Phase 2 bundle-load blocked — see file header)')
