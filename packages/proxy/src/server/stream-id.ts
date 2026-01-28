/**
 * UUIDv7 stream ID generation.
 *
 * Generates time-ordered, k-sortable unique identifiers for proxy streams.
 * Format: xxxxxxxx-xxxx-7xxx-yxxx-xxxxxxxxxxxx
 *
 * The first 48 bits encode milliseconds since Unix epoch (sortable).
 * The remaining bits are random for uniqueness.
 */

import { randomBytes } from "node:crypto"

/**
 * Generate a UUIDv7-like stream ID.
 *
 * @returns A time-ordered unique identifier in UUID format
 *
 * @example
 * ```typescript
 * const streamId = generateStreamId()
 * // "019449a1-7b2c-7def-8123-456789abcdef"
 * ```
 */
export function generateStreamId(): string {
  const timestamp = Date.now()

  // Get 10 random bytes for the random portion
  const random = randomBytes(10)

  // Build the UUID bytes (16 total)
  const bytes = new Uint8Array(16)

  // First 6 bytes: timestamp (48 bits, big-endian)
  bytes[0] = (timestamp / 0x10000000000) & 0xff
  bytes[1] = (timestamp / 0x100000000) & 0xff
  bytes[2] = (timestamp / 0x1000000) & 0xff
  bytes[3] = (timestamp / 0x10000) & 0xff
  bytes[4] = (timestamp / 0x100) & 0xff
  bytes[5] = timestamp & 0xff

  // Bytes 6-7: version (7) + random
  bytes[6] = 0x70 | (random[0]! & 0x0f) // Version 7
  bytes[7] = random[1]!

  // Bytes 8-9: variant (10xx) + random
  bytes[8] = 0x80 | (random[2]! & 0x3f) // Variant 10xx
  bytes[9] = random[3]!

  // Bytes 10-15: random
  bytes[10] = random[4]!
  bytes[11] = random[5]!
  bytes[12] = random[6]!
  bytes[13] = random[7]!
  bytes[14] = random[8]!
  bytes[15] = random[9]!

  // Format as UUID string
  return formatUuid(bytes)
}

/**
 * Format bytes as a UUID string.
 */
function formatUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, `0`))
    .join(``)

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * Validate a stream ID format.
 *
 * @param streamId - The string to validate
 * @returns true if the string is a valid UUID format
 */
export function isValidStreamId(streamId: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    streamId
  )
}
