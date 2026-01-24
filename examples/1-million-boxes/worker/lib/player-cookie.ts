const COOKIE_NAME = `boxes_player`

/**
 * Create HMAC signature using Web Crypto API.
 * Returns hex string truncated to 32 characters.
 */
async function sign(data: string, secret: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    `raw`,
    encoder.encode(secret),
    { name: `HMAC`, hash: `SHA-256` },
    false,
    [`sign`]
  )

  const signature = await crypto.subtle.sign(`HMAC`, key, encoder.encode(data))
  const hex = Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, `0`))
    .join(``)

  return hex.slice(0, 32) // Truncate to 32 chars
}

/**
 * Verify HMAC signature with timing-safe comparison.
 */
async function verify(
  data: string,
  signature: string,
  secret: string
): Promise<boolean> {
  const expected = await sign(data, secret)

  if (signature.length !== expected.length) return false

  // Timing-safe comparison
  let result = 0
  for (let i = 0; i < signature.length; i++) {
    result |= signature.charCodeAt(i) ^ expected.charCodeAt(i)
  }

  return result === 0
}

/**
 * Generate a unique player ID using crypto.randomUUID().
 */
export function generatePlayerId(): string {
  return crypto.randomUUID()
}

/**
 * Parse and verify player cookie from cookie header.
 * Returns playerId or null if invalid/missing.
 */
export async function parsePlayerCookie(
  cookieHeader: string | null | undefined,
  secret: string
): Promise<string | null> {
  if (!cookieHeader) return null

  // Find our cookie
  const cookies = cookieHeader.split(`;`).map((c) => c.trim())
  const ourCookie = cookies.find((c) => c.startsWith(`${COOKIE_NAME}=`))

  if (!ourCookie) return null

  const value = ourCookie.slice(COOKIE_NAME.length + 1)
  const lastDotIndex = value.lastIndexOf(`.`)

  if (lastDotIndex === -1) return null

  const playerId = value.slice(0, lastDotIndex)
  const sig = value.slice(lastDotIndex + 1)

  if (!playerId || !sig) return null

  // Validate UUID format (basic check)
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      playerId
    )
  ) {
    return null
  }

  const valid = await verify(playerId, sig, secret)
  if (!valid) return null

  return playerId
}

/**
 * Create signed player cookie value in format: playerId.signature
 */
export async function createPlayerCookie(
  playerId: string,
  secret: string
): Promise<string> {
  const sig = await sign(playerId, secret)
  return `${playerId}.${sig}`
}

/**
 * Build Set-Cookie header with appropriate security attributes.
 */
export function buildPlayerCookieHeader(
  cookieValue: string,
  isProduction: boolean
): string {
  const parts = [
    `${COOKIE_NAME}=${cookieValue}`,
    `Path=/`,
    `HttpOnly`,
    `SameSite=Lax`,
    `Max-Age=31536000`, // 1 year
  ]

  if (isProduction) {
    parts.push(`Secure`)
  }

  return parts.join(`; `)
}
