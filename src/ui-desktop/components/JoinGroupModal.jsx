// Join-group modal. Mobile splits this into JoinGroupModal (paste URL)
// + NicknameBeforeJoinSheet (pick display name). Desktop folds both
// into a single screen since there's no QR-scanner camera path to
// branch around (per project_desktop_scope memory) and one screen feels
// more native to mouse-driven UX.
//
// Uses handleInviteLink from src/invite.js — same entry point mobile
// uses via joinWithNickname (src/ui/App.jsx:1004). Returns
// { ok, group, error } shape.

import { useEffect, useRef, useState } from 'react'
import { handleInviteLink } from '../../invite.js'

const VALID_PREFIXES = [
  'https://peerloomllc.com/join',
  'pear://pearcal/join',
  'pearcal://join',
]

function looksLikeInvite (url) {
  return VALID_PREFIXES.some(p => url.startsWith(p))
}

function nameFromUrl (url) {
  try { return new URL(url).searchParams.get('name') || '' } catch { return '' }
}

export function JoinGroupModal ({ tokens, profile, db, sync, onJoined, onClose }) {
  const [url,      setUrl]      = useState('')
  const [nickname, setNickname] = useState(profile?.name ?? '')
  const [joining,  setJoining]  = useState(false)
  const [err,      setErr]      = useState('')
  const urlRef = useRef(null)

  useEffect(() => { urlRef.current?.focus() }, [])
  useEffect(() => {
    function onKey (e) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const trimmedUrl = url.trim()
  const valid      = looksLikeInvite(trimmedUrl)
  const groupName  = valid ? nameFromUrl(trimmedUrl) : ''

  async function handleJoin () {
    if (!valid) { setErr('Not a valid PearCal invite link.'); return }
    setJoining(true); setErr('')
    try {
      const nick = nickname.trim() && nickname.trim() !== (profile?.name ?? '') ? nickname.trim() : null
      const result = await handleInviteLink(trimmedUrl, db, sync, () => {}, nick)
      if (result?.ok && result.group) {
        onJoined(result.group)
        onClose()
      } else if (result?.error === 'already_member') {
        setErr('You are already a member of this group.')
      } else if (result?.error === 'blocked_from_group') {
        setErr('You were removed from this group. Ask the owner for a fresh invite.')
      } else {
        setErr('Could not join group. Check the invite link and try again.')
      }
    } catch (e) {
      setErr('Could not join group: ' + (e?.message ?? 'unknown error'))
    }
    setJoining(false)
  }

  const inputBase = {
    width: '100%', padding: '7px 10px', borderRadius: 5,
    fontSize: 13, fontWeight: 400,
    border: `1px solid ${tokens.border}`, background: tokens.bg, color: tokens.text,
    fontFamily: tokens.font, boxSizing: 'border-box', outline: 'none',
  }
  const label = {
    fontSize: 11, fontWeight: 600, color: tokens.muted,
    textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 7,
  }
  const btnBase = {
    padding: '7px 14px', fontSize: 13, fontWeight: 500,
    borderRadius: 5, cursor: 'pointer',
    fontFamily: tokens.font, border: `1px solid ${tokens.border}`,
    background: tokens.bg, color: tokens.text,
  }

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: tokens.surface, border: `1px solid ${tokens.border}`,
        borderRadius: 10, padding: 20, width: 460, maxWidth: '90vw',
        boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
        fontFamily: tokens.font,
      }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>Join a Group</div>

        <div style={{ marginBottom: 14 }}>
          <div style={label}>Invite link</div>
          <textarea ref={urlRef} value={url}
                    onChange={e => { setUrl(e.target.value); setErr('') }}
                    placeholder="Paste invite link here"
                    rows={3}
                    style={{ ...inputBase, fontFamily: 'ui-monospace, monospace', fontSize: 11, resize: 'none' }} />
          {valid && groupName && (
            <div style={{ fontSize: 12, color: tokens.muted, marginTop: 6 }}>
              Joining: {groupName}
            </div>
          )}
        </div>

        <div style={{ marginBottom: 14 }}>
          <div style={label}>Display name in this group</div>
          <input value={nickname} onChange={e => setNickname(e.target.value)}
                 placeholder={profile?.name ?? 'Your name'} style={inputBase} />
          <div style={{ fontSize: 11, color: tokens.muted, marginTop: 5 }}>
            How other members will see you. Defaults to your profile name.
          </div>
        </div>

        {err && <div style={{ fontSize: 12, color: '#C0504A', marginBottom: 10 }}>{err}</div>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 18 }}>
          <button onClick={onClose} style={{ ...btnBase, minWidth: 140 }}>Cancel</button>
          <button onClick={handleJoin} disabled={!valid || joining} style={{
            ...btnBase, minWidth: 140,
            background: tokens.accent, color: tokens.bg, borderColor: tokens.accent,
            opacity: (!valid || joining) ? 0.5 : 1,
            cursor:  (!valid || joining) ? 'default' : 'pointer',
          }}>{joining ? 'Joining…' : 'Join'}</button>
        </div>
      </div>
    </div>
  )
}
