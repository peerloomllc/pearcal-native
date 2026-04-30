// QRCode renderer — encodes any string (pearcal://pair?... or
// https://peerloomllc.com/join?...) into a scannable code. Renders to a
// <canvas> via the same `qrcode` npm package mobile uses.
//
// Two reliability tweaks vs. a vanilla call:
//   1. Always black-on-white — theming with dark surface tokens produces
//      an INVERTED QR. iPhone's Vision decodes inverted; Android's ZXing
//      doesn't. B&W is the safe default every scanner accepts.
//   2. errorCorrectionLevel='L' — pair URLs are ~250 chars, which at the
//      default M level needs QR version ~11-12 (61x61). At size=240 that's
//      ~3.9px/module, on the edge of what Android cameras decode reliably.
//      Level L drops overhead and brings the version down → bigger modules.
//      Acceptable tradeoff: pair links are short-lived and the QR is shown
//      on a clean screen, not printed/photographed.

import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'

export function QRCodeCanvas ({ value, size = 260, tokens }) {
  const canvasRef = useRef(null)
  const [err, setErr] = useState(null)

  useEffect(() => {
    if (!canvasRef.current || !value) return
    setErr(null)
    try {
      QRCode.toCanvas(canvasRef.current, value, {
        width: size,
        margin: 3,
        errorCorrectionLevel: 'L',
        color: { dark: '#000000', light: '#FFFFFF' },
      }, e => { if (e) setErr(e.message) })
    } catch (e) {
      setErr(e?.message ?? 'qr render failed')
    }
  }, [value, size])

  if (err) {
    return (
      <div style={{
        width: size, height: size, display: 'flex', alignItems: 'center',
        justifyContent: 'center', fontSize: 11, color: '#C0504A',
        border: `1px solid ${tokens?.border ?? '#444'}`, borderRadius: 6,
        padding: 8, textAlign: 'center', fontFamily: tokens?.font,
      }}>
        QR error: {err}
      </div>
    )
  }
  return <canvas ref={canvasRef} style={{ borderRadius: 6, display: 'block' }} />
}
