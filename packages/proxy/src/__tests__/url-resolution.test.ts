/**
 * Unit tests for upstream URL resolution.
 *
 * Tests the URL resolution logic in the durable-fetch client to ensure
 * relative URLs are properly resolved against an origin.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import {
  createDurableFetch,
  isAbsoluteUrl,
  resolveUpstreamUrl,
} from "../client"
import { createAIStreamingResponse, createTestContext } from "./harness"

describe(`isAbsoluteUrl`, () => {
  it(`returns true for http URLs`, () => {
    expect(isAbsoluteUrl(`http://example.com`)).toBe(true)
    expect(isAbsoluteUrl(`http://example.com/path`)).toBe(true)
    expect(isAbsoluteUrl(`http://example.com:8080/path`)).toBe(true)
  })

  it(`returns true for https URLs`, () => {
    expect(isAbsoluteUrl(`https://example.com`)).toBe(true)
    expect(isAbsoluteUrl(`https://example.com/path`)).toBe(true)
    expect(isAbsoluteUrl(`https://api.example.com/v1/chat`)).toBe(true)
  })

  it(`returns false for paths starting with /`, () => {
    expect(isAbsoluteUrl(`/v1/chat`)).toBe(false)
    expect(isAbsoluteUrl(`/api/endpoint`)).toBe(false)
    expect(isAbsoluteUrl(`/`)).toBe(false)
  })

  it(`returns false for relative paths`, () => {
    expect(isAbsoluteUrl(`v1/chat`)).toBe(false)
    expect(isAbsoluteUrl(`./api/endpoint`)).toBe(false)
    expect(isAbsoluteUrl(`../api/endpoint`)).toBe(false)
  })

  it(`returns false for other protocol schemes`, () => {
    // These should not be considered "absolute" for our HTTP use case
    expect(isAbsoluteUrl(`ftp://example.com`)).toBe(false)
    expect(isAbsoluteUrl(`file:///path/to/file`)).toBe(false)
    expect(isAbsoluteUrl(`data:text/plain,hello`)).toBe(false)
  })

  it(`returns false for malformed URLs`, () => {
    expect(isAbsoluteUrl(``)).toBe(false)
    expect(isAbsoluteUrl(`not a url`)).toBe(false)
  })
})

describe(`resolveUpstreamUrl`, () => {
  describe(`with absolute URLs`, () => {
    it(`passes through http URLs unchanged`, () => {
      const url = `http://example.com/v1/chat`
      expect(resolveUpstreamUrl(url)).toBe(url)
    })

    it(`passes through https URLs unchanged`, () => {
      const url = `https://api.openai.com/v1/chat/completions`
      expect(resolveUpstreamUrl(url)).toBe(url)
    })

    it(`ignores explicit origin when URL is already absolute`, () => {
      const url = `https://api.example.com/endpoint`
      expect(resolveUpstreamUrl(url, `https://other.com`)).toBe(url)
    })
  })

  describe(`with explicit origin`, () => {
    it(`resolves root-relative paths against origin`, () => {
      expect(resolveUpstreamUrl(`/v1/chat`, `https://api.example.com`)).toBe(
        `https://api.example.com/v1/chat`
      )
    })

    it(`resolves paths without leading slash`, () => {
      expect(resolveUpstreamUrl(`v1/chat`, `https://api.example.com`)).toBe(
        `https://api.example.com/v1/chat`
      )
    })

    it(`resolves paths with query strings`, () => {
      expect(
        resolveUpstreamUrl(`/v1/chat?model=gpt-4`, `https://api.example.com`)
      ).toBe(`https://api.example.com/v1/chat?model=gpt-4`)
    })

    it(`handles origin with trailing slash`, () => {
      expect(resolveUpstreamUrl(`/v1/chat`, `https://api.example.com/`)).toBe(
        `https://api.example.com/v1/chat`
      )
    })

    it(`handles origin with path component`, () => {
      // When origin has a path, relative URLs resolve relative to it
      expect(
        resolveUpstreamUrl(`/v1/chat`, `https://api.example.com/base`)
      ).toBe(`https://api.example.com/v1/chat`)
    })

    it(`handles origin with port`, () => {
      expect(resolveUpstreamUrl(`/v1/chat`, `https://localhost:3000`)).toBe(
        `https://localhost:3000/v1/chat`
      )
    })
  })

  describe(`without origin (non-browser environment)`, () => {
    it(`throws descriptive error for relative paths`, () => {
      // In Node.js test environment, window is not defined
      expect(() => resolveUpstreamUrl(`/v1/chat`)).toThrow(
        /Cannot resolve relative upstream URL/
      )
    })

    it(`includes the URL in the error message`, () => {
      expect(() => resolveUpstreamUrl(`/api/endpoint`)).toThrow(
        /\/api\/endpoint/
      )
    })

    it(`suggests solutions in the error message`, () => {
      try {
        resolveUpstreamUrl(`/v1/chat`)
        expect.fail(`should have thrown`)
      } catch (error) {
        const message = (error as Error).message
        expect(message).toContain(`origin`)
        expect(message).toContain(`createDurableFetch`)
      }
    })
  })
})

// Integration tests with actual server
const ctx = createTestContext()

beforeAll(async () => {
  await ctx.setup()
})

afterAll(async () => {
  await ctx.teardown()
}, 60000)

// In-memory storage for tests
function createMemoryStorage(): Storage {
  const data = new Map<string, string>()
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value)
    },
    removeItem: (key: string) => {
      data.delete(key)
    },
    clear: () => data.clear(),
    get length() {
      return data.size
    },
    key: (index: number) => Array.from(data.keys())[index] ?? null,
  }
}

const TEST_SECRET = `test-secret-key-for-development`

describe(`createDurableFetch with origin option`, () => {
  let storage: Storage
  const proxyUrl = () => `${ctx.urls.proxy}/v1/proxy`

  beforeEach(() => {
    storage = createMemoryStorage()
  })

  it(`resolves relative upstream URL using explicit origin`, async () => {
    ctx.upstream.setResponse(createAIStreamingResponse([`Hello`]))

    // Create durableFetch with explicit origin pointing to our test upstream
    const durableFetch = createDurableFetch({
      proxyUrl: proxyUrl(),
      proxyAuthorization: TEST_SECRET,
      storage,
      autoResume: false,
      origin: ctx.urls.upstream,
    })

    // Use relative path instead of full URL
    const response = await durableFetch(`/v1/chat`, {
      method: `POST`,
      headers: { "Content-Type": `application/json` },
      body: JSON.stringify({ messages: [{ role: `user`, content: `Hi` }] }),
    })

    expect(response.ok).toBe(true)
    expect(response.streamId).toBeDefined()
  })

  it(`works with absolute URL even when origin is provided`, async () => {
    ctx.upstream.setResponse(createAIStreamingResponse([`World`]))

    const durableFetch = createDurableFetch({
      proxyUrl: proxyUrl(),
      proxyAuthorization: TEST_SECRET,
      storage,
      autoResume: false,
      origin: `https://should-not-be-used.example.com`,
    })

    // Use full URL - origin should be ignored
    const response = await durableFetch(ctx.urls.upstream + `/v1/chat`, {
      method: `POST`,
      body: JSON.stringify({ messages: [] }),
    })

    expect(response.ok).toBe(true)
    expect(response.streamId).toBeDefined()
  })

  it(`throws clear error when relative URL used without origin in non-browser env`, async () => {
    const durableFetch = createDurableFetch({
      proxyUrl: proxyUrl(),
      proxyAuthorization: TEST_SECRET,
      storage,
      autoResume: false,
      // No origin provided
    })

    await expect(
      durableFetch(`/v1/chat`, {
        method: `POST`,
        body: JSON.stringify({ messages: [] }),
      })
    ).rejects.toThrow(/Cannot resolve relative upstream URL/)
  })

  it(`handles URL object input with origin resolution`, async () => {
    ctx.upstream.setResponse(createAIStreamingResponse([`Test`]))

    const durableFetch = createDurableFetch({
      proxyUrl: proxyUrl(),
      proxyAuthorization: TEST_SECRET,
      storage,
      autoResume: false,
      origin: ctx.urls.upstream,
    })

    // Pass URL object with relative path
    const urlObj = new URL(`/v1/chat`, ctx.urls.upstream)
    const response = await durableFetch(urlObj, {
      method: `POST`,
      body: JSON.stringify({ messages: [] }),
    })

    expect(response.ok).toBe(true)
  })

  it(`properly resolves paths with query parameters`, async () => {
    ctx.upstream.setResponse(createAIStreamingResponse([`Query test`]))

    const durableFetch = createDurableFetch({
      proxyUrl: proxyUrl(),
      proxyAuthorization: TEST_SECRET,
      storage,
      autoResume: false,
      origin: ctx.urls.upstream,
    })

    const response = await durableFetch(`/v1/chat?model=test`, {
      method: `POST`,
      body: JSON.stringify({ messages: [] }),
    })

    expect(response.ok).toBe(true)
  })
})
