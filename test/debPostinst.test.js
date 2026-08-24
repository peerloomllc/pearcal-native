// The .deb postinst must never fail a working install (issue #320).
//
// Every best-effort helper in it is a `( set +e ... ) || true` subshell. Drop
// the `|| true` and the subshell's exit status - which is just the status of
// whatever ran last inside it - trips the script's own `set -e`, so dpkg
// reports "post-installation script subprocess returned error exit status 1"
// on a box where the install actually worked. On headless Linux that is the
// normal case: refresh_desktop_caches ends with `command -v appstreamcli`,
// false wherever no desktop is installed.
//
// These tests extract the real helper functions from the shipped postinst and
// run them under `set -e` with a PATH that has no desktop tools, which is what
// a headless box looks like.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')

const POSTINST = path.join(__dirname, '..', 'seeder-launcher', 'installer', 'linux', 'deb', 'postinst')
const MACOS_POSTINSTALL = path.join(__dirname, '..', 'seeder-launcher', 'scripts', 'postinstall-macos.sh')
const src = fs.readFileSync(POSTINST, 'utf8')

// Pull one `name () { ... }` block out of the script. The closing brace is the
// first `}` in column zero after the header, which is how these are formatted.
function extractFn (name) {
  const start = src.indexOf(`${name} () {`)
  assert.notStrictEqual(start, -1, `no ${name} in postinst`)
  const end = src.indexOf('\n}\n', start)
  assert.notStrictEqual(end, -1, `no close for ${name}`)
  return src.slice(start, end + 3)
}

// Run a snippet under the same `set -e` the postinst uses, with PATH pointed at
// an empty directory so NOTHING external resolves - which is the part of a
// headless box that matters here. Bash builtins (command, [, echo) still work,
// so the scripts run exactly as written; every external they reach for is
// simply absent, as appstreamcli and friends are on a server install.
const EMPTY_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'no-tools-'))
// bash itself has to be named absolutely, since the child's PATH cannot find it.
const BASH = ['/bin/bash', '/usr/bin/bash'].find(p => fs.existsSync(p)) ?? '/bin/bash'
//
// `--noprofile --norc` is NOT optional, it is what keeps this test from taking
// the whole machine down. Fedora's bash sources /etc/profile.d even for a
// non-interactive `-c`, and PackageKit.sh there defines a
// `command_not_found_handle` whose non-interactive branch ends in
// `$(gettext PackageKit 'command not found')`. With PATH pointed at an empty
// directory `gettext` is itself missing, so the handler re-enters itself,
// forking a subshell for the `$(...)` every time. That is an unbounded fork
// chain: on 2026-08-23 it reached 6949 bash processes and the kernel OOM killer
// took out the editor session along with sddm, firewalld and dnf. Defining a
// stub handler inside `body` does not help, since the profile is sourced at
// startup and overwrites it.
function runHeadless (body) {
  return spawnSync(BASH, ['--noprofile', '--norc', '-c', `set -e\nINSTALL_ROOT=/nonexistent\n${body}`], {
    env: { PATH: EMPTY_PATH },
    encoding: 'utf8',
  })
}

test('refresh_desktop_caches does not fail the install on a box with no desktop tools', () => {
  const r = runHeadless(extractFn('refresh_desktop_caches') + '\nrefresh_desktop_caches\necho REACHED_END\n')
  assert.strictEqual(r.status, 0, r.stderr)
  assert.match(r.stdout, /REACHED_END/)
})

test('install_updater does not fail the install when polkit and the helper are absent', () => {
  const r = runHeadless(extractFn('install_updater') + '\ninstall_updater someuser\necho REACHED_END\n')
  assert.strictEqual(r.status, 0, r.stderr)
  assert.match(r.stdout, /REACHED_END/)
})

test('open_dashboard_for_user does not fail the install with no graphical session', () => {
  const r = runHeadless(extractFn('open_dashboard_for_user') + '\nopen_dashboard_for_user nosuchuser42\necho REACHED_END\n')
  assert.strictEqual(r.status, 0, r.stderr)
  assert.match(r.stdout, /REACHED_END/)
})

// The control. Without it the three tests above would pass for a script that
// never had the bug in the first place, and prove nothing about the guard.
test('the same helper WITHOUT the guard really does abort the install', () => {
  const unguarded = extractFn('refresh_desktop_caches').replace(') || true', ')')
  assert.ok(!unguarded.includes('|| true'), 'control did not actually remove the guard')
  const r = runHeadless(unguarded + '\nrefresh_desktop_caches\necho REACHED_END\n')
  assert.notStrictEqual(r.status, 0)
  assert.doesNotMatch(r.stdout, /REACHED_END/)
})

// Static sweep, so a helper added later cannot reintroduce this.
test('every best-effort subshell in the installer scripts is guarded', () => {
  for (const file of [POSTINST, MACOS_POSTINSTALL]) {
    const text = fs.readFileSync(file, 'utf8')
    const lines = text.split('\n')
    let found = 0
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^([ \t]*)\( set \+e$/)
      if (!m) continue
      found++
      const close = lines.findIndex((l, j) => j > i && l.startsWith(m[1] + ')') && l.trim().startsWith(')'))
      assert.notStrictEqual(close, -1, `${file}:${i + 1} subshell never closes at its own indent`)
      assert.strictEqual(lines[close].trim(), ') || true',
        `${file}:${close + 1} closes a "( set +e" subshell without "|| true"`)
    }
    assert.ok(found > 0, `no best-effort subshells found in ${file} - did it move?`)
  }
})

// The scripts still have to be valid bash after any of the above edits.
test('the deb maintainer scripts parse', () => {
  for (const name of ['postinst', 'prerm', 'postrm']) {
    const p = path.join(path.dirname(POSTINST), name)
    execFileSync('bash', ['-n', p])
  }
  execFileSync('bash', ['-n', MACOS_POSTINSTALL])
})
