const MAX_CHAT_ID_LENGTH = 128

/** Parse an untrusted chat id before it is used to construct a stream path. */
export function parseChatId(value: unknown): string | null {
  if (typeof value !== `string` || value !== value.trim()) return null
  if (value.length === 0 || value.length > MAX_CHAT_ID_LENGTH) return null
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : null
}
