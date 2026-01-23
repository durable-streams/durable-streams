const COOKIE_NAME = `boxes_team`

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
 * Parse and verify team cookie from cookie header.
 * Returns teamId (0-3) or null if invalid/missing.
 */
export async function parseTeamCookie(
  cookieHeader: string | null | undefined,
  secret: string
): Promise<number | null> {
  if (!cookieHeader) return null

  // Find our cookie
  const cookies = cookieHeader.split(`;`).map((c) => c.trim())
  const ourCookie = cookies.find((c) => c.startsWith(`${COOKIE_NAME}=`))

  if (!ourCookie) return null

  const value = ourCookie.slice(COOKIE_NAME.length + 1)
  const [teamIdStr, sig] = value.split(`.`)

  if (!teamIdStr || !sig) return null

  const teamId = parseInt(teamIdStr, 10)
  if (isNaN(teamId) || teamId < 0 || teamId > 3) return null

  const valid = await verify(teamIdStr, sig, secret)
  if (!valid) return null

  return teamId
}

/**
 * Create signed team cookie value in format: teamId.signature
 */
export async function createTeamCookie(
  teamId: number,
  secret: string
): Promise<string> {
  const sig = await sign(String(teamId), secret)
  return `${teamId}.${sig}`
}

/**
 * Build Set-Cookie header with appropriate security attributes.
 */
export function buildSetCookieHeader(
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
