/**
 * PearCal — Invite Link Handler
 *
 * Invite link format (current):
 *   https://peerloomllc.com/join?group={base64(groupId)}&name={groupName}&key={groupKey}&inviter={publicKey}
 *
 * Legacy formats (still accepted for backward compatibility):
 *   pear://pearcal/join?group=...
 *   pearcal://join?group=...
 *
 * Flow:
 *   1. Link is intercepted by Universal Links (iOS) / App Links (Android) → passed to native
 *   2. Native stores the link in LinkModule.pendingLink
 *   3. handleInviteLink() is called with the raw URL string
 *   4. We parse + validate the params, prompt the user to confirm, then:
 *      a. Write the group to local Hyperbee
 *      b. Join the group's Hyperswarm topic via SyncManager
 *      c. Replicate with the inviter to pull group metadata + events
 *      d. Notify the UI so it re-renders with the new group
 */

//import b4a from 'b4a'

// ─── Constants ────────────────────────────────────────────────────────────────

const SCHEME   = 'https://peerloomllc.com'
const MAX_NAME = 64    // chars
const KEY_LEN  = 64    // hex chars (32-byte public key)

// Device-pair URLs (TODO #11 Phase 4). Custom scheme — MUST NOT be HTTPS,
// since the handshake response transfers the user's mnemonic and the URL
// should never touch peerloomllc.com's logs. Fifteen-minute hard expiry.
const PAIR_SCHEME  = 'pearcal://pair'
const PAIR_HEX_32  = 64   // hex chars for 32-byte topic / handshake / identity

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Parse, validate and process a pear://pearcal/join invite URL.
 *
 * @param {string}                       url    — raw pear:// link
 * @param {import('./db.js').PearCalDB}  db
 * @param {import('./sync.js').SyncManager} sync
 * @param {function} onJoined   — callback(group) fired after successful join;
 *                                use this to update React state in the UI
 * @returns {Promise<{ ok: boolean, error?: string, group?: object }>}
 */
export async function handleInviteLink (url, db, sync, onJoined, nickname = null) {
  // 1. Parse
  const parsed = parseInviteLink(url)
  if (!parsed.ok) return parsed

  const { groupId, groupName, groupKey, inviterKey } = parsed

  // 2. Check if we were blocked / already a member
  const isReinvite = parsed.reinvite === true
  if (isReinvite) {
    await db.clearBlockedFromGroup(groupId).catch(() => {})
  } else {
    const isBlocked = await db.isBlockedFromGroup(groupId).catch(() => false)
    if (isBlocked) {
      return { ok: false, error: 'blocked_from_group' }
    }
  }

  const existing = await db.getGroup(groupId)
  if (existing && !isReinvite) {
    return { ok: false, error: 'already_member', group: existing }
  }
  // Reinvite + already have group: member was removed while offline (never got
  // the blocked message). Delete stale local record so we can rejoin cleanly.
  if (existing && isReinvite) {
    await db.deleteGroup(groupId).catch(() => {})
    await sync.leaveGroup(groupId).catch(() => {})
  }

  // 3. Build a local group record and persist it
  const profile = await db.getProfile()
  const myMember = {
    id: profile.id, name: profile.name,
    avatar: profile.avatar ?? _initials(profile.name),
    publicKey: profile.publicKey,
    ...(profile.identityPublicKey ? { identityPublicKey: profile.identityPublicKey } : {}),
    ...(nickname ? { nickname } : {}),
  }
  // `inviterKey` is the inviter's profile.id (identity-derived). Old invite
  // links (pre-v1.0.23) carry the inviter's writerKey instead; in both shapes
  // the string is 64 hex chars so we can't distinguish at parse time. Either
  // way, the owner's Autobase record arrives on first replication and
  // authoritatively overrides this placeholder — see the non-authoritative
  // preserve rule in bare.js apply()/mirrorToLocal (landed in PR #116).
  const inviterMember = { id: inviterKey, name: 'Inviter', avatar: '?' }

  const group = {
    id:        groupId,
    name:      groupName,
    color:     _defaultColor(groupId),   // deterministic color from id hash
    emoji:     '👥',
    icon:      null,
    ownerId:   inviterKey,               // inviter is the owner
    groupKey,
    members: [ myMember, inviterMember ],
    joinedAt: Date.now(),
  }

  await db.putGroup(group)

  // 4. Add both members to the members table
  for (const m of group.members) {
    await db.putMember(groupId, m)
  }

  // 5. Join Hyperswarm topic — this triggers peer discovery and replication
  //    The inviter's device will connect and sync the full group state
  await sync.joinGroup(group)

  // 5b. Broadcast our real member record so the owner can update 'Inviter' placeholder
  //     Retry a few times since Autobase may not be writable yet
  let attempts = 0
  const broadcastSelf = async () => {
    try {
      // Restored-owner guard: once Autobase replay fixes the local group
      // record to list us as owner (ownerId === our profile.id), skip the
      // broadcast — otherwise our self-thin authoritative record wipes peers.
      const liveGroup = await db.getGroup(group.id).catch(() => null)
      if (liveGroup?.ownerId === profile.id) return
      // Send just ourselves — bare.js will merge with existing members on owner's side
      // Only include identity fields — never broadcast color/name/emoji or we may clobber owner's chosen values
      const updatedGroup = { id: group.id, groupKey: group.groupKey, ownerId: group.ownerId, members: [ myMember ], updatedAt: Date.now() }
      await sync.putGroup(updatedGroup)
      // Success — stop retrying
    } catch (e) {
      if (attempts++ < 15) setTimeout(broadcastSelf, 3000)
    }
  }
  setTimeout(broadcastSelf, 2000)

  // 6. Notify UI
  onJoined?.(group)

  return { ok: true, group }
}

/**
 * Generate an invite link for a group.
 *
 * @param {object} group
 * @param {string} myIdentityId  — inviter's `profile.id` (identity-derived,
 *                                 stable across devices). Pre-v1.0.23 links
 *                                 carried `profile.publicKey` (writer key);
 *                                 the joiner side accepts both shapes.
 * @returns {string}
 */
export function buildReinviteLink (group, myIdentityId) {
  const params = new URLSearchParams({
    group:   btoa(group.id),
    name:    group.name,
    key:     (group.groupKey ?? group.id).slice(0, KEY_LEN),
    inviter: myIdentityId,
    reinvite: '1',
  })
  return `${SCHEME}/join?${params.toString()}`
}

export function buildInviteLink (group, myIdentityId) {
  const params = new URLSearchParams({
    group:   btoa(group.id),
    name:    group.name,
    key:     (group.groupKey ?? group.id).slice(0, KEY_LEN),
    inviter: myIdentityId,
  })
  return `${SCHEME}/join?${params.toString()}`
}

/**
 * Parse and validate an invite URL (https://peerloomllc.com/join or legacy pear:// format).
 * Returns { ok: true, ...fields } or { ok: false, error: string }.
 *
 * @param {string} url
 * @returns {object}
 */
export function parseInviteLink (url) {
  if (typeof url !== 'string') {
    return { ok: false, error: 'invalid_url' }
  }

  // Accept three formats:
  //   https://peerloomllc.com/join?...  (current)
  //   pear://pearcal/join?...           (legacy)
  //   pearcal://join?...                (legacy)
  const normalised = url
    .replace(/^pear:\/\/pearcal\//, 'https://peerloomllc.com/')
    .replace(/^pearcal:\/\//, 'https://peerloomllc.com/')
  let u
  try { u = new URL(normalised) } catch {
    return { ok: false, error: 'malformed_url' }
  }

  // Must end up at peerloomllc.com/join (after normalisation)
  if (u.host !== 'peerloomllc.com' || !u.pathname.startsWith('/join')) {
    return { ok: false, error: 'wrong_path' }
  }

  const raw = {
    group:   u.searchParams.get('group'),
    name:    u.searchParams.get('name'),
    key:     u.searchParams.get('key'),
    inviter: u.searchParams.get('inviter'),
  }

  // Validate required params
  if (!raw.group || !raw.name || !raw.key || !raw.inviter) {
    return { ok: false, error: 'missing_params' }
  }

  // Decode group ID
  let groupId
  try { groupId = atob(raw.group) } catch {
    return { ok: false, error: 'invalid_group_id' }
  }

  // Sanitise group name
  const groupName = decodeURIComponent(raw.name).trim().slice(0, MAX_NAME)
  if (!groupName) return { ok: false, error: 'empty_name' }

  // Validate key lengths (hex strings)
  if (!/^[0-9a-f]+$/i.test(raw.key) || raw.key.length < 16) {
    return { ok: false, error: 'invalid_key' }
  }
  if (!/^[0-9a-f]+$/i.test(raw.inviter) || raw.inviter.length < 16) {
    return { ok: false, error: 'invalid_inviter' }
  }

  const reinvite = u.searchParams.get('reinvite') === '1'
  return {
    ok: true,
    groupId,
    groupName,
    reinvite,
    groupKey:   raw.key,
    inviterKey: raw.inviter,
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const PALETTE = [
  '#6C9BF5','#5DBF8A','#E5864A',
  '#D45F7A','#A97FD4','#4BBDCC',
  '#F5C842','#E07B54',
]

/** Deterministic color from group ID so all peers see the same default. */
function _defaultColor (groupId) {
  let h = 0
  for (const c of groupId) h = (Math.imul(31, h) + c.charCodeAt(0)) | 0
  return PALETTE[Math.abs(h) % PALETTE.length]
}

/** Generate initials from a display name. */
function _initials (name = '') {
  return name.trim().split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 2) || '?'
}

// ─── Device-pair URLs (TODO #11 Phase 4) ──────────────────────────────────────

/**
 * Build a `pearcal://pair` URL that a secondary device redeems to join the
 * primary's identity. Embeds the pairing-topic key, a one-shot handshake
 * token, the primary's identityPublicKey (so the secondary can verify the
 * peer it connects to is the expected identity), and a hard expiry.
 *
 * @param {object} params
 * @param {string} params.topic       32-byte topic as hex (64 chars)
 * @param {string} params.handshake   32-byte one-shot token as hex (64 chars)
 * @param {string} params.identity    primary identityPublicKey as hex (64 chars)
 * @param {number} params.expiresMs   unix-ms absolute expiry timestamp
 */
export function buildPairLink ({ topic, handshake, identity, expiresMs }) {
  const params = new URLSearchParams({
    topic, handshake, identity, expires: String(expiresMs),
  })
  return `${PAIR_SCHEME}?${params.toString()}`
}

/**
 * Parse and validate a `pearcal://pair` URL. Also accepts the
 * `pear://pearcal/pair` legacy shape so future clients that need to pipe
 * the URL through the existing `pear://` Android intent filter still work.
 *
 * Returns `{ ok: true, topic, handshake, identity, expiresMs }` or
 * `{ ok: false, error }`. Does NOT check `expiresMs` against wall-clock —
 * the caller decides how strict to be about stale links.
 */
export function parsePairLink (url) {
  if (typeof url !== 'string') return { ok: false, error: 'invalid_url' }
  const normalised = url.replace(/^pear:\/\/pearcal\/pair/, 'pearcal://pair')
  let u
  try { u = new URL(normalised) } catch { return { ok: false, error: 'malformed_url' } }
  if (u.protocol !== 'pearcal:' || u.host !== 'pair') {
    return { ok: false, error: 'wrong_scheme' }
  }
  const topic     = u.searchParams.get('topic')
  const handshake = u.searchParams.get('handshake')
  const identity  = u.searchParams.get('identity')
  const expiresS  = u.searchParams.get('expires')
  if (!topic || !handshake || !identity || !expiresS) {
    return { ok: false, error: 'missing_params' }
  }
  if (!_isHex(topic, PAIR_HEX_32))     return { ok: false, error: 'invalid_topic' }
  if (!_isHex(handshake, PAIR_HEX_32)) return { ok: false, error: 'invalid_handshake' }
  if (!_isHex(identity, PAIR_HEX_32))  return { ok: false, error: 'invalid_identity' }
  const expiresMs = Number(expiresS)
  if (!Number.isFinite(expiresMs) || expiresMs <= 0) {
    return { ok: false, error: 'invalid_expires' }
  }
  return { ok: true, topic, handshake, identity, expiresMs }
}

/** Cheap discriminator used by the RN shell's deep-link router. */
export function isPairLink (url) {
  return typeof url === 'string'
    && (url.startsWith('pearcal://pair') || url.startsWith('pear://pearcal/pair'))
}

function _isHex (s, len) {
  return typeof s === 'string' && s.length === len && /^[0-9a-f]+$/i.test(s)
}
