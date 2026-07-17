#!/usr/bin/env node
// On-device update-validation harness (proposal 2026-07-17 phase B). Ported from
// PearCircle scripts/serve-local-release.js.
//
// Serves a GitHub-Releases-shaped `/latest` JSON plus the installer assets in a
// local directory, so a seeder pointed at it with
//   PEARCAL_UPDATE_LATEST_URL=http://127.0.0.1:<port>/latest
// runs its REAL update path against locally-built installers, with no GitHub
// release published. In phase B this validates the CHECK + dashboard UpdateBar
// (the download/verify/apply path lands with the .pkg in phase C).
//
// Usage:
//   node serve-local-release.js <artifactsDir> <version> [port] [host]
//
//   <artifactsDir>  dir holding the built installer(s) + their .sha256 sidecars
//   <version>       release version to advertise, e.g. 1.0.21 (tag becomes vX)
//   [port]          listen port (default 8791)
//   [host]          host:port the asset URLs resolve to (default 127.0.0.1:port)
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')

const [dirArg, version, portArg, hostArg] = process.argv.slice(2)
if (!dirArg || !version) {
  console.error('usage: serve-local-release.js <artifactsDir> <version> [port] [host]')
  process.exit(1)
}
const dir = path.resolve(dirArg)
const port = Number(portArg) || 8791
const hostBase = hostArg || `127.0.0.1:${port}`

// A real GitHub release holds one installer per arch, but a local dist dir
// accumulates many builds — serving all would let selectAsset grab a stale
// same-arch installer silently. So advertise only files whose name carries the
// target version; if none match, fall back to all (point at a clean dir then).
const ver = version.replace(/^v/, '')
const all = fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile())
const versioned = all.filter((f) => f.includes(ver))
const files = versioned.length ? versioned : all
if (files.length === 0) { console.error(`no files in ${dir}`); process.exit(1) }
if (!versioned.length) console.warn(`WARN: no file name contains "${ver}"; serving ALL files in ${dir}`)

const assets = files.map((name) => ({
  name,
  browser_download_url: `http://${hostBase}/dl/${encodeURIComponent(name)}`,
}))
const release = {
  tag_name: `v${version.replace(/^v/, '')}`,
  html_url: `http://${hostBase}/`,
  assets,
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || hostBase}`)
  if (url.pathname === '/latest') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(release))
    return
  }
  if (url.pathname.startsWith('/dl/')) {
    const name = decodeURIComponent(url.pathname.slice('/dl/'.length))
    const file = path.join(dir, name)
    if (path.dirname(file) !== dir || !fs.existsSync(file)) { res.writeHead(404); res.end('no'); return }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': fs.statSync(file).size })
    fs.createReadStream(file).pipe(res)
    return
  }
  res.writeHead(404); res.end('no')
})

server.listen(port, () => {
  console.log(`serving fake release v${version} from ${dir}`)
  console.log(`  ${assets.length} assets: ${assets.map((a) => a.name).join(', ')}`)
  console.log(`point the seeder at it:  PEARCAL_UPDATE_LATEST_URL=http://${hostBase}/latest`)
  console.log(`listening on http://0.0.0.0:${port} (asset URLs -> http://${hostBase})`)
})
