/**
 * PearCal — Invite Link Handler
 *
 * Invite link format:
 *   pear://pearcal/join?group={base64(groupId)}&name={groupName}&key={groupKey}&inviter={publicKey}
 *
 * Flow:
 *   1. Link is intercepted by Android intent filter → passed to Pear runtime
 *   2. Pear runtime fires the 'link' event in src/index.js
 *   3. handleInviteLink() is called with the raw URL string
 *   4. We parse + validate the params, prompt the user to confirm, then:
 *      a. Write the group to local Hyperbee
 *      b. Join the group's Hyperswarm topic via SyncManager
 *      c. Replicate with the inviter to pull group metadata + events
 *      d. Notify the UI so it re-renders with the new group
 */

//import b4a from 'b4a'

// ─── Constants ────────────────────────────────────────────────────────────────

const SCHEME   = 'pearcal://pearcal'
const MAX_NAME = 64    // chars
const KEY_LEN  = 64    // hex chars (32-byte public key)

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
export async function handleInviteLink (url, db, sync, onJoined) {
  // 1. Parse
  const parsed = parseInviteLink(url)
  if (!parsed.ok) return parsed

  const { groupId, groupName, groupKey, inviterKey } = parsed

  // 2. Check we're not already a member
  const existing = await db.getGroup(groupId)
  if (existing) {
    return { ok: false, error: 'already_member', group: existing }
  }

  // 3. Build a local group record and persist it
  const profile = await db.getProfile()
  const myMember = { id: profile.id, name: profile.name, avatar: profile.avatar ?? _initials(profile.name), publicKey: profile.publicKey }
  const inviterMember = { id: inviterKey, name: 'Inviter', avatar: '?', publicKey: inviterKey }

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
      // Send just ourselves — bare.js will merge with existing members on owner's side
      const updatedGroup = { ...group, members: [ myMember ], updatedAt: Date.now() }
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
 * @param {string} myPublicKey  — hex public key of the inviting user
 * @returns {string}
 */
export function buildInviteLink (group, myPublicKey) {
  const params = new URLSearchParams({
    group:   btoa(group.id),
    name:    group.name,
    key:     (group.groupKey ?? group.id).slice(0, KEY_LEN),
    inviter: myPublicKey,
  })
  return `${SCHEME}/join?${params.toString()}`
}

/**
 * Parse and validate a raw pear:// invite URL.
 * Returns { ok: true, ...fields } or { ok: false, error: string }.
 *
 * @param {string} url
 * @returns {object}
 */
export function parseInviteLink (url) {
  if (typeof url !== 'string') {
    return { ok: false, error: 'invalid_url' }
  }

  // Strip the custom scheme so URL() can parse it
  const normalised = url.replace(/^pearcal:\/\//, 'https://')
  let u
  try { u = new URL(normalised) } catch {
    return { ok: false, error: 'malformed_url' }
  }

  // Must match pear://pearcal/join
  if (!url.startsWith(`${SCHEME}/join`)) {
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

  return {
    ok: true,
    groupId,
    groupName,
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
