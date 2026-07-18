#!/usr/bin/env node
// Minimal static server for the generated StartOS community-registry tree, with
// the Content-Types StartOS's marketplace client expects. Doubles as the
// reference for how to configure a real static host (nginx/Caddy/S3): the
// protocol paths are extensionless, so MIME must be assigned by route, not file
// extension.
//
//   node serve-registry.js [port] [dist-dir]
//
// Query strings (?spec=, ?os.compat=, ?ids=, ?version-priority=) are ignored -
// a static registry serves the same file regardless of filters.
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const PORT = Number(process.argv[2] || 8099)
const ROOT = path.resolve(process.argv[3] || path.join(__dirname, 'dist'))

// Route -> Content-Type. Everything under /package/v0 is JSON except the binary
// s9pk, the raw icon, and the text instructions/license assets.
function contentType (p) {
  if (p.endsWith('.s9pk')) return 'application/octet-stream'
  if (p.includes('/icon/')) return 'image/png'
  if (p.includes('/instructions/')) return 'text/markdown; charset=utf-8'
  if (p.includes('/license/')) return 'text/plain; charset=utf-8'
  return 'application/json; charset=utf-8' // info, index, latest, version/*, manifest/*, release-notes/*
}

const srv = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0])
  const file = path.join(ROOT, urlPath)
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      console.log(`404 ${urlPath}`)
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}')
      return
    }
    res.writeHead(200, {
      'content-type': contentType(urlPath),
      'content-length': st.size,
      'access-control-allow-origin': '*',
    })
    console.log(`200 ${urlPath} (${contentType(urlPath)})`)
    fs.createReadStream(file).pipe(res)
  })
})

srv.listen(PORT, '0.0.0.0', () => {
  console.log(`registry serving ${ROOT} on http://0.0.0.0:${PORT}`)
  console.log(`entrypoint: http://<this-host>:${PORT}/package/v0/info`)
})
