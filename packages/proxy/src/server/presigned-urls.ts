/**
 * Pre-signed URL utilities for proxy stream access.
 *
 * Pre-signed URLs provide capability-based access to streams without requiring
 * Bearer tokens. The URL itself is the authorization credential.
 *
 * Format: /v1/proxy/{service}/{stream_id}?expires={timestamp}&signature={hmac}
 *
 * The signature is an HMAC-SHA256 of "{service}/{stream_id}:{expires}" using
 * the server's secret key.
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
 * Generate a signature for a pre-signed URL.
 *
 * @param serviceId - The service identifier
 * @param streamId - The stream identifier
 * @param expiresAt - Unix timestamp (seconds) when the URL expires
 * @param secret - The secret key for HMAC signing
 * @returns The base64url-encoded signature
 */
export function generateSignature(
  serviceId: string,
  streamId: string,
  expiresAt: number,
  secret: string
): string {
  const payload = `${serviceId}/${streamId}:${expiresAt}`
  const hmac = createHmac(`sha256`, secret)
  hmac.update(payload)
  return base64urlEncode(hmac.digest())
}

/**
 * Generate a pre-signed URL for stream access.
 *
 * @param basePath - Base path (e.g., "/v1/proxy/my-service/stream-id")
 * @param serviceId - The service identifier
 * @param streamId - The stream identifier
 * @param secret - The secret key for HMAC signing
 * @param ttlSeconds - Time-to-live in seconds (default: 86400 = 24h)
 * @returns The complete path with query parameters
 *
 * @example
 * ```typescript
 * const path = generatePresignedPath(
 *   "/v1/proxy/chat/019449a1-7b2c-7def-8123-456789abcdef",
 *   "chat",
 *   "019449a1-7b2c-7def-8123-456789abcdef",
 *   "my-secret",
 *   86400
 * )
 * // "/v1/proxy/chat/019449a1-7b2c-7def-8123-456789abcdef?expires=1737936000&signature=abc123..."
 * ```
 */
export function generatePresignedPath(
  basePath: string,
  serviceId: string,
  streamId: string,
  secret: string,
  ttlSeconds: number = 86400
): string {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds
  const signature = generateSignature(serviceId, streamId, expiresAt, secret)

  return `${basePath}?expires=${expiresAt}&signature=${signature}`
}

/**
 * Result of pre-signed URL validation.
 */
export type PresignedUrlResult =
  | { ok: true; serviceId: string; streamId: string }
  | { ok: false; status: number; code: string; message: string }

/**
 * Validate a pre-signed URL's signature and expiration.
 *
 * @param url - The URL object to validate
 * @param serviceId - The service ID from the URL path
 * @param streamId - The stream ID from the URL path
 * @param secret - The secret key for HMAC verification
 * @returns Validation result
 *
 * @example
 * ```typescript
 * const result = validatePresignedUrl(url, "chat", "stream-123", "secret")
 * if (result.ok) {
 *   // Access granted
 * } else {
 *   // Access denied: result.code, result.message
 * }
 * ```
 */
export function validatePresignedUrl(
  url: URL,
  serviceId: string,
  streamId: string,
  secret: string
): PresignedUrlResult {
  const expires = url.searchParams.get(`expires`)
  const signature = url.searchParams.get(`signature`)

  // Check required parameters
  if (!expires) {
    return {
      ok: false,
      status: 401,
      code: `MISSING_EXPIRES`,
      message: `Pre-signed URL missing expires parameter`,
    }
  }

  if (!signature) {
    return {
      ok: false,
      status: 401,
      code: `MISSING_SIGNATURE`,
      message: `Pre-signed URL missing signature parameter`,
    }
  }

  // Parse and validate expiration
  const expiresAt = parseInt(expires, 10)
  if (isNaN(expiresAt)) {
    return {
      ok: false,
      status: 401,
      code: `INVALID_EXPIRES`,
      message: `Pre-signed URL expires parameter is not a valid timestamp`,
    }
  }

  const now = Math.floor(Date.now() / 1000)
  if (expiresAt < now) {
    return {
      ok: false,
      status: 401,
      code: `SIGNATURE_EXPIRED`,
      message: `Pre-signed URL has expired`,
    }
  }

  // Verify signature
  const expectedSignature = generateSignature(
    serviceId,
    streamId,
    expiresAt,
    secret
  )

  // Timing-safe comparison to prevent timing attacks
  const providedBuffer = Buffer.from(signature)
  const expectedBuffer = Buffer.from(expectedSignature)

  if (providedBuffer.length !== expectedBuffer.length) {
    return {
      ok: false,
      status: 401,
      code: `SIGNATURE_INVALID`,
      message: `Pre-signed URL signature is invalid`,
    }
  }

  if (!timingSafeEqual(providedBuffer, expectedBuffer)) {
    return {
      ok: false,
      status: 401,
      code: `SIGNATURE_INVALID`,
      message: `Pre-signed URL signature is invalid`,
    }
  }

  return { ok: true, serviceId, streamId }
}
