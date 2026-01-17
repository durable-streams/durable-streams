/**
 * Hash utilities for generating stream keys.
 */

/**
 * Generate a simple hash from a string.
 * Uses djb2-style hashing converted to base36.
 */
export function hashString(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash = hash & hash // Convert to 32bit integer
  }
  return Math.abs(hash).toString(36)
}

/**
 * Generate a stream key from messages.
 * Combines a hash of the messages with a timestamp for uniqueness.
 */
export function generateStreamKey(
  prefix: string,
  messages: Array<unknown>
): string {
  const str = JSON.stringify(messages)
  return `${prefix}-${hashString(str)}-${Date.now().toString(36)}`
}
