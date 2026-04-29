// Shared image-picker utilities for the desktop renderer.
//
// Behaviour mirrors mobile's avatar pipeline (src/ui/App.jsx:1819-1855):
// center-crop to square + downscale to a fixed pixel side, prefer webp
// at 0.82 quality with a jpeg fallback for older renderers. Animated
// formats (gif, animated webp) bypass canvas — the canvas path flattens
// to a static first frame, so downscaling would strip animation.

const DEFAULT_SIZE_PX = 96
const DEFAULT_QUALITY = 0.82

export function readFileAsDataUrl (file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload  = () => resolve(reader.result)
    reader.onerror = () => reject(new Error('Could not read file'))
    reader.readAsDataURL(file)
  })
}

export function downscaleDataUrl (dataUrl, size = DEFAULT_SIZE_PX, quality = DEFAULT_QUALITY) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const timeout = setTimeout(() => reject(new Error('Image load timed out')), 15000)
    img.onload = () => {
      clearTimeout(timeout)
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = size
      const ctx = canvas.getContext('2d')
      const side = Math.min(img.width, img.height)
      const sx = (img.width  - side) / 2
      const sy = (img.height - side) / 2
      ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size)
      let out = canvas.toDataURL('image/webp', quality)
      if (!out.startsWith('data:image/webp')) out = canvas.toDataURL('image/jpeg', quality)
      resolve(out)
    }
    img.onerror = () => { clearTimeout(timeout); reject(new Error('Image load failed')) }
    img.src = dataUrl
  })
}

export async function compressImage (file, size = DEFAULT_SIZE_PX, quality = DEFAULT_QUALITY) {
  const dataUrl = await readFileAsDataUrl(file)
  if (file.type === 'image/gif' || file.type === 'image/webp') return dataUrl
  return downscaleDataUrl(dataUrl, size, quality)
}
