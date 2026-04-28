#!/usr/bin/env node
// Mirrors pearguard/windows/scripts/prepack.js: copies the cross-directory
// source files (../src/bare.js + ../src/lib + ../src/invite.js + …) into
// electron/vendor/src/ so the electron/ subproject is fully self-contained
// for electron-builder. Runs from `postinstall` (so dev launch always has
// vendor/ populated) and from each build:* script.
//
// We also copy widget-cache.js and the lib/ helpers since src/bare.js
// requires them at module load.

const fs = require('fs')
const path = require('path')

const repoRoot = path.resolve(__dirname, '..', '..')
const srcDir = path.join(repoRoot, 'src')
const vendorSrc = path.join(__dirname, '..', 'vendor', 'src')

function ensureDir (dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function copyFile (from, to) {
  ensureDir(path.dirname(to))
  fs.copyFileSync(from, to)
}

function copyDirRecursive (from, to, opts = {}) {
  const { skip = () => false } = opts
  const entries = fs.readdirSync(from, { withFileTypes: true })
  for (const entry of entries) {
    const src = path.join(from, entry.name)
    const dst = path.join(to, entry.name)
    if (skip(src)) continue
    if (entry.isDirectory()) copyDirRecursive(src, dst, opts)
    else if (entry.isFile()) copyFile(src, dst)
  }
}

function main () {
  if (!fs.existsSync(srcDir)) {
    console.error(`[prepack] missing src dir: ${srcDir}`)
    process.exit(1)
  }

  // Wipe vendor/src/ first so removed/renamed source files don't linger.
  if (fs.existsSync(vendorSrc)) fs.rmSync(vendorSrc, { recursive: true })

  // Top-level src/*.js files needed by bare.js. ui/ + screenshot fixtures
  // are renderer-side and bundled via esbuild — don't copy those.
  const topLevelFiles = ['bare.js', 'widget-cache.js', 'invite.js']
  for (const name of topLevelFiles) {
    const from = path.join(srcDir, name)
    if (!fs.existsSync(from)) {
      console.error(`[prepack] missing ${name} at ${from}`)
      process.exit(1)
    }
    copyFile(from, path.join(vendorSrc, name))
  }

  // src/lib/ — sign.js, rekey.js, migration.js (required by bare.js)
  const libFrom = path.join(srcDir, 'lib')
  if (fs.existsSync(libFrom)) {
    copyDirRecursive(libFrom, path.join(vendorSrc, 'lib'))
  }

  console.log(`[prepack] vendored src/ → ${path.relative(repoRoot, vendorSrc)}`)
}

main()
