/**
 * Authentication utilities for the proxy server.
 *
 * Implements pre-signed URLs and service JWT validation per the spec.
 */

import { createHmac, timingSafeEqual } from "node:crypto"

/**
 * Base64url encode a buffer.
 */
function base64urlEncode(input: Buffer): string {
  return input
    .toString(`base64`)
    .replace(/\+/g, `-`)
    .replace(/\//g, `_`)
    .replace(/=/g, ``)
}

/**
 * Parsed components of a pre-signed URL.
 */
export interface ParsedPreSignedUrl {
  /** The stream ID from the URL path */
  streamId: string
  /** The expires query parameter (Unix timestamp in seconds) */
  expires: string
  /** The signature query parameter */
  signature: string
}

/**
 * Parse a pre-signed URL into its components.
 *
 * Expected URL format: {origin}/v1/proxy/{streamId}?expires={timestamp}&signature={sig}
 *
 * @param url - The pre-signed URL to parse (can be a full URL or header value)
 * @returns Parsed URL components or null if the URL is malformed
 */
export function parsePreSignedUrl(url: string): ParsedPreSignedUrl | null {
  try {
    const parsed = new URL(url)

    // Extract streamId from path: /v1/proxy/{streamId}
    const pathMatch = parsed.pathname.match(/^\/v1\/proxy\/([^/]+)$/)
    if (!pathMatch) {
      return null
    }

    const streamId = decodeURIComponent(pathMatch[1]!)
    const expires = parsed.searchParams.get(`expires`)
    const signature = parsed.searchParams.get(`signature`)

    if (!streamId || !expires || !signature) {
      return null
    }

    return { streamId, expires, signature }
  } catch {
    return null
  }
}

/**
 * Result of HMAC validation only (ignoring expiry).
 */
export type HmacResult = { ok: true } | { ok: false; code: `SIGNATURE_INVALID` }

/**
 * Validate HMAC signature of a pre-signed URL (ignoring expiry).
 *
 * Use this for write paths where authorization flows through the upstream
 * and we only need to verify the client received this URL from the proxy.
 *
 * @param streamId - The stream ID from the URL path
 * @param expires - The expires query parameter (Unix timestamp in seconds)
 * @param signature - The signature query parameter
 * @param secret - The HMAC secret key
 * @returns Validation result
 */
export function validateHmac(
  streamId: string,
  expires: string,
  signature: string,
  secret: string
): HmacResult {
  // Compute expected signature
  const expectedSignature = base64urlEncode(
    createHmac(`sha256`, secret).update(`${streamId}:${expires}`).digest()
  )

  // Timing-safe comparison
  const providedBuffer = Buffer.from(signature)
  const expectedBuffer = Buffer.from(expectedSignature)

  if (providedBuffer.length !== expectedBuffer.length) {
    return { ok: false, code: `SIGNATURE_INVALID` }
  }

  if (!timingSafeEqual(providedBuffer, expectedBuffer)) {
    return { ok: false, code: `SIGNATURE_INVALID` }
  }

  return { ok: true }
}

/**
 * Generate a pre-signed URL for accessing a stream.
 *
 * The signature is computed as: base64url(HMAC-SHA256(secret, `${streamId}:${expiresAt}`))
 *
 * @param origin - The origin URL (e.g., "http://localhost:4440")
 * @param streamId - The stream ID
 * @param secret - The HMAC secret key
 * @param expiresAt - Unix timestamp in seconds when the URL expires
 * @returns The pre-signed URL
 */
export function generatePreSignedUrl(
  origin: string,
  streamId: string,
  secret: string,
  expiresAt: number
): string {
  const signature = base64urlEncode(
    createHmac(`sha256`, secret).update(`${streamId}:${expiresAt}`).digest()
  )

  return `${origin}/v1/proxy/${encodeURIComponent(streamId)}?expires=${expiresAt}&signature=${signature}`
}

/**
 * Result of pre-signed URL validation.
 */
export type PreSignedUrlResult =
  | { ok: true }
  | { ok: false; code: `SIGNATURE_EXPIRED` | `SIGNATURE_INVALID` }

/**
 * Validate pre-signed URL parameters (HMAC + expiry).
 *
 * Use this for read paths where the signed URL is the sole authorization.
 *
 * @param streamId - The stream ID from the URL path
 * @param expires - The expires query parameter (Unix timestamp in seconds)
 * @param signature - The signature query parameter
 * @param secret - The HMAC secret key
 * @returns Validation result
 */
export function validatePreSignedUrl(
  streamId: string,
  expires: string,
  signature: string,
  secret: string
): PreSignedUrlResult {
  // Check expiration first
  const expiresAt = parseInt(expires, 10)
  if (isNaN(expiresAt) || Date.now() > expiresAt * 1000) {
    return { ok: false, code: `SIGNATURE_EXPIRED` }
  }

  // Delegate HMAC validation
  const hmacResult = validateHmac(streamId, expires, signature, secret)
  if (!hmacResult.ok) {
    return hmacResult
  }

  return { ok: true }
}

/**
 * Result of service JWT validation.
 */
export type ServiceJwtResult =
  | { ok: true }
  | { ok: false; code: `MISSING_SECRET` | `INVALID_SECRET` }

/**
 * Validate service JWT from query parameter or Authorization header.
 *
 * The JWT is a simple secret comparison (not a full JWT parse).
 *
 * @param secretParam - The secret query parameter value
 * @param authHeader - The Authorization header value
 * @param expectedSecret - The expected secret value
 * @returns Validation result
 */
export function validateServiceJwt(
  secretParam: string | null,
  authHeader: string | undefined,
  expectedSecret: string
): ServiceJwtResult {
  // Try secret param first
  let token = secretParam

  // Fall back to Authorization header
  if (!token && authHeader) {
    const match = authHeader.match(/^Bearer\s+(.+)$/i)
    if (match) {
      token = match[1]!
    }
  }

  if (!token) {
    return { ok: false, code: `MISSING_SECRET` }
  }

  // Compare with expected secret
  // Use timing-safe comparison to prevent timing attacks
  const providedBuffer = Buffer.from(token)
  const expectedBuffer = Buffer.from(expectedSecret)

  if (providedBuffer.length !== expectedBuffer.length) {
    return { ok: false, code: `INVALID_SECRET` }
  }

  if (!timingSafeEqual(providedBuffer, expectedBuffer)) {
    return { ok: false, code: `INVALID_SECRET` }
  }

  return { ok: true }
}

/**
 * Extract bearer token from Authorization header.
 *
 * @param authHeader - The Authorization header value
 * @returns The token if present and properly formatted, null otherwise
 */
export function extractBearerToken(
  authHeader: string | undefined
): string | null {
  if (!authHeader) {
    return null
  }

  const match = authHeader.match(/^Bearer\s+(.+)$/i)
  return match ? match[1]! : null
}
