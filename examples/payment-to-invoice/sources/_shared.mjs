// What the sources that send no signature share.
import crypto from 'node:crypto'

// A constant-time comparison of two secrets of any length.
export function sameSecret(a, b) {
  const x = crypto.createHash('sha256').update(String(a ?? '')).digest()
  const y = crypto.createHash('sha256').update(String(b ?? '')).digest()
  return Boolean(a) && Boolean(b) && crypto.timingSafeEqual(x, y)
}

// A form-encoded body as a plain object. `data[sum]=269` is read as `sum`.
export function formFields(rawBody) {
  const out = {}
  for (const [k, v] of new URLSearchParams(rawBody)) out[k.replace(/^data\[(\w+)\]$/, '$1')] = v
  return out
}
