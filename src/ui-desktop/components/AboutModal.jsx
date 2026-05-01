// About modal — desktop port of mobile's AboutTab. Surfaces P2P explainer,
// donations, Bitcoin learning, share, contact, and the welcome-tour replay
// in one place. Independent of Settings — separate entry point lets users
// discover the donation + share flows without digging through preferences.
//
// Donations: mobile probes for a native Lightning wallet via canOpenLightning
// before showing the wallet picker. Desktop users almost never have a native
// Lightning wallet installed, so we just show the wallet recommendations
// inline when BTC is tapped — fewer dead-ends.

import { useEffect, useState } from 'react'
import { QRCodeCanvas } from './QRCode.jsx'

// Injected by electron/scripts/bundle-ui.sh from electron/package.json#version
// at build time. Falls back to "0.0.0" only if someone runs the bundle without
// that script (e.g., raw esbuild during dev).
const APP_VERSION = process.env.PEARCAL_VERSION || '0.0.0'

const LIGHTNING_ADDRESS = 'peerloomllc@strike.me'

export function AboutModal ({ tokens, sync, onReplayTour, onClose }) {
  const [lightningOpen, setLightningOpen] = useState(false)

  useEffect(() => {
    function onKey (e) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const open = (url) => sync?.openURL?.(url)

  const sectionLabel = {
    fontSize: 11, fontWeight: 600, color: tokens.muted,
    textTransform: 'uppercase', letterSpacing: '0.08em',
    textAlign: 'center', marginBottom: 6,
  }
  const card = {
    background: tokens.bg, border: `1px solid ${tokens.border}`,
    borderRadius: 8, padding: '12px 14px', marginBottom: 10,
  }
  const body = {
    fontSize: 12, fontWeight: 400, color: tokens.muted,
    lineHeight: 1.6, marginBottom: 10,
  }
  const btn = {
    padding: '8px 14px', fontSize: 13, fontWeight: 500,
    borderRadius: 5, cursor: 'pointer',
    fontFamily: tokens.font, border: `1px solid ${tokens.border}`,
    background: tokens.bg, color: tokens.text,
  }
  const accentBtn = { ...btn, background: tokens.accent, color: tokens.bg, borderColor: tokens.accent }
  const fullBtn = { ...accentBtn, width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: tokens.surface, border: `1px solid ${tokens.border}`,
        borderRadius: 10, padding: 20, width: 480, maxWidth: '92vw',
        maxHeight: '88vh', overflowY: 'auto',
        boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
        fontFamily: tokens.font,
      }}>
        <div style={{ position: 'relative', marginBottom: 14 }}>
          <div style={{ fontSize: 14, fontWeight: 600, textAlign: 'center' }}>About</div>
          <button onClick={onClose} style={{
            ...btn, padding: '4px 10px', fontSize: 14,
            background: 'transparent', border: 'none',
            position: 'absolute', top: 0, right: 0,
          }}>✕</button>
        </div>

        {/* App identity */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, marginBottom: 16 }}>
          <div style={{ fontSize: 18, fontWeight: 600, color: tokens.text }}>PearCal</div>
          <div style={{ fontSize: 12, color: tokens.muted }}>Decentralized. Private. No servers.</div>
        </div>

        {/* How it works */}
        <div style={card}>
          <div style={sectionLabel}>How it works</div>
          <div style={body}>
            PearCal syncs directly between devices using peer-to-peer technology powered by Hypercore Protocol.
            Your calendar data never touches a server — it lives only on the devices in your groups.
            No accounts. No subscriptions. No data collection.
          </div>
          <button onClick={() => open('https://pears.com/')} style={fullBtn}>
            Learn about P2P ↗
          </button>
        </div>

        {/* Replay tour */}
        {onReplayTour && (
          <div style={card}>
            <div style={sectionLabel}>Help</div>
            <div style={body}>
              Walk through the calendar's main controls again — sidebar, view tabs, create flow, profile, settings.
            </div>
            <button onClick={onReplayTour} style={fullBtn}>
              Replay welcome tour
            </button>
          </div>
        )}

        {/* Support development */}
        <div style={card}>
          <div style={sectionLabel}>Support development</div>
          <div style={body}>
            PearCal is free and open source. If you receive value from it, please consider returning value.
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => setLightningOpen(true)} style={{ ...accentBtn, flex: 1 }}>
              ⚡ Donate BTC ⚡
            </button>
            <button onClick={() => open('https://buymeacoffee.com/peerloomllc')} style={{ ...accentBtn, flex: 1 }}>
              $ Donate USD $
            </button>
          </div>
        </div>

        {/* Bitcoin learning */}
        <div style={card}>
          <div style={sectionLabel}>Learn about Bitcoin</div>
          <div style={body}>
            New to Bitcoin? The Satoshi Nakamoto Institute has a free, concise crash course explaining how Bitcoin works and why it matters.
          </div>
          <button onClick={() => open('https://nakamotoinstitute.org/crash-course/')} style={fullBtn}>
            Bitcoin Crash Course ↗
          </button>
        </div>

        {/* Share */}
        <div style={card}>
          <div style={sectionLabel}>Share the app</div>
          <div style={body}>
            Know someone who'd enjoy a private, serverless calendar? Share PearCal with them.
          </div>
          <button onClick={() => sync?.nativeShare?.('PearCal', 'Check out PearCal — a private, peer-to-peer calendar app with no servers or accounts.\n\nhttps://peerloomllc.com/pearcal/')}
                  style={fullBtn}>
            Copy share link
          </button>
        </div>

        {/* Contact */}
        <div style={card}>
          <div style={sectionLabel}>Contact</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => open('mailto:peerloomllc@proton.me?subject=%5BPearCal%5D%20Feedback')}
                    style={{ ...btn, flex: 1 }}>
              Send Email ↗
            </button>
            <button onClick={() => open('https://github.com/peerloomllc/pearcal-native/issues')}
                    style={{ ...btn, flex: 1 }}>
              Report Issue ↗
            </button>
          </div>
        </div>

        <div style={{ textAlign: 'center', fontSize: 11, color: tokens.muted, marginTop: 14 }}>
          v{APP_VERSION}
        </div>

        {lightningOpen && (
          <LightningSubModal tokens={tokens} onClose={() => setLightningOpen(false)} />
        )}
      </div>
    </div>
  )
}

// Lightning donation submodal — shows a QR code encoding the Lightning
// address plus the address as text with a copy button. Mobile probes for
// a native Lightning wallet via canOpenLightning and falls back to a
// wallet picker; desktop users almost never have a native wallet linked
// to the OS, so we skip the probe entirely and just render the QR + text.
// User scans with their wallet app or copies the address manually.
function LightningSubModal ({ tokens, onClose }) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    function onKey (e) { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function copyAddress () {
    try { await navigator.clipboard?.writeText?.(LIGHTNING_ADDRESS) } catch {}
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const btn = {
    padding: '8px 14px', fontSize: 13, fontWeight: 500,
    borderRadius: 5, cursor: 'pointer',
    fontFamily: tokens.font, border: `1px solid ${tokens.border}`,
    background: tokens.bg, color: tokens.text,
  }

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: tokens.surface, border: `1px solid ${tokens.border}`,
        borderRadius: 10, padding: 20, width: 360, maxWidth: '92vw',
        boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
        fontFamily: tokens.font,
      }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: tokens.text, textAlign: 'center', marginBottom: 6 }}>
          ⚡ Donate via Lightning ⚡
        </div>
        <div style={{ fontSize: 12, color: tokens.muted, lineHeight: 1.5, textAlign: 'center', marginBottom: 14 }}>
          Scan with your Lightning wallet, or copy the address below.
        </div>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 14 }}>
          <QRCodeCanvas value={LIGHTNING_ADDRESS} size={220} tokens={tokens} />
        </div>
        <div onClick={copyAddress}
             title="Click to copy"
             style={{
               fontSize: 12, fontFamily: 'ui-monospace, monospace',
               color: tokens.text, textAlign: 'center',
               padding: '8px 10px', borderRadius: 6,
               border: `1px solid ${tokens.border}`, background: tokens.bg,
               cursor: 'pointer', wordBreak: 'break-all', marginBottom: 10,
             }}>
          {LIGHTNING_ADDRESS}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={copyAddress} style={{ ...btn, flex: 1 }}>
            {copied ? '✓ Copied' : 'Copy address'}
          </button>
          <button onClick={onClose} style={{ ...btn, flex: 1 }}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
