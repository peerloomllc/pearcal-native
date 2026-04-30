// Profile editing modal: name + avatar (emoji char or photo upload).
// Holiday subscriptions and the advanced/personal sections from
// mobile's ProfileTab are deferred to D7.3.
//
// Photo handling lives in ../lib/imagePicker.js so NewGroupModal and
// GroupSettingsModal share the same compress + animated-passthrough
// behaviour.

import { useEffect, useRef, useState } from 'react'
import { compressImage } from '../lib/imagePicker.js'

const AVATAR_SUGGESTIONS = ['🍐', '🐝', '🌿', '🦊', '🌊', '🔥', '⭐', '🎯', '🍋', '🌸', '🐢', '🦋']

export function ProfileModal ({ tokens, profile, updateProfile, onClose }) {
  const [name,   setName]   = useState(profile?.name ?? '')
  const [avatar, setAvatar] = useState(profile?.avatar ?? '')
  const [saving, setSaving] = useState(false)
  const [photoBusy, setPhotoBusy] = useState(false)
  const [photoErr,  setPhotoErr]  = useState('')
  const nameRef = useRef(null)
  const fileRef = useRef(null)

  async function handleFile (e) {
    const file = e.target.files?.[0]
    e.target.value = ''  // allow picking the same file again
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setPhotoErr('That file is not an image.')
      return
    }
    setPhotoBusy(true); setPhotoErr('')
    try {
      const compressed = await compressImage(file)
      setAvatar(compressed)
    } catch (err) {
      setPhotoErr('Could not load image: ' + (err?.message ?? 'unknown error'))
    }
    setPhotoBusy(false)
  }
  function clearPhoto () { setAvatar(''); setPhotoErr('') }

  useEffect(() => { nameRef.current?.focus() }, [])
  useEffect(() => {
    function onKey (e) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function handleSave () {
    const trimmed = name.trim()
    if (!trimmed) return
    setSaving(true)
    try {
      await updateProfile({ name: trimmed, avatar: avatar.trim() })
      onClose()
    } catch (e) {
      setSaving(false)
      alert('Could not save profile: ' + (e?.message ?? 'unknown error'))
    }
  }

  const inputBase = {
    width: '100%', padding: '7px 10px', borderRadius: 5,
    fontSize: 13, fontWeight: 400,
    border: `1px solid ${tokens.border}`, background: tokens.bg, color: tokens.text,
    fontFamily: tokens.font, boxSizing: 'border-box', outline: 'none',
  }
  const label = {
    fontSize: 11, fontWeight: 600, color: tokens.muted,
    textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 5,
  }
  const btnBase = {
    padding: '7px 14px', fontSize: 13, fontWeight: 500,
    borderRadius: 5, cursor: 'pointer',
    fontFamily: tokens.font, border: `1px solid ${tokens.border}`,
    background: tokens.bg, color: tokens.text,
  }

  // Avatar preview is a single character (emoji or letter). Image-data
  // avatars are still rendered if the profile already has one — we just
  // don't expose photo upload here. Mobile's profile tab still owns that.
  const isPhoto = avatar?.startsWith?.('data:')

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: tokens.surface, border: `1px solid ${tokens.border}`,
        borderRadius: 10, padding: 20, width: 420, maxWidth: '90vw',
        boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
        fontFamily: tokens.font,
      }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>Profile</div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 14 }}>
          <div style={{
            width: 52, height: 52, borderRadius: '50%',
            background: tokens.accent, color: tokens.bg,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 24, fontWeight: 600, overflow: 'hidden', flexShrink: 0,
          }}>
            {isPhoto
              ? <img src={avatar} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              : (avatar?.trim() || name.trim()[0]?.toUpperCase() || '?')}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={label}>Name</div>
            <input ref={nameRef} value={name} onChange={e => setName(e.target.value)}
                   placeholder="Your name" style={inputBase} />
          </div>
        </div>

        <div style={{ marginBottom: 14 }}>
          <div style={label}>Avatar</div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            <button onClick={() => fileRef.current?.click()} disabled={photoBusy}
                    style={{ ...btnBase, flex: 1, opacity: photoBusy ? 0.5 : 1 }}>
              {photoBusy ? 'Loading…' : (isPhoto ? 'Change Photo' : 'Choose Photo')}
            </button>
            <button onClick={clearPhoto} disabled={!isPhoto}
                    style={{ ...btnBase, flex: 1, opacity: isPhoto ? 1 : 0.4, cursor: isPhoto ? 'pointer' : 'default' }}>
              Remove Photo
            </button>
          </div>
          <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }}
                 onChange={handleFile} />
          {photoErr && (
            <div style={{ fontSize: 11, color: '#C0504A', marginBottom: 6 }}>{photoErr}</div>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {AVATAR_SUGGESTIONS.map(em => (
              <button key={em} onClick={() => setAvatar(em)} style={{
                width: 32, height: 32, borderRadius: 6, fontSize: 18,
                background: !isPhoto && avatar === em ? tokens.accent : tokens.bg,
                color: tokens.text,
                border: `1px solid ${!isPhoto && avatar === em ? tokens.accent : tokens.border}`,
                cursor: 'pointer', fontFamily: tokens.font,
              }}>{em}</button>
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 18 }}>
          <button onClick={onClose} style={{ ...btnBase, minWidth: 140 }}>Cancel</button>
          <button onClick={handleSave} disabled={!name.trim() || saving} style={{
            ...btnBase, minWidth: 140,
            background: tokens.accent, color: tokens.bg, borderColor: tokens.accent,
            opacity: (!name.trim() || saving) ? 0.5 : 1,
            cursor:  (!name.trim() || saving) ? 'default' : 'pointer',
          }}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  )
}
