import { describe, expect, it } from "vitest"
import {
  normalizeBaseUrl,
  validateAuth,
  validateStreamId,
  validateUrl,
} from "../src/validation"

describe(`normalizeBaseUrl`, () => {
  it(`removes trailing slash`, () => {
    expect(normalizeBaseUrl(`http://localhost:4437/`)).toBe(
      `http://localhost:4437`
    )
  })

  it(`removes multiple trailing slashes`, () => {
    expect(normalizeBaseUrl(`http://localhost:4437///`)).toBe(
      `http://localhost:4437`
    )
  })

  it(`leaves URL without trailing slash unchanged`, () => {
    expect(normalizeBaseUrl(`http://localhost:4437`)).toBe(
      `http://localhost:4437`
    )
  })

  it(`preserves path without trailing slash`, () => {
    expect(normalizeBaseUrl(`http://localhost:4437/api`)).toBe(
      `http://localhost:4437/api`
    )
  })

  it(`removes trailing slash from path`, () => {
    expect(normalizeBaseUrl(`http://localhost:4437/api/`)).toBe(
      `http://localhost:4437/api`
    )
  })
})

describe(`validateUrl`, () => {
  it(`returns valid for http URL`, () => {
    const result = validateUrl(`http://localhost:4437`)
    expect(result.valid).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it(`returns valid for https URL`, () => {
    const result = validateUrl(`https://api.example.com`)
    expect(result.valid).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it(`returns valid for URL with path`, () => {
    const result = validateUrl(`http://localhost:4437/v1/stream`)
    expect(result.valid).toBe(true)
  })

  it(`returns error for empty string`, () => {
    const result = validateUrl(``)
    expect(result.valid).toBe(false)
    expect(result.error).toContain(`cannot be empty`)
  })

  it(`returns error for whitespace only`, () => {
    const result = validateUrl(`   `)
    expect(result.valid).toBe(false)
    expect(result.error).toContain(`cannot be empty`)
  })

  it(`returns error for invalid URL format`, () => {
    const result = validateUrl(`not-a-url`)
    expect(result.valid).toBe(false)
    expect(result.error).toContain(`Invalid URL format`)
    expect(result.error).toContain(`not-a-url`)
  })

  it(`returns error for non-http/https protocol`, () => {
    const result = validateUrl(`ftp://files.example.com`)
    expect(result.valid).toBe(false)
    expect(result.error).toContain(`Invalid URL protocol`)
    expect(result.error).toContain(`ftp:`)
  })

  it(`returns error for file protocol`, () => {
    const result = validateUrl(`file:///etc/passwd`)
    expect(result.valid).toBe(false)
    expect(result.error).toContain(`Invalid URL protocol`)
  })
})

describe(`validateAuth`, () => {
  it(`returns valid for Bearer token`, () => {
    const result = validateAuth(`Bearer my-token-123`)
    expect(result.valid).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it(`returns valid for Basic auth`, () => {
    const result = validateAuth(`Basic dXNlcjpwYXNz`)
    expect(result.valid).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it(`returns valid for ApiKey`, () => {
    const result = validateAuth(`ApiKey abc123`)
    expect(result.valid).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it(`returns valid for Token scheme`, () => {
    const result = validateAuth(`Token xyz789`)
    expect(result.valid).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it(`is case-insensitive for schemes`, () => {
    const result = validateAuth(`BEARER my-token`)
    expect(result.valid).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it(`returns error for empty string`, () => {
    const result = validateAuth(``)
    expect(result.valid).toBe(false)
    expect(result.error).toContain(`cannot be empty`)
  })

  it(`returns error for whitespace only`, () => {
    const result = validateAuth(`   `)
    expect(result.valid).toBe(false)
    expect(result.error).toContain(`cannot be empty`)
  })

  it(`returns warning for raw token without scheme`, () => {
    const result = validateAuth(`rawtoken123`)
    expect(result.valid).toBe(true)
    expect(result.error).toBeUndefined()
    expect(result.warning).toContain(`Warning`)
    expect(result.warning).toContain(`doesn't match common formats`)
  })

  it(`returns valid without warning for unknown scheme with space`, () => {
    const result = validateAuth(`CustomScheme value`)
    expect(result.valid).toBe(true)
    expect(result.error).toBeUndefined()
    expect(result.warning).toBeUndefined()
  })
})

describe(`validateStreamId`, () => {
  it(`returns valid for simple alphanumeric ID`, () => {
    const result = validateStreamId(`my-stream-123`)
    expect(result.valid).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it(`returns valid for ID with underscores`, () => {
    const result = validateStreamId(`my_stream_id`)
    expect(result.valid).toBe(true)
  })

  it(`returns valid for ID with dots`, () => {
    const result = validateStreamId(`com.example.stream`)
    expect(result.valid).toBe(true)
  })

  it(`returns valid for ID with colons`, () => {
    const result = validateStreamId(`namespace:stream:v1`)
    expect(result.valid).toBe(true)
  })

  it(`returns valid for mixed valid characters`, () => {
    const result = validateStreamId(`user_123.events:v2-beta`)
    expect(result.valid).toBe(true)
  })

  it(`returns error for empty string`, () => {
    const result = validateStreamId(``)
    expect(result.valid).toBe(false)
    expect(result.error).toContain(`cannot be empty`)
  })

  it(`returns error for whitespace only`, () => {
    const result = validateStreamId(`   `)
    expect(result.valid).toBe(false)
    expect(result.error).toContain(`cannot be empty`)
  })

  it(`returns error for ID with spaces`, () => {
    const result = validateStreamId(`stream with spaces`)
    expect(result.valid).toBe(false)
    expect(result.error).toContain(`Invalid stream ID`)
  })

  it(`returns error for ID with slashes`, () => {
    const result = validateStreamId(`path/to/stream`)
    expect(result.valid).toBe(false)
    expect(result.error).toContain(`Invalid stream ID`)
  })

  it(`returns error for ID with special characters`, () => {
    const result = validateStreamId(`stream@example!`)
    expect(result.valid).toBe(false)
    expect(result.error).toContain(`Invalid stream ID`)
  })

  it(`returns error for ID over 256 characters`, () => {
    const longId = `a`.repeat(257)
    const result = validateStreamId(longId)
    expect(result.valid).toBe(false)
    expect(result.error).toContain(`too long`)
    expect(result.error).toContain(`257`)
  })

  it(`returns valid for ID exactly 256 characters`, () => {
    const maxId = `a`.repeat(256)
    const result = validateStreamId(maxId)
    expect(result.valid).toBe(true)
  })
})
