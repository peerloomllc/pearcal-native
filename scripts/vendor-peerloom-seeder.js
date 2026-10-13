// Copy the device side of @peerloom/seeder (../peerloom-seeder) into
// src/peerloom-seeder/ (from @peerloom/core's script of the same name). A copy
// rather than a dependency, so the bundles resolve blind-peering and hypercore
// from this repo: one copy of each. Committed, so builds need no sibling
// checkout; test/peerloomSeeder.test.js fails when it falls out of step.
// Never edit the copy.
//
// Usage: node scripts/vendor-peerloom-seeder.js
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const from = path.join(root, '..', 'peerloom-seeder')
const to = path.join(root, 'src', 'peerloom-seeder')
const FILES = ['client.js', 'protocol.js']

function vendor () {
  fs.mkdirSync(to, { recursive: true })
  for (const f of FILES) fs.copyFileSync(path.join(from, 'src', f), path.join(to, f))
  const commit = (() => { try { return require('child_process').execFileSync('git', ['-C', from, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim() } catch { return 'unknown' } })()
  fs.writeFileSync(path.join(to, 'README.md'), 'Copied from peerloom-seeder (' + commit + ') by scripts/vendor-peerloom-seeder.js. Do not edit here.\n')
}

if (require.main === module) { vendor(); console.log('vendored ' + FILES.join(', ') + ' from ' + from) }

module.exports = { FILES, from, to }
