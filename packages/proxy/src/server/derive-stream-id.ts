/**
 * Deterministic stream ID derivation from session IDs.
 *
 * Uses UUIDv5 (SHA-1 based, RFC 4122) to derive a stream ID from a session ID.
 * The derivation is stateless and reproducible — the same session ID always
 * yields the same stream ID.
 */

import { createHash } from "node:crypto"

/**
 * Fixed namespace UUID for deriving stream IDs from session IDs.
 *
 * This is a project-specific namespace (generated once, never changes).
 * Format: UUID bytes as a 16-byte buffer.
 */
const NAMESPACE = uuidToBytes(`d4a1c8e2-9f3b-4a7d-b6e5-1c2d3e4f5a6b`)

/**
 * Convert a UUID string to a 16-byte Buffer.
 */
function uuidToBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ``), `hex`)
}

/**
 * Derive a deterministic stream ID from a session ID using UUIDv5.
 *
 * UUIDv5 = SHA-1(namespace + name), then set version/variant bits per RFC 4122.
 *
 * @param sessionId - The session identifier
 * @returns A UUID string derived deterministically from the session ID
 */
export function deriveStreamId(sessionId: string): string {
  const hash = createHash(`sha1`).update(NAMESPACE).update(sessionId).digest()

  // Set version 5 (bits 4-7 of byte 6)
  hash[6] = (hash[6]! & 0x0f) | 0x50
  // Set variant (bits 6-7 of byte 8)
  hash[8] = (hash[8]! & 0x3f) | 0x80

  // Format as UUID string (use first 16 bytes of SHA-1's 20-byte output)
  const hex = hash.subarray(0, 16).toString(`hex`)
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join(`-`)
}
