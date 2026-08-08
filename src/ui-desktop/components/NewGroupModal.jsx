// Create-group modal. Two phases inside the same modal:
//   1. Form  — name + emoji + color
//   2. Share — show the freshly built invite link with Copy
//
// We deliberately skip image-icon upload (mobile's `icon` data-URL field)
// for D7.2 — emoji + color is enough to differentiate groups in the
// sidebar; per-group photo icons can come back with the rest of the
// long-tail group settings.

import { useEffect, useRef, useState } from 'react'
import { compressImage } from '../lib/imagePicker.js'
import { QRCodeCanvas } from './QRCode.jsx'

const GROUP_COLORS = ['#6C9BF5','#5DBF8A','#E5864A','#D45F7A','#A97FD4','#4BBDCC','#F5C842','#E07B54']
const GROUP_EMOJIS = ['👨‍👩‍👧‍👦','⚽','📚','🎮','🏋️','🎵','🌿','🐾','✈️','🍕','💼','🎨']

export function NewGroupModal ({ tokens, profile, sync, db, addGroup, onClose }) {
  const [name,    setName]    = useState('')
  const [emoji,   setEmoji]   = useState(GROUP_EMOJIS[0])
  const [color,   setColor]   = useState(GROUP_COLORS[0])
  const [icon,    setIcon]    = useState(null)
  const [iconBusy, setIconBusy] = useState(false)
  const [iconErr,  setIconErr]  = useState('')
  const [creating, setCreating] = useState(false)
  const [created,  setCreated]  = useState(null)   // group object once created
  // #164 - the invite link is minted by the WORKLET from the authoritative
  // group record, never rebuilt here. A UI copy can be missing the local-only
  // encryptionKey, and a link without `enc=` produces a member who can never
  // sync. Empty until it arrives, which also means an outright refusal (this
  // device holds no key for an encrypted group) shows nothing to copy.
  const [inviteLink, setInviteLink] = useState('')
  const [err,     setErr]     = useState('')
  const [copied,  setCopied]  = useState(false)
  const nameRef = useRef(null)
  const fileRef = useRef(null)

  async function handleFile (e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setIconErr('That file is not an image.')
      return
    }
    setIconBusy(true); setIconErr('')
    try {
      const compressed = await compressImage(file)
      setIcon(compressed)
    } catch (err) {
      setIconErr('Could not load image: ' + (err?.message ?? 'unknown error'))
    }
    setIconBusy(false)
  }
  function clearIcon () { setIcon(null); setIconErr('') }

  useEffect(() => { nameRef.current?.focus() }, [])
  useEffect(() => {
    function onKey (e) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function handleCreate () {
    const trimmed = name.trim()
    if (!trimmed) { setErr('Group name required'); return }
    setCreating(true); setErr('')
    try {
      // Bare-side createGroup opens the Autobase, captures base.key as
      // groupKey, persists the record, joins the swarm — returns the
      // materialised group we hand to addGroup with alreadyJoined: true.
      const g = await sync.createGroup(trimmed, { color, emoji, icon })
      if (!g) throw new Error('createGroup returned null')
      await addGroup(g, { alreadyJoined: true })
      setCreated(g)
    } catch (e) {
      setErr('Could not create group: ' + (e?.message ?? 'unknown error'))
    }
    setCreating(false)
  }

  // Ask the worklet for the link as soon as the group exists.
  useEffect(() => {
    if (!created?.id || !db?.buildInvite) return
    let alive = true
    db.buildInvite(created.id)
      .then(l => { if (alive && typeof l === 'string') setInviteLink(l) })
      .catch(() => {})
    return () => { alive = false }
  }, [created?.id, db])

  async function copyLink () {
    if (!inviteLink) return
    try { await navigator.clipboard?.writeText?.(inviteLink) } catch {}
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
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
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>
          {created ? 'Group created' : 'Create a Group'}
        </div>

        {!created ? (
          <>
            <div style={{ marginBottom: 14 }}>
              <div style={label}>Name</div>
              <input ref={nameRef} value={name} onChange={e => { setName(e.target.value); setErr('') }}
                     placeholder="Family, Work, Soccer Team..." style={inputBase} />
            </div>

            <div style={{ marginBottom: 14 }}>
              <div style={label}>Group icon</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
                <div style={{
                  width: 44, height: 44, borderRadius: 8,
                  background: icon ? 'transparent' : color + '22',
                  border: `2px solid ${color}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 22, overflow: 'hidden', flexShrink: 0,
                }}>
                  {icon
                    ? <img src={icon} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    : emoji}
                </div>
                <div style={{ display: 'flex', gap: 6, flex: 1 }}>
                  <button onClick={() => fileRef.current?.click()} disabled={iconBusy}
                          style={{ ...btnBase, flex: 1, opacity: iconBusy ? 0.5 : 1 }}>
                    {iconBusy ? 'Loading…' : (icon ? 'Change Photo' : 'Choose Photo')}
                  </button>
                  <button onClick={clearIcon} disabled={!icon}
                          style={{ ...btnBase, flex: 1, opacity: icon ? 1 : 0.4, cursor: icon ? 'pointer' : 'default' }}>
                    Remove Photo
                  </button>
                </div>
              </div>
              <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }}
                     onChange={handleFile} />
              {iconErr && (
                <div style={{ fontSize: 11, color: '#C0504A', marginBottom: 6 }}>{iconErr}</div>
              )}
              <div style={{ fontSize: 11, color: tokens.muted, marginBottom: 6 }}>
                Or pick an emoji:
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                {GROUP_EMOJIS.map(em => (
                  <button key={em} onClick={() => { setEmoji(em); setIcon(null) }} style={{
                    width: 30, height: 30, borderRadius: 6, fontSize: 16,
                    background: !icon && emoji === em ? color + '22' : tokens.bg,
                    border: `2px solid ${!icon && emoji === em ? color : tokens.border}`,
                    cursor: 'pointer', fontFamily: tokens.font,
                  }}>{em}</button>
                ))}
              </div>
            </div>

            <div style={{ marginBottom: 14 }}>
              <div style={label}>Color</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {GROUP_COLORS.map(c => (
                  <button key={c} onClick={() => setColor(c)} style={{
                    width: 26, height: 26, borderRadius: '50%',
                    background: c, border: 'none',
                    outline: color === c ? `2px solid ${tokens.text}` : 'none',
                    outlineOffset: 2, cursor: 'pointer',
                  }} aria-label={'Color ' + c} />
                ))}
              </div>
            </div>

            {err && <div style={{ fontSize: 12, color: '#C0504A', marginBottom: 10 }}>{err}</div>}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 18 }}>
              <button onClick={onClose} style={{ ...btnBase, minWidth: 140 }}>Cancel</button>
              <button onClick={handleCreate} disabled={!name.trim() || creating} style={{
                ...btnBase, minWidth: 140,
                background: tokens.accent, color: tokens.bg, borderColor: tokens.accent,
                opacity: (!name.trim() || creating) ? 0.5 : 1,
                cursor:  (!name.trim() || creating) ? 'default' : 'pointer',
              }}>{creating ? 'Creating…' : 'Create'}</button>
            </div>
          </>
        ) : (
          <>
            <div style={{ fontSize: 13, color: tokens.text, marginBottom: 12, lineHeight: 1.5 }}>
              "{created.name}" is ready. Share this invite link with anyone you want to add to the group. They paste it into PearCal to join.
            </div>
            <div style={{ marginBottom: 12 }}>
              <div style={label}>Invite</div>
              <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 10 }}>
                <QRCodeCanvas value={inviteLink} size={240} tokens={tokens} />
              </div>
              <textarea readOnly value={inviteLink} rows={3}
                        onClick={e => e.target.select()}
                        style={{ ...inputBase, fontFamily: 'ui-monospace, monospace', fontSize: 11, resize: 'none' }} />
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 18 }}>
              <button onClick={copyLink} style={{ ...btnBase, minWidth: 140 }}>
                {copied ? '✓ Copied' : 'Copy Link'}
              </button>
              <button onClick={onClose} style={{
                ...btnBase, minWidth: 140,
                background: tokens.accent, color: tokens.bg, borderColor: tokens.accent,
              }}>Done</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
