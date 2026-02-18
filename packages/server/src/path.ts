const MAX_ENCODED_LENGTH = 200
const HASH_REGEX = /^[0-9a-f]+$/

const base64UrlEncode = (str: string): string => {
  const bytes = new TextEncoder().encode(str)
  let binary = ``
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, `-`).replace(/\//g, `_`).replace(/=/g, ``)
}

const base64UrlDecode = (encoded: string): string => {
  const normalized = encoded.replace(/-/g, `+`).replace(/_/g, `/`)
  const padded = normalized + `=`.repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new TextDecoder().decode(bytes)
}

const sha256Hex = async (str: string): Promise<string> => {
  const bytes = new TextEncoder().encode(str)
  const hashBuffer = await crypto.subtle.digest(`SHA-256`, bytes)
  const hashArray = new Uint8Array(hashBuffer)
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, `0`))
    .join(``)
    .slice(0, 16)
}

export const encodeStreamPath = async (path: string): Promise<string> => {
  const base64 = base64UrlEncode(path)

  if (base64.length > MAX_ENCODED_LENGTH) {
    const hash = await sha256Hex(path)
    return `${base64.slice(0, 180)}~${hash}`
  }

  return base64
}

export const decodeStreamPath = (encoded: string): string => {
  let base = encoded
  const tildeIndex = encoded.lastIndexOf(`~`)

  if (tildeIndex !== -1) {
    const possibleHash = encoded.slice(tildeIndex + 1)
    if (possibleHash.length === 16 && HASH_REGEX.test(possibleHash)) {
      base = encoded.slice(0, tildeIndex)
    }
  }

  return base64UrlDecode(base)
}
