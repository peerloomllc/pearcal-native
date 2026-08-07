#!/usr/bin/env node
// Last-resort recovery when patch-package cannot apply a patch, run ONLY after
// it has already failed. Restores each patched package to a pristine copy and
// retries once. Exits non-zero if that still fails, so a genuinely broken patch
// stays loud.
//
// THE FAILURE THIS RECOVERS FROM. patch-package edits node_modules in place, so
// a machine whose copy was patched by an OLDER version of the patch file cannot
// apply a newer one - the context no longer matches:
//
//   **ERROR** Failed to apply patch for package autobase at path
//     node_modules/autobase
//
// Hit for real on the Mac Mini 2026-08-07, mid release, killing it. Its autobase
// carried only the apply-state.js hunk, which is all
// patches/autobase+7.25.1.patch held back at v1.0.38; three hunks were added
// since. The patch was fine - it applied cleanly to a freshly downloaded 7.25.1.
// The stale copy was wrong, and patch-package's own message points at the patch
// file instead, which is the wrong place to look.
//
// WHY THIS RUNS AFTER THE FAILURE AND NOT BEFORE.
// The obvious fix - delete the package in `preinstall` so npm refetches it - does
// NOT work, and was tried and reverted the same day. npm computes its install
// plan before preinstall runs, sees the dependency as satisfied, and never
// refetches what was deleted; postinstall then dies with "Patch file found for
// package autobase which is not present". That turned a rare failure into an
// every-install one. Restoring the package here, explicitly, avoids depending on
// npm noticing anything.
//
// Deliberately NOT solved by dropping --error-on-fail: a silently unapplied
// patch is exactly what shipped the desktop freeze (#158).

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const root = path.join(__dirname, '..')
const patchDir = path.resolve(process.argv[2] || path.join(root, 'patches'))
const modules = path.resolve(process.argv[3] || path.join(root, 'node_modules'))

if (!fs.existsSync(patchDir)) process.exit(1)

// "autobase+7.25.1.patch" -> { name: 'autobase', version: '7.25.1' }
// "@scope+pkg+1.0.0.patch" -> { name: '@scope/pkg', version: '1.0.0' }
function parsePatchName (file) {
  const parts = file.replace(/\.patch$/, '').split('+')
  if (parts.length < 2) return null
  const version = parts[parts.length - 1]
  const nameParts = parts.slice(0, -1)
  const name = nameParts[0].startsWith('@') ? nameParts.join('/') : nameParts.join('+')
  return { name, version }
}

const patches = fs.readdirSync(patchDir).filter(f => f.endsWith('.patch')).map(parsePatchName).filter(Boolean)
if (!patches.length) process.exit(1)

console.error('')
console.error('[heal-patches] patch-package failed. This is usually a stale copy in')
console.error('[heal-patches] node_modules patched by an older version of the patch file,')
console.error('[heal-patches] not a problem with the patch. Restoring pristine copies:')

let restored = 0
for (const { name, version } of patches) {
  const target = path.join(modules, ...name.split('/'))
  if (!fs.existsSync(target)) continue
  // Staged INSIDE node_modules, not in os.tmpdir(): the final step is a rename,
  // and /tmp is routinely a different filesystem, which fails with EXDEV
  // ("cross-device link not permitted"). Same directory keeps the rename atomic
  // and cheap. Removed in the finally below either way.
  fs.mkdirSync(modules, { recursive: true })
  const tmp = fs.mkdtempSync(path.join(modules, '.heal-'))
  try {
    // npm pack resolves from the local cache when it can, so this stays fast
    // and usually works offline.
    const tgz = execFileSync('npm', ['pack', name + '@' + version, '--pack-destination', tmp, '--silent'],
      { encoding: 'utf8' }).trim().split('\n').pop()
    execFileSync('tar', ['-xzf', path.join(tmp, tgz), '-C', tmp])
    fs.rmSync(target, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.renameSync(path.join(tmp, 'package'), target)
    console.error('[heal-patches]   restored ' + name + '@' + version)
    restored++
  } catch (e) {
    console.error('[heal-patches]   could not restore ' + name + ': ' + e.message)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

if (!restored) {
  console.error('[heal-patches] nothing restored — leaving the original failure in place.')
  process.exit(1)
}

// Retry once. Same flags as the postinstall that just failed.
try {
  const args = ['patch-package', '--error-on-fail']
  if (process.argv[2]) args.push('--patch-dir', process.argv[2])
  execFileSync('npx', args, { stdio: 'inherit', cwd: path.dirname(modules) })
  console.error('[heal-patches] recovered. Install can continue.')
  process.exit(0)
} catch (e) {
  console.error('[heal-patches] still failing after restoring pristine copies, so the')
  console.error('[heal-patches] patch itself is likely wrong. Regenerate it with:')
  console.error('[heal-patches]   npx patch-package <package-name>')
  process.exit(1)
}
