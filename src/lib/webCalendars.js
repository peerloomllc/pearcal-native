// Web calendar subscriptions (TODO #189 phase 2, proposal
// proposals/2026-11-04-personal-calendars.md).
//
// A subscription row lives at `subscription:{id}` and syncs to linked devices
// through the personal base (type 'subscription', last-write-wins by
// `updatedAt`, soft delete), so every device follows the same feeds.
//
// The downloaded feed is per device. Each device fetches the URL itself (the RN
// shell on phones, the Electron main process on desktop) and stores the text at
// `subFeed:{id}`, which never syncs. The UI parses it into read-only events.
//
// Plain CommonJS, no dependencies: required by bare.js, the RN shell and the
// Electron main process.

const SUBSCRIPTION_KEY_PREFIX = 'subscription:'
const FEED_KEY_PREFIX = 'subFeed:'
const DEFAULT_REFRESH_HOURS = 12
const MIN_REFRESH_HOURS = 1
const MAX_REFRESH_HOURS = 24 * 7
const MAX_FEED_BYTES = 5 * 1024 * 1024
const FETCH_TIMEOUT_MS = 20000
const NAME_MAX = 60

function subscriptionKey (id) { return SUBSCRIPTION_KEY_PREFIX + id }
function feedKey (id) { return FEED_KEY_PREFIX + id }

// webcal:// is how most sites publish a subscribable calendar; it is plain
// HTTPS underneath. Only http(s) is fetched.
function normalizeFeedUrl (input) {
  let s = String(input ?? '').trim()
  if (!s) throw new Error('Enter the calendar\'s web address.')
  s = s.replace(/^webcals?:\/\//i, 'https://')
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s
  let u
  try { u = new URL(s) } catch { throw new Error('That is not a web address.') }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Only http, https and webcal addresses work.')
  if (!u.hostname) throw new Error('That is not a web address.')
  return u.toString()
}

function clampRefresh (h) {
  const n = Number(h)
  if (!Number.isFinite(n)) return DEFAULT_REFRESH_HOURS
  return Math.min(MAX_REFRESH_HOURS, Math.max(MIN_REFRESH_HOURS, Math.round(n)))
}

function cleanName (name) {
  return String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX)
}

function makeSubscriptionRecord (input, prev, now = Date.now()) {
  const id = String(input?.id ?? '').trim()
  if (!id) throw new Error('subscription id required')
  if (id.includes(':')) throw new Error('subscription id must not contain ":"')
  const rec = {
    id,
    url: input.deleted ? (prev?.url ?? input.url ?? '') : normalizeFeedUrl(input.url ?? prev?.url),
    name: cleanName(input.name ?? prev?.name),
    color: typeof input.color === 'string' ? input.color : (prev?.color ?? null),
    refreshHours: clampRefresh(input.refreshHours ?? prev?.refreshHours),
    createdAt: prev?.createdAt ?? input.createdAt ?? now,
    updatedAt: Math.max(now, (prev?.updatedAt ?? 0) + 1),
  }
  if (input.deleted) rec.deleted = true
  return rec
}

function newerSubscription (prev, next) {
  if (!next) return prev ?? null
  if (!prev) return next
  return (next.updatedAt ?? 0) > (prev.updatedAt ?? 0) ? next : prev
}

function listSubscriptions (rows) {
  const byId = new Map()
  for (const r of rows ?? []) {
    if (!r?.id) continue
    byId.set(r.id, newerSubscription(byId.get(r.id), r))
  }
  return [...byId.values()]
    .filter(r => !r.deleted)
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id))
}

// Due for a download: never fetched, the URL changed since, or older than its
// refresh interval. A failed attempt waits a quarter of the interval before
// trying again so an unreachable site is not hammered.
function isFeedDue (sub, feed, now = Date.now()) {
  if (!sub) return false
  if (!feed) return true
  if (feed.url && feed.url !== sub.url) return true
  const every = clampRefresh(sub.refreshHours) * 3600 * 1000
  const last = feed.error ? (feed.attemptedAt ?? 0) : (feed.fetchedAt ?? 0)
  return now - last >= (feed.error ? every / 4 : every)
}

// Download one feed. `fetchImpl` is the platform's fetch. Throws with a short,
// readable message on any failure.
async function fetchCalendarText (url, { fetchImpl, timeoutMs = FETCH_TIMEOUT_MS, maxBytes = MAX_FEED_BYTES } = {}) {
  const target = normalizeFeedUrl(url)
  const f = fetchImpl ?? (typeof fetch === 'function' ? fetch : null)
  if (!f) throw new Error('No way to download on this device.')
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null
  const timer = setTimeout(() => ctrl?.abort(), timeoutMs)
  let res
  try {
    res = await f(target, {
      signal: ctrl?.signal,
      headers: { Accept: 'text/calendar, text/plain;q=0.9, */*;q=0.5' },
      redirect: 'follow',
      credentials: 'omit',
    })
  } catch (e) {
    throw new Error(ctrl?.signal?.aborted ? 'The website took too long to answer.' : 'Could not reach that website.')
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) throw new Error('The website answered with error ' + res.status + '.')
  const len = Number(res.headers?.get?.('content-length') ?? 0)
  if (len > maxBytes) throw new Error('That calendar is too large.')
  const text = await res.text()
  if (text.length > maxBytes) throw new Error('That calendar is too large.')
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('That address did not return a calendar file.')
  return text
}

function newSubscriptionId (rand = Math.random) {
  return 'sub' + Date.now().toString(36) + rand().toString(36).slice(2, 8)
}

module.exports = {
  SUBSCRIPTION_KEY_PREFIX,
  FEED_KEY_PREFIX,
  DEFAULT_REFRESH_HOURS,
  MAX_FEED_BYTES,
  subscriptionKey,
  feedKey,
  normalizeFeedUrl,
  clampRefresh,
  makeSubscriptionRecord,
  newerSubscription,
  listSubscriptions,
  isFeedDue,
  fetchCalendarText,
  newSubscriptionId,
}
