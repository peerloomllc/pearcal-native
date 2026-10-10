// One run-scoped root for every temporary store a test makes, removed when the
// process goes away rather than when the test runner says so.
//
// WHY THIS EXISTS. On 2026-08-07 the machine held 123 abandoned directories across
// four prefixes totalling 9.4G, some a week old. Three of those prefixes were this
// repo's: `pearcal-*` from the tools/ probes, and `starve-*` and `sh-e2e-*` from
// the harnesses under test/harness/. Ported from PearList (PR #182), which fixed
// its own half first.
//
// AN after() HOOK IS NOT ENOUGH, which is what made it survive so long. A hook does
// not run when the PROCESS dies: an unhandled rejection, a timeout kill or a Ctrl-C
// ends the run with the stores still on disk. `node --test` gives each file its own
// process, so one file dying leaks that whole file's stores. The harnesses are
// worse than the tests here: several are long-running repro scripts meant to be
// watched and then interrupted, so the Ctrl-C path is the NORMAL way they end.
//
// WHAT IT COSTS WHEN IT LEAKS is not disk, it is an hour of the next session, and
// not necessarily this repo's session. /tmp is tmpfs with a 12797M per-user quota
// inside a 16G filesystem, SHARED with every other project, so a full quota shows
// up as four to ten unrelated test failures all reporting "Batch was not applied"
// while `df -h /tmp` cheerfully reports gigabytes free. The command that tells the
// truth is `quota -s`. It has presented as a code bug every single time.
//
// SO REMOVAL IS REGISTERED WITH THE RUNTIME, not with the test runner. 'exit' fires
// on a normal exit and after an uncaught exception; signals skip it entirely, so
// SIGINT and SIGTERM are handled on their own and re-raised so the exit status
// still says what killed us. The rm has to be synchronous, because an 'exit'
// handler cannot await.
//
// A SIGKILL still leaks, and nothing in-process can fix that. The root is named
// `pcal-test-*` so one glob finds every survivor.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

let root = null
const made = []

function ensureRoot () {
  if (root) return root
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pcal-test-'))
  process.on('exit', removeRoot)
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      removeRoot()
      process.removeAllListeners(sig)
      process.kill(process.pid, sig)
    })
  }
  return root
}

function removeRoot () {
  if (!root) return
  try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
  root = null
  made.length = 0
}

// A fresh directory for one store. `prefix` is cosmetic and only there so a
// survivor names the test that made it.
function tmpDir (prefix = 'store-') {
  const dir = fs.mkdtempSync(path.join(ensureRoot(), prefix))
  made.push(dir)
  return dir
}

// Remove everything made so far, leaving the root in place for later tests. Tests
// call this from `t.after` to keep peak usage down within a file; the exit sweep is
// what makes it correct when they do not get the chance.
function cleanupTmpDirs () {
  for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} }
  made.length = 0
}

module.exports = { tmpDir, cleanupTmpDirs }
