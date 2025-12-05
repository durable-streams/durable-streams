/**
 * Path encoding utilities for converting stream paths to filesystem-safe directory names.
 */

import { createHash } from "node:crypto"

const MAX_ENCODED_LENGTH = 200

/**
 * Encode a stream path to a filesystem-safe directory name using base64url encoding.
 * Long paths (>200 chars) are hashed to keep directory names manageable.
 *
 * @example
 * encodeStreamPath("/stream/users:created") → "L3N0cmVhbS91c2VyczpjcmVhdGVk"
 */
export function encodeStreamPath(path: string): string {
  // Base64url encoding (RFC 4648 §5)
  // Replace + with - and / with _, remove padding =
  const base64 = Buffer.from(path, `utf-8`)
    .toString(`base64`)
    .replace(/\+/g, `-`)
    .replace(/\//g, `_`)
    .replace(/=/g, ``)

  // Hash long paths to keep directory names manageable
  if (base64.length > MAX_ENCODED_LENGTH) {
    const hash = createHash(`sha256`).update(path).digest(`hex`).slice(0, 16)
    // Use ~ as separator since it cannot appear in base64url output
    return `${base64.slice(0, 180)}~${hash}`
  }

  return base64
}

/**
 * Decode a filesystem-safe directory name back to the original stream path.
 *
 * @example
 * decodeStreamPath("L3N0cmVhbS91c2VyczpjcmVhdGVk") → "/stream/users:created"
 */
export function decodeStreamPath(encoded: string): string {
  // Remove hash suffix if present (hash is always 16 chars after ~ separator)
  // Use ~ as separator since it cannot appear in base64url output
  let base = encoded
  const tildeIndex = encoded.lastIndexOf(`~`)
  if (tildeIndex !== -1) {
    const possibleHash = encoded.slice(tildeIndex + 1)
    // Verify it's a 16-char hex hash before removing it
    if (possibleHash.length === 16 && /^[0-9a-f]+$/.test(possibleHash)) {
      base = encoded.slice(0, tildeIndex)
    }
  }

  // Restore base64 from base64url
  const normalized = base.replace(/-/g, `+`).replace(/_/g, `/`)

  // Add padding back
  const padded = normalized + `=`.repeat((4 - (normalized.length % 4)) % 4)

  return Buffer.from(padded, `base64`).toString(`utf-8`)
}
