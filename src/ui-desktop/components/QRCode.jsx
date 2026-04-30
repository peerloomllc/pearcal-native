// QRCode renderer — encodes any string (pearcal://pair?... or
// https://peerloomllc.com/join?...) into a scannable code. Renders to a
// <canvas> via the same `qrcode` npm package mobile uses, so the visual
// output matches across platforms.
//
// Re-renders whenever `value`, `size`, or `tokens.bg`/`tokens.text` change so
// dark/light mode flips don't strand a stale code on screen.

import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'

export function QRCodeCanvas ({ value, size = 240, tokens }) {
  const canvasRef = useRef(null)
  const [err, setErr] = useState(null)

  useEffect(() => {
    if (!canvasRef.current || !value) return
    setErr(null)
    try {
      QRCode.toCanvas(canvasRef.current, value, {
        width: size,
        margin: 2,
        color: {
          dark:  tokens?.text ?? '#000000',
          light: tokens?.bg   ?? '#FFFFFF',
        },
      }, e => { if (e) setErr(e.message) })
    } catch (e) {
      setErr(e?.message ?? 'qr render failed')
    }
  }, [value, size, tokens?.bg, tokens?.text])

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
