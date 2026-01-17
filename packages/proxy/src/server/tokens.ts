/**
 * JWT token utilities for proxy read tokens.
 *
 * Read tokens are short-lived JWTs that grant access to read a specific stream.
 * They're issued when a stream is created and validated on read requests.
 */

import { createHmac, timingSafeEqual } from "node:crypto"
import type { ReadTokenPayload } from "./types"

const TOKEN_VERSION = 1
const ALGORITHM = `HS256`

/**
 * Base64url encode a buffer or string.
 */
function base64urlEncode(input: Buffer | string): string {
  const buffer = typeof input === `string` ? Buffer.from(input) : input
  return buffer
    .toString(`base64`)
    .replace(/\+/g, `-`)
    .replace(/\//g, `_`)
    .replace(/=/g, ``)
}

/**
 * Base64url decode to a buffer.
 */
function base64urlDecode(input: string): Buffer {
  // Add back padding
  const padded = input + `===`.slice((input.length + 3) % 4)
  const base64 = padded.replace(/-/g, `+`).replace(/_/g, `/`)
  return Buffer.from(base64, `base64`)
}

/**
 * Create a signature for the given header and payload.
 */
function createSignature(
  header: string,
  payload: string,
  secret: string
): string {
  const data = `${header}.${payload}`
  const hmac = createHmac(`sha256`, secret)
  hmac.update(data)
  return base64urlEncode(hmac.digest())
}

/**
 * Generate a read token for a stream.
 *
 * @param path - The stream path to grant access to
 * @param secret - The JWT secret key
 * @param ttlSeconds - Token TTL in seconds (default: 86400 = 24h)
 * @returns The signed JWT token
 */
export function generateReadToken(
  path: string,
  secret: string,
  ttlSeconds: number = 86400
): string {
  const now = Math.floor(Date.now() / 1000)

  const header = base64urlEncode(
    JSON.stringify({
      alg: ALGORITHM,
      typ: `JWT`,
      v: TOKEN_VERSION,
    })
  )

  const payload: ReadTokenPayload = {
    path,
    iat: now,
    exp: now + ttlSeconds,
  }

  const encodedPayload = base64urlEncode(JSON.stringify(payload))
  const signature = createSignature(header, encodedPayload, secret)

  return `${header}.${encodedPayload}.${signature}`
}

/**
 * Validate and decode a read token.
 *
 * @param token - The JWT token to validate
 * @param secret - The JWT secret key
 * @returns The decoded payload if valid, null if invalid or expired
 */
export function validateReadToken(
  token: string,
  secret: string
): ReadTokenPayload | null {
  const parts = token.split(`.`)
  if (parts.length !== 3) {
    return null
  }

  const [header, payload, signature] = parts

  // Verify signature using timing-safe comparison
  const expectedSignature = createSignature(header!, payload!, secret)
  const providedSigBuffer = Buffer.from(signature!)
  const expectedSigBuffer = Buffer.from(expectedSignature)

  if (providedSigBuffer.length !== expectedSigBuffer.length) {
    return null
  }

  if (!timingSafeEqual(providedSigBuffer, expectedSigBuffer)) {
    return null
  }

  // Decode and validate payload
  try {
    const decoded: ReadTokenPayload = JSON.parse(
      base64urlDecode(payload!).toString(`utf-8`)
    )

    // Check expiration
    const now = Math.floor(Date.now() / 1000)
    if (decoded.exp < now) {
      return null
    }

    // Validate required fields
    if (!decoded.path || typeof decoded.iat !== `number`) {
      return null
    }

    return decoded
  } catch {
    return null
  }
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

/**
 * Result of authorization check.
 */
export type AuthResult =
  | { ok: true; streamPath: string }
  | { ok: false; status: number; code: string; message: string }

/**
 * Validate authorization for a stream request.
 * Extracts the bearer token, validates it, and verifies the path matches.
 *
 * @param authHeader - The Authorization header value
 * @param jwtSecret - The JWT secret key
 * @param serviceName - The service name from the URL path
 * @param streamKey - The stream key from the URL path
 * @returns Authorization result with stream path if successful, error details if not
 */
export function authorizeStreamRequest(
  authHeader: string | undefined,
  jwtSecret: string,
  serviceName: string,
  streamKey: string
): AuthResult {
  const token = extractBearerToken(authHeader)

  if (!token) {
    return {
      ok: false,
      status: 401,
      code: `MISSING_TOKEN`,
      message: `Authorization header with Bearer token required`,
    }
  }

  const payload = validateReadToken(token, jwtSecret)

  if (!payload) {
    return {
      ok: false,
      status: 401,
      code: `INVALID_TOKEN`,
      message: `Invalid or expired read token`,
    }
  }

  const expectedPath = `/v1/streams/${serviceName}/${streamKey}`
  if (payload.path !== expectedPath) {
    return {
      ok: false,
      status: 403,
      code: `TOKEN_PATH_MISMATCH`,
      message: `Token is not valid for this stream`,
    }
  }

  return { ok: true, streamPath: expectedPath }
}
