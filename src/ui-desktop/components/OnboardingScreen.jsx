// First-launch onboarding. Gates on profile.onboardingComplete (same
// field mobile uses, so a paired-from-mobile install lands on the
// calendar UI immediately because the primary already flipped the
// flag and identity sync brings it across).
//
// Two flows:
//   - fresh:  name + emoji avatar → updateProfile({ name, avatar, onboardingComplete })
//   - pair:   paste URL → consumePairLink → onPairCompleted flips flag
//             so the user lands on the calendar with the primary's
//             identity (name, avatar, groups, mnemonic) installed.

import { useEffect, useRef, useState } from 'react'
import BIP39_WORDS from 'bip39-mnemonic/wordlist/english.json'
import { phraseWordsFrom, pickWord, unknownWords } from '../../ui-shared/lib/phraseWords.js'
import { emitter } from '../../ui-shared/index.js'

const AVATAR_SUGGESTIONS = ['🍐', '🐝', '🌿', '🦊', '🌊', '🔥', '⭐', '🎯', '🍋', '🌸', '🐢', '🦋']

export function OnboardingScreen ({ tokens, profile, db, updateProfile }) {
  const [mode,    setMode]    = useState(null)        // null | 'fresh' | 'pair' | 'words'
  const [words,   setWords]   = useState(() => Array(12).fill(''))
  const [restored, setRestored] = useState(false)
  const wordRefs = useRef([])
  const [name,    setName]    = useState(profile?.name ?? '')
  const [avatar,  setAvatar]  = useState(profile?.avatar ?? '')
  const [busy,    setBusy]    = useState(false)
  const [err,     setErr]     = useState('')
  const [pasteUrl, setPasteUrl] = useState('')
  const [pairWaiting, setPairWaiting] = useState(false)
  const nameRef = useRef(null)

  useEffect(() => {
    if (mode === 'fresh') nameRef.current?.focus()
  }, [mode])

  // Pair event subscriptions: secondary-side completion flips the flag
  // and the App-level useProfile hook picks up the new state.
  useEffect(() => {
    async function onCompleted (data) {
      if (data?.role !== 'secondary') return
      try {
        await updateProfile({ onboardingComplete: true })
      } catch {}
      setPairWaiting(false)
    }
    function onFailed (data) {
      const reason = data?.reason ?? 'unknown'
      const message = data?.message ? ': ' + data.message : ''
      setPairWaiting(false); setBusy(false)
      setErr('Pairing failed (' + reason + ')' + message)
    }
    function onExpired () {
      setPairWaiting(false); setBusy(false)
      setErr('Pair link expired before the other device used it.')
    }
    emitter.on('pairingCompleted', onCompleted)
    emitter.on('pairingFailed',    onFailed)
    emitter.on('pairingExpired',   onExpired)
    return () => {
      emitter.off('pairingCompleted', onCompleted)
      emitter.off('pairingFailed',    onFailed)
      emitter.off('pairingExpired',   onExpired)
    }
  }, [updateProfile])

  async function handleFreshFinish () {
    const trimmed = name.trim()
    if (!trimmed) { setErr('Enter a name to continue.'); return }
    setBusy(true); setErr('')
    try {
      // tourPending is a device-local signal (updateProfile only syncs
      // name/avatar across paired devices). App.jsx picks it up after the
      // calendar mounts and runs the guided tour, then clears the flag.
      await updateProfile({ name: trimmed, avatar, onboardingComplete: true, tourPending: true })
    } catch (e) {
      setBusy(false)
      setErr('Could not save profile: ' + (e?.message ?? 'unknown error'))
    }
  }

  async function handlePairConsume () {
    const url = pasteUrl.trim()
    if (!url) { setErr('Paste a pairing link first.'); return }
    setBusy(true); setErr('')
    try {
      // DO NOT enablePersonalSync first as a secondary. consumePairLink's
      // _handlePairGranted overwrites personalMeta:bootstrap with the
      // primary's key and then calls ensurePersonalBase() — but
      // ensurePersonalBase short-circuits if personalBase is already set.
      // A pre-emptive enablePersonalSync mints a fresh local base, which
      // then "wins" the in-memory slot and the pair adopts the wrong base.
      // Symptom: groups sync (via _seedGroupsFromPair direct local write),
      // but identityProfile / deviceMeta / writers don't (they go through
      // the personal autobase that's pointing at the wrong key).
      setPairWaiting(true)
      // Resolves on pairingCompleted; the event handler flips
      // onboardingComplete and exits the screen.
      await db.consumePairLink(url)
    } catch (e) {
      const msg = e?.message ?? 'unknown error'
      setBusy(false); setPairWaiting(false)
      setErr('Could not redeem pair link: ' + msg.replace(/^consumePairLink: /, ''))
    }
  }

  // #176 step 4: the 12 recovery words, one box each. Pasting into any box
  // fills all 12; 4 letters pick a word and move on.
  function setWord (i, v) {
    const parts = phraseWordsFrom(v)
    if (parts.length > 1) {
      const next = Array(12).fill('')
      parts.slice(0, 12).forEach((w, j) => { next[j] = w })
      setWords(next); setErr('')
      wordRefs.current[Math.min(parts.length, 11)]?.focus()
      return
    }
    const t = parts[0] || ''
    const picked = t.length >= 4 ? pickWord(t, BIP39_WORDS) : null
    setWords(prev => prev.map((w, j) => j === i ? (picked || t) : w))
    setErr('')
    if (picked && i < 11) wordRefs.current[i + 1]?.focus()
  }

  async function handleRestore () {
    const bad = unknownWords(words.filter(Boolean), BIP39_WORDS)
    if (words.some(w => !w)) { setErr('Fill in all 12 words.'); return }
    if (bad.length) { setErr('Not a recovery word: ' + bad.join(', ')); return }
    setBusy(true); setErr('')
    try {
      await db.restoreFromPhrase(words.join(' '))
      // Name and avatar stay on each device, so they are asked for next.
      setRestored(true); setMode('fresh')
    } catch (e) {
      const m = e?.message || ''
      setErr(/invalid BIP39/i.test(m) ? "These words aren't a recovery phrase. Check each word and their order."
        : /different id/i.test(m) ? 'This device already has calendars under someone else. Restore on a fresh install.'
        : 'Could not restore: ' + (m || 'unknown error'))
    }
    setBusy(false)
  }

  async function cancelPair () {
    try { await db.cancelPairing() } catch {}
    setPairWaiting(false); setBusy(false); setPasteUrl(''); setErr('')
  }

  // Style tokens — match the rest of the desktop renderer.
  const inputBase = {
    width: '100%', padding: '8px 11px', borderRadius: 5,
    fontSize: 14, fontWeight: 400,
    border: `1px solid ${tokens.border}`, background: tokens.bg, color: tokens.text,
    fontFamily: tokens.font, boxSizing: 'border-box', outline: 'none',
  }
  const label = {
    fontSize: 11, fontWeight: 600, color: tokens.muted,
    textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 7,
  }
  const btnBase = {
    padding: '8px 16px', fontSize: 13, fontWeight: 500,
    borderRadius: 5, cursor: 'pointer',
    fontFamily: tokens.font, border: `1px solid ${tokens.border}`,
    background: tokens.bg, color: tokens.text,
  }
  const accentBtn = {
    ...btnBase,
    background: tokens.accent, color: tokens.bg, borderColor: tokens.accent,
  }

  return (
    <div style={{
      height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: tokens.bg, color: tokens.text, fontFamily: tokens.font,
    }}>
      <div style={{
        width: 520, maxWidth: '92vw',
        background: tokens.surface, border: `1px solid ${tokens.border}`,
        borderRadius: 12, padding: 28,
        boxShadow: '0 16px 48px rgba(0,0,0,0.5)',
      }}>
        <div style={{ textAlign: 'center', marginBottom: 22 }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>🍐</div>
          <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em', marginBottom: 4 }}>
            Welcome to PearCal
          </div>
          <div style={{ fontSize: 13, color: tokens.muted, lineHeight: 1.5 }}>
            A peer-to-peer calendar. No accounts, no servers, no data collection.
          </div>
        </div>

        {mode === null && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <button onClick={() => { setMode('fresh'); setErr('') }} style={{
              ...accentBtn, padding: '12px 18px', fontSize: 14, fontWeight: 600,
            }}>
              Start fresh
            </button>
            <button onClick={() => { setMode('pair'); setErr('') }} style={{
              ...btnBase, padding: '12px 18px', fontSize: 14, fontWeight: 500,
            }}>
              Pair with an existing device
            </button>
            <button onClick={() => { setMode('words'); setErr('') }} style={{
              ...btnBase, padding: '12px 18px', fontSize: 14, fontWeight: 500,
            }}>
              Enter my 12 words
            </button>
            <div style={{ fontSize: 12, color: tokens.muted, lineHeight: 1.5, textAlign: 'center', marginTop: 8 }}>
              Pair to bring your identity, profile, and groups across from another device running PearCal.
              Lost your devices? Your 12 words bring back who you are, and your calendars if a PeerLoom
              Seeder you paired kept your calendar list.
            </div>
          </div>
        )}

        {mode === 'words' && (
          <>
            <div style={{ fontSize: 13, color: tokens.text, lineHeight: 1.5, marginBottom: 12 }}>
              Enter the 12 words from Settings → Recovery phrase on your old device, in order.
              Pasting all 12 into the first box fills them in.
            </div>
            <datalist id="bip39-words">
              {BIP39_WORDS.map(w => <option key={w} value={w} />)}
            </datalist>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 12 }}>
              {words.map((w, i) => {
                const bad = w && !BIP39_WORDS.includes(w) && !BIP39_WORDS.some(x => x.startsWith(w))
                return (
                  <label key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: tokens.muted }}>
                    <span style={{ width: 18, textAlign: 'right' }}>{i + 1}</span>
                    <input ref={el => { wordRefs.current[i] = el }} value={w} list="bip39-words"
                      autoFocus={i === 0} autoComplete="off" spellCheck={false}
                      onChange={e => setWord(i, e.target.value)}
                      onKeyDown={e => { if ((e.key === 'Enter' || e.key === ' ') && i < 11) { e.preventDefault(); wordRefs.current[i + 1]?.focus() } }}
                      style={{ ...inputBase, padding: '6px 6px', fontFamily: 'ui-monospace, monospace', fontSize: 12,
                        borderColor: bad ? '#C0504A' : tokens.border }} />
                  </label>
                )
              })}
            </div>
            {err && <div style={{ fontSize: 12, color: '#C0504A', marginBottom: 10 }}>{err}</div>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 18 }}>
              <button onClick={() => { setMode(null); setWords(Array(12).fill('')); setErr('') }} disabled={busy}
                      style={{ ...btnBase, minWidth: 140, opacity: busy ? 0.5 : 1 }}>
                Back
              </button>
              <button onClick={handleRestore}
                      disabled={busy || words.some(x => !x)}
                      style={{
                        ...accentBtn, minWidth: 140,
                        opacity: (busy || words.some(x => !x)) ? 0.5 : 1,
                        cursor:  (busy || words.some(x => !x)) ? 'default' : 'pointer',
                      }}>
                {busy ? 'Restoring…' : 'Restore'}
              </button>
            </div>
          </>
        )}

        {mode === 'fresh' && (
          <>
            {restored && (
              <div style={{ fontSize: 13, color: tokens.text, lineHeight: 1.5, marginBottom: 14 }}>
                Your 12 words are in. Your calendars appear as they're found. Meanwhile, what name
                should members see?
              </div>
            )}
            <div style={{ marginBottom: 16 }}>
              <div style={label}>Your name</div>
              <input ref={nameRef} value={name}
                     onChange={e => { setName(e.target.value); setErr('') }}
                     placeholder="What should other people see?"
                     style={inputBase} />
            </div>
            <div style={{ marginBottom: 16 }}>
              <div style={label}>Pick an avatar</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {AVATAR_SUGGESTIONS.map(em => (
                  <button key={em} onClick={() => setAvatar(em)} style={{
                    width: 36, height: 36, borderRadius: 6, fontSize: 20,
                    background: avatar === em ? tokens.accent : tokens.bg,
                    color: tokens.text,
                    border: `1px solid ${avatar === em ? tokens.accent : tokens.border}`,
                    cursor: 'pointer', fontFamily: tokens.font,
                  }}>{em}</button>
                ))}
              </div>
              <div style={{ fontSize: 11, color: tokens.muted, marginTop: 6 }}>
                You can change this later, and add a photo, in Profile.
              </div>
            </div>
            {err && <div style={{ fontSize: 12, color: '#C0504A', marginBottom: 10 }}>{err}</div>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 18 }}>
              {!restored && (
                <button onClick={() => { setMode(null); setErr('') }} disabled={busy}
                        style={{ ...btnBase, minWidth: 140, opacity: busy ? 0.5 : 1 }}>
                  Back
                </button>
              )}
              <button onClick={handleFreshFinish}
                      disabled={busy || !name.trim()}
                      style={{
                        ...accentBtn, minWidth: 140,
                        opacity: (busy || !name.trim()) ? 0.5 : 1,
                        cursor:  (busy || !name.trim()) ? 'default' : 'pointer',
                      }}>
                {busy ? 'Saving…' : 'Finish'}
              </button>
            </div>
          </>
        )}

        {mode === 'pair' && (
          <>
            {!pairWaiting ? (
              <>
                <div style={{ fontSize: 13, color: tokens.text, lineHeight: 1.5, marginBottom: 12 }}>
                  On your other device, open Settings → Manage linked devices → Pair another device.
                  Copy the generated link and paste it below.
                </div>
                <div style={{ marginBottom: 10 }}>
                  <div style={label}>Pair link</div>
                  <textarea
                    value={pasteUrl}
                    onChange={e => { setPasteUrl(e.target.value); setErr('') }}
                    placeholder="pearcal://pair?topic=…"
                    rows={3}
                    style={{ ...inputBase, fontFamily: 'ui-monospace, monospace', fontSize: 11, resize: 'none' }} />
                </div>
                {err && <div style={{ fontSize: 12, color: '#C0504A', marginBottom: 10 }}>{err}</div>}
                <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 18 }}>
                  <button onClick={() => { setMode(null); setPasteUrl(''); setErr('') }} disabled={busy}
                          style={{ ...btnBase, minWidth: 140, opacity: busy ? 0.5 : 1 }}>
                    Back
                  </button>
                  <button onClick={handlePairConsume}
                          disabled={busy || !pasteUrl.trim()}
                          style={{
                            ...accentBtn, minWidth: 140,
                            opacity: (busy || !pasteUrl.trim()) ? 0.5 : 1,
                            cursor:  (busy || !pasteUrl.trim()) ? 'default' : 'pointer',
                          }}>
                    {busy ? 'Connecting…' : 'Pair'}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 13, color: tokens.text, lineHeight: 1.6, marginBottom: 14 }}>
                  Connecting to your other device over the peer-to-peer network. This usually takes a few
                  seconds. Both devices need to be online with PearCal open. The pair link expires 15
                  minutes after it was generated.
                </div>
                <div style={{
                  fontSize: 13, color: tokens.muted, fontStyle: 'italic',
                  textAlign: 'center', padding: '14px 0',
                }}>
                  Pairing… (you can leave this open)
                </div>
                <div style={{ display: 'flex', justifyContent: 'center' }}>
                  <button onClick={cancelPair} style={{ ...btnBase, minWidth: 140 }}>
                    Cancel
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
