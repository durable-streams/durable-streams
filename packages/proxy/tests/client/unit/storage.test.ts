import { describe, expect, it } from "vitest"
import {
  MemoryStorage,
  createRequestIdStorageKey,
  extractExpiresFromUrl,
  extractStreamIdFromUrl,
  isUrlExpired,
  loadRequestIdMapping,
  saveRequestIdMapping,
} from "../../../src/client/storage"

describe(`client storage utilities`, () => {
  it(`creates request-id storage keys with and without sessionId`, () => {
    const base = createRequestIdStorageKey(`durable-streams:`, `proxy`, `req-1`)
    const session = createRequestIdStorageKey(
      `durable-streams:`,
      `proxy`,
      `req-1`,
      `session-1`
    )
    expect(base).toBe(`durable-streams:proxy::req-1`)
    expect(session).toBe(`durable-streams:proxy:session-1:req-1`)
  })

  it(`returns null for malformed JSON request-id mappings`, () => {
    const storage = new MemoryStorage()
    storage.setItem(`durable-streams:proxy::bad`, `{not-json`)
    const loaded = loadRequestIdMapping(
      storage,
      `durable-streams:`,
      `proxy`,
      `bad`
    )
    expect(loaded).toBeNull()
  })

  it(`saves and loads request-id mappings`, () => {
    const storage = new MemoryStorage()
    saveRequestIdMapping(storage, `durable-streams:`, `proxy`, `req-2`, {
      responseId: 42,
      streamUrl: `http://localhost:4440/v1/proxy/stream-2?expires=9999999999`,
    })
    const loaded = loadRequestIdMapping(
      storage,
      `durable-streams:`,
      `proxy`,
      `req-2`
    )
    expect(loaded?.responseId).toBe(42)
    expect(loaded?.streamUrl).toContain(`/stream-2`)
  })

  it(`extracts stream ID and expiry from signed URLs`, () => {
    const url = `http://localhost:4440/v1/proxy/stream%2Fabc?expires=9999999999&signature=sig`
    expect(extractStreamIdFromUrl(url)).toBe(`stream/abc`)
    expect(extractExpiresFromUrl(url)).toBe(9999999999)
  })

  it(`treats invalid or missing expires as not expired`, () => {
    expect(
      isUrlExpired({ streamUrl: `http://localhost:4440/v1/proxy/stream` })
    ).toBe(false)
    expect(
      isUrlExpired({
        streamUrl: `http://localhost:4440/v1/proxy/stream?expires=not-a-number`,
      })
    ).toBe(false)
  })

  it(`detects expired URLs`, () => {
    const expires = Math.floor(Date.now() / 1000) - 1
    expect(
      isUrlExpired({
        streamUrl: `http://localhost:4440/v1/proxy/stream?expires=${expires}`,
      })
    ).toBe(true)
  })
})
