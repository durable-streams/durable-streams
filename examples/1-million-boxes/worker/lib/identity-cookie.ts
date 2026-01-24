const COOKIE_NAME = `boxes_identity`

export interface Identity {
  playerId: string
  teamId: number
}

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
 * Generate a random team ID (0-3).
 */
export function generateTeamId(): number {
  return Math.floor(Math.random() * 4)
}

/**
 * Parse and verify identity cookie from cookie header.
 * Returns { playerId, teamId } or null if invalid/missing.
 *
 * Cookie format: playerId.teamId.signature
 */
export async function parseIdentityCookie(
  cookieHeader: string | null | undefined,
  secret: string
): Promise<Identity | null> {
  if (!cookieHeader) return null

  // Find our cookie
  const cookies = cookieHeader.split(`;`).map((c) => c.trim())
  const ourCookie = cookies.find((c) => c.startsWith(`${COOKIE_NAME}=`))

  if (!ourCookie) return null

  const value = ourCookie.slice(COOKIE_NAME.length + 1)

  // Format: playerId.teamId.signature
  // playerId is UUID (36 chars with dashes)
  // teamId is 0-3 (1 char)
  // signature is 32 chars
  const parts = value.split(`.`)

  if (parts.length !== 3) return null

  const [playerId, teamIdStr, sig] = parts

  // Validate UUID format
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      playerId
    )
  ) {
    return null
  }

  // Validate teamId
  const teamId = parseInt(teamIdStr, 10)
  if (isNaN(teamId) || teamId < 0 || teamId > 3) return null

  // Verify signature covers both playerId and teamId
  const dataToSign = `${playerId}.${teamId}`
  const valid = await verify(dataToSign, sig, secret)
  if (!valid) return null

  return { playerId, teamId }
}

/**
 * Create signed identity cookie value.
 * Format: playerId.teamId.signature
 */
export async function createIdentityCookie(
  playerId: string,
  teamId: number,
  secret: string
): Promise<string> {
  const dataToSign = `${playerId}.${teamId}`
  const sig = await sign(dataToSign, secret)
  return `${playerId}.${teamId}.${sig}`
}

/**
 * Build Set-Cookie header with appropriate security attributes.
 */
export function buildIdentityCookieHeader(
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
