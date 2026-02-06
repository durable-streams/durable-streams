/**
 * Cryptographic utilities for webhook signatures and callback tokens.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

/**
 * Generate a webhook secret for a subscription.
 */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString(`hex`)}`
}

/**
 * Generate a unique wake ID.
 */
export function generateWakeId(): string {
  return `w_${randomBytes(12).toString(`hex`)}`
}

/**
 * Sign a webhook payload for the Webhook-Signature header.
 * Format: t=<timestamp>,sha256=<hex_signature>
 */
export function signWebhookPayload(body: string, secret: string): string {
  const timestamp = Math.floor(Date.now() / 1000)
  const payload = `${timestamp}.${body}`
  const signature = createHmac(`sha256`, secret).update(payload).digest(`hex`)
  return `t=${timestamp},sha256=${signature}`
}

/**
 * Verify a webhook signature.
 */
export function verifyWebhookSignature(
  body: string,
  signatureHeader: string,
  secret: string,
  toleranceSeconds = 300
): boolean {
  const match = signatureHeader.match(/t=(\d+),sha256=([a-f0-9]+)/)
  if (!match) return false

  const [, timestamp, signature] = match
  const ts = parseInt(timestamp!, 10)

  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - ts) > toleranceSeconds) return false

  const payload = `${timestamp}.${body}`
  const expected = createHmac(`sha256`, secret).update(payload).digest(`hex`)

  try {
    return timingSafeEqual(Buffer.from(signature!), Buffer.from(expected))
  } catch {
    return false
  }
}

// Token signing key — generated per server instance
const TOKEN_KEY = randomBytes(32)

/**
 * Generate a signed callback token.
 * Token format: base64url(json_payload).base64url(hmac_signature)
 * Payload: { consumer_id, epoch, exp }
 */
export function generateCallbackToken(
  consumerId: string,
  epoch: number
): string {
  const payload = {
    sub: consumerId,
    epoch,
    exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour TTL
    jti: randomBytes(8).toString(`hex`),
  }
  const payloadStr = Buffer.from(JSON.stringify(payload)).toString(`base64url`)
  const sig = createHmac(`sha256`, TOKEN_KEY)
    .update(payloadStr)
    .digest(`base64url`)
  return `${payloadStr}.${sig}`
}

/**
 * Validate a callback token. Returns the decoded payload or null.
 */
export function validateCallbackToken(
  token: string,
  consumerId: string
): { valid: true } | { valid: false; code: `TOKEN_INVALID` | `TOKEN_EXPIRED` } {
  const parts = token.split(`.`)
  if (parts.length !== 2) {
    return { valid: false, code: `TOKEN_INVALID` }
  }

  const [payloadStr, sig] = parts

  const expectedSig = createHmac(`sha256`, TOKEN_KEY)
    .update(payloadStr!)
    .digest(`base64url`)

  try {
    if (!timingSafeEqual(Buffer.from(sig!), Buffer.from(expectedSig))) {
      return { valid: false, code: `TOKEN_INVALID` }
    }
  } catch {
    return { valid: false, code: `TOKEN_INVALID` }
  }

  let payload: { sub: string; epoch: number; exp: number }
  try {
    payload = JSON.parse(Buffer.from(payloadStr!, `base64url`).toString())
  } catch {
    return { valid: false, code: `TOKEN_INVALID` }
  }

  if (payload.sub !== consumerId) {
    return { valid: false, code: `TOKEN_INVALID` }
  }

  const now = Math.floor(Date.now() / 1000)
  if (now > payload.exp) {
    return { valid: false, code: `TOKEN_EXPIRED` }
  }

  return { valid: true }
}
