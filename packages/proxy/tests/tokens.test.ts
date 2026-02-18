/**
 * Unit tests for token utilities.
 */

import { describe, expect, it } from "vitest"
import {
  generatePreSignedUrl,
  parsePreSignedUrl,
  validateHmac,
  validatePreSignedUrl,
} from "../src/server/tokens"

const TEST_SECRET = `test-secret-key-for-development`
const TEST_STREAM_ID = `550e8400-e29b-41d4-a716-446655440000`
const TEST_ORIGIN = `http://localhost:4440`

describe(`parsePreSignedUrl`, () => {
  it(`parses a valid pre-signed URL`, () => {
    const url = generatePreSignedUrl(
      TEST_ORIGIN,
      TEST_STREAM_ID,
      TEST_SECRET,
      Math.floor(Date.now() / 1000) + 3600
    )

    const parsed = parsePreSignedUrl(url)

    expect(parsed).not.toBeNull()
    expect(parsed!.streamId).toBe(TEST_STREAM_ID)
    expect(parsed!.expires).toBeDefined()
    expect(parsed!.signature).toBeDefined()
  })

  it(`parses URL-encoded stream IDs`, () => {
    const streamIdWithSpecialChars = `stream/with:special?chars`
    const expiresAt = Math.floor(Date.now() / 1000) + 3600
    const url = generatePreSignedUrl(
      TEST_ORIGIN,
      streamIdWithSpecialChars,
      TEST_SECRET,
      expiresAt
    )

    const parsed = parsePreSignedUrl(url)

    expect(parsed).not.toBeNull()
    expect(parsed!.streamId).toBe(streamIdWithSpecialChars)
  })

  it(`returns null for malformed URLs`, () => {
    expect(parsePreSignedUrl(`not-a-url`)).toBeNull()
    expect(parsePreSignedUrl(``)).toBeNull()
    expect(parsePreSignedUrl(`http://example.com/wrong/path`)).toBeNull()
  })

  it(`returns null for URLs missing required query parameters`, () => {
    expect(
      parsePreSignedUrl(`${TEST_ORIGIN}/v1/proxy/${TEST_STREAM_ID}`)
    ).toBeNull()
    expect(
      parsePreSignedUrl(`${TEST_ORIGIN}/v1/proxy/${TEST_STREAM_ID}?expires=123`)
    ).toBeNull()
    expect(
      parsePreSignedUrl(
        `${TEST_ORIGIN}/v1/proxy/${TEST_STREAM_ID}?signature=abc`
      )
    ).toBeNull()
  })

  it(`returns null for URLs with wrong path format`, () => {
    expect(
      parsePreSignedUrl(
        `${TEST_ORIGIN}/v1/${TEST_STREAM_ID}?expires=123&signature=abc`
      )
    ).toBeNull()
    expect(
      parsePreSignedUrl(
        `${TEST_ORIGIN}/proxy/${TEST_STREAM_ID}?expires=123&signature=abc`
      )
    ).toBeNull()
    expect(
      parsePreSignedUrl(`${TEST_ORIGIN}/v1/proxy/?expires=123&signature=abc`)
    ).toBeNull()
  })
})

describe(`validateHmac`, () => {
  it(`returns ok for valid HMAC signature`, () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600
    const url = generatePreSignedUrl(
      TEST_ORIGIN,
      TEST_STREAM_ID,
      TEST_SECRET,
      expiresAt
    )
    const parsed = parsePreSignedUrl(url)!

    const result = validateHmac(
      parsed.streamId,
      parsed.expires,
      parsed.signature,
      TEST_SECRET
    )

    expect(result.ok).toBe(true)
  })

  it(`returns ok for valid HMAC even when URL is expired`, () => {
    // Generate a URL that expired in the past
    const expiredAt = Math.floor(Date.now() / 1000) - 3600
    const url = generatePreSignedUrl(
      TEST_ORIGIN,
      TEST_STREAM_ID,
      TEST_SECRET,
      expiredAt
    )
    const parsed = parsePreSignedUrl(url)!

    // validateHmac should still pass (ignores expiry)
    const result = validateHmac(
      parsed.streamId,
      parsed.expires,
      parsed.signature,
      TEST_SECRET
    )

    expect(result.ok).toBe(true)
  })

  it(`returns SIGNATURE_INVALID for tampered signature`, () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600
    const url = generatePreSignedUrl(
      TEST_ORIGIN,
      TEST_STREAM_ID,
      TEST_SECRET,
      expiresAt
    )
    const parsed = parsePreSignedUrl(url)!

    const result = validateHmac(
      parsed.streamId,
      parsed.expires,
      `tampered-signature`,
      TEST_SECRET
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe(`SIGNATURE_INVALID`)
    }
  })

  it(`returns SIGNATURE_INVALID for wrong secret`, () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600
    const url = generatePreSignedUrl(
      TEST_ORIGIN,
      TEST_STREAM_ID,
      TEST_SECRET,
      expiresAt
    )
    const parsed = parsePreSignedUrl(url)!

    const result = validateHmac(
      parsed.streamId,
      parsed.expires,
      parsed.signature,
      `wrong-secret`
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe(`SIGNATURE_INVALID`)
    }
  })

  it(`returns SIGNATURE_INVALID for tampered stream ID`, () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600
    const url = generatePreSignedUrl(
      TEST_ORIGIN,
      TEST_STREAM_ID,
      TEST_SECRET,
      expiresAt
    )
    const parsed = parsePreSignedUrl(url)!

    const result = validateHmac(
      `different-stream-id`,
      parsed.expires,
      parsed.signature,
      TEST_SECRET
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe(`SIGNATURE_INVALID`)
    }
  })

  it(`returns SIGNATURE_INVALID for tampered expires`, () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600
    const url = generatePreSignedUrl(
      TEST_ORIGIN,
      TEST_STREAM_ID,
      TEST_SECRET,
      expiresAt
    )
    const parsed = parsePreSignedUrl(url)!

    const result = validateHmac(
      parsed.streamId,
      `${expiresAt + 1}`, // tampered
      parsed.signature,
      TEST_SECRET
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe(`SIGNATURE_INVALID`)
    }
  })
})

describe(`validatePreSignedUrl`, () => {
  it(`returns ok for valid, non-expired URL`, () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600
    const url = generatePreSignedUrl(
      TEST_ORIGIN,
      TEST_STREAM_ID,
      TEST_SECRET,
      expiresAt
    )
    const parsed = parsePreSignedUrl(url)!

    const result = validatePreSignedUrl(
      parsed.streamId,
      parsed.expires,
      parsed.signature,
      TEST_SECRET
    )

    expect(result.ok).toBe(true)
  })

  it(`returns SIGNATURE_EXPIRED for expired URL with valid HMAC`, () => {
    const expiredAt = Math.floor(Date.now() / 1000) - 3600
    const url = generatePreSignedUrl(
      TEST_ORIGIN,
      TEST_STREAM_ID,
      TEST_SECRET,
      expiredAt
    )
    const parsed = parsePreSignedUrl(url)!

    const result = validatePreSignedUrl(
      parsed.streamId,
      parsed.expires,
      parsed.signature,
      TEST_SECRET
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe(`SIGNATURE_EXPIRED`)
    }
  })

  it(`returns SIGNATURE_INVALID for expired URL with invalid HMAC`, () => {
    const expiredAt = Math.floor(Date.now() / 1000) - 3600
    const url = generatePreSignedUrl(
      TEST_ORIGIN,
      TEST_STREAM_ID,
      TEST_SECRET,
      expiredAt
    )
    const parsed = parsePreSignedUrl(url)!

    const result = validatePreSignedUrl(
      parsed.streamId,
      parsed.expires,
      `tampered-signature`, // invalid HMAC
      TEST_SECRET
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe(`SIGNATURE_INVALID`)
    }
  })

  it(`returns SIGNATURE_INVALID for invalid expires format`, () => {
    const result = validatePreSignedUrl(
      TEST_STREAM_ID,
      `not-a-number`,
      `some-signature`,
      TEST_SECRET
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe(`SIGNATURE_INVALID`)
    }
  })

  it(`returns SIGNATURE_INVALID for tampered signature`, () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600
    const url = generatePreSignedUrl(
      TEST_ORIGIN,
      TEST_STREAM_ID,
      TEST_SECRET,
      expiresAt
    )
    const parsed = parsePreSignedUrl(url)!

    const result = validatePreSignedUrl(
      parsed.streamId,
      parsed.expires,
      `tampered-signature`,
      TEST_SECRET
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe(`SIGNATURE_INVALID`)
    }
  })

  it(`returns SIGNATURE_INVALID for wrong secret`, () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600
    const url = generatePreSignedUrl(
      TEST_ORIGIN,
      TEST_STREAM_ID,
      TEST_SECRET,
      expiresAt
    )
    const parsed = parsePreSignedUrl(url)!

    const result = validatePreSignedUrl(
      parsed.streamId,
      parsed.expires,
      parsed.signature,
      `wrong-secret`
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe(`SIGNATURE_INVALID`)
    }
  })
})
