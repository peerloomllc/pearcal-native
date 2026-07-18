// Bearer-token auth for the seeder dashboard. Ported from PearCircle's
// host/auth.js. A 64-hex-char token is generated once and stored in the data
// dir (0600); the dashboard URL carries it as ?t=<token>, and API/SSE requests
// send it as ?t= or an Authorization: Bearer header. Constant-time compared.

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

function loadOrCreateToken (dataDir) {
  const tokenPath = path.join(dataDir, 'auth.token')
  try {
    const existing = fs.readFileSync(tokenPath, 'utf8').trim()
    if (existing.length === 64) return { token: existing, path: tokenPath, fresh: false }
  } catch {}
  const token = crypto.randomBytes(32).toString('hex')
  try { fs.writeFileSync(tokenPath, token + '\n', { mode: 0o600 }) } catch {}
  return { token, path: tokenPath, fresh: true }
}

function extractToken (req) {
  const auth = req.headers['authorization']
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7).trim()
  try { return new URL(req.url, 'http://localhost').searchParams.get('t') } catch { return null }
}

function verify (req, token) {
  const provided = extractToken(req)
  if (!provided || provided.length !== token.length) return false
  try { return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(token)) } catch { return false }
}

module.exports = { loadOrCreateToken, verify, extractToken }
