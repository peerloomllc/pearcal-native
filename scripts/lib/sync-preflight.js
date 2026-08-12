#!/usr/bin/env node
// Measures what mac-sync.sh is about to send, and refuses if it has gone wrong.
//
// This is the anti-rot mechanism for TODO #168. The original failure was silent:
// the sync did not error, it just walked 18 GB to deliver 18 MB and sat there
// for 25 minutes with --checksum hashing everything on both ends. A ceiling
// turns that into an immediate, actionable message naming the directory that
// grew, which is the only reason anyone would notice before losing the time.
//
// Usage: node scripts/lib/sync-preflight.js [repoRoot] [--max-mb N] [--quiet]

const path = require('path')
const { loadExcludes, measureSyncSet, unexcludedHeavyDirs } = require('./syncExcludes.js')

const DEFAULT_MAX_MB = 250

function mb (bytes) { return (bytes / (1024 * 1024)).toFixed(1) + ' MB' }

function main (argv) {
  const args = argv.slice(2)
  const quiet = args.includes('--quiet')
  const maxIdx = args.indexOf('--max-mb')
  const maxMb = maxIdx >= 0 ? Number(args[maxIdx + 1]) : DEFAULT_MAX_MB
  const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--max-mb')
  const root = path.resolve(positional[0] || path.join(__dirname, '..', '..'))

  const patterns = loadExcludes()
  const { bytes, files } = measureSyncSet(root, patterns)
  const overCap = bytes > maxMb * 1024 * 1024

  if (!quiet || overCap) {
    console.log('    sync set: ' + mb(bytes) + ' across ' + files + ' files')
  }
  if (!overCap) return 0

  // Two views, because the original blowup had one of each: 8 GB inside
  // electron/dist (a nested directory) and 4.4 GB of loose installers sitting
  // at the repo root (files, which no directory walk would ever name).
  const nested = unexcludedHeavyDirs(root, patterns)
  const topLevel = measureSyncSet(root, patterns).dirs
  const seen = new Set()
  const heavy = [...nested, ...topLevel]
    .filter(d => { const k = d.name; if (seen.has(k)) return false; seen.add(k); return true })
    .filter(d => !nested.some(n => n !== d && d.name !== n.name && n.name.startsWith(d.name + '/')))
    .sort((a, b) => b.bytes - a.bytes)
  console.error('')
  console.error('REFUSING TO SYNC: ' + mb(bytes) + ' exceeds the ' + maxMb + ' MB ceiling.')
  console.error('')
  console.error('Something generated is not excluded. With --checksum this would read and')
  console.error('hash every byte on BOTH machines before transferring anything, which is how')
  console.error('a build silently hangs for half an hour (TODO #168).')
  if (heavy.length) {
    console.error('')
    console.error('Biggest unexcluded directories:')
    for (const d of heavy.slice(0, 8)) console.error('  ' + mb(d.bytes).padStart(12) + '  ' + d.name)
  }
  console.error('')
  console.error('Add it to scripts/mac-sync-excludes.txt, or raise the ceiling with')
  console.error('MAX_SYNC_MB=<n> if the growth is genuinely source that the Mac needs.')
  console.error('')
  return 1
}

if (require.main === module) process.exit(main(process.argv))
module.exports = { main, DEFAULT_MAX_MB }
