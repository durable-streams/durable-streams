/**
 * Integration tests using the actual client library.
 *
 * These tests verify that the client library correctly interacts with the proxy server.
 * RFC v1.1: Uses pre-signed URLs instead of Bearer tokens.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import {
  createAbortFn,
  createDurableFetch,
  createScopeFromUrl,
  createStorageKey,
  isExpired,
  loadCredentials,
} from "../client"
import { createDurableAdapter } from "../transports/tanstack"
import { createAIStreamingResponse, createTestContext } from "./harness"
import type { DurableFetch, StreamCredentials } from "../client/types"

const ctx = createTestContext()

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

beforeAll(async () => {
  await ctx.setup()
})

afterAll(async () => {
  await ctx.teardown()
}, 60000) // Extended timeout for cleanup of SSE connections

describe(`createDurableFetch client integration`, () => {
  let durableFetch: DurableFetch
  let storage: Storage

  beforeEach(() => {
    storage = createMemoryStorage()
    durableFetch = createDurableFetch({
      proxyUrl: `${ctx.urls.proxy}/v1/proxy/chat`,
      storage,
      autoResume: false, // Disable for clearer test behavior
    })
  })

  it(`creates a stream and gets correct response properties`, async () => {
    const streamKey = `client-test-${Date.now()}`

    // Set up mock upstream response
    ctx.upstream.setResponse(createAIStreamingResponse([`Hello`]))

    const response = await durableFetch(ctx.urls.upstream + `/v1/chat`, {
      method: `POST`,
      headers: { "Content-Type": `application/json` },
      body: JSON.stringify({ messages: [{ role: `user`, content: `Hi` }] }),
      stream_key: streamKey,
    })

    expect(response.ok).toBe(true)
    // RFC v1.1: Response now has durableStreamId (UUIDv7) instead of durableStreamPath
    expect(response.durableStreamId).toBeDefined()
    expect(response.durableStreamId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    )
    expect(response.wasResumed).toBe(false)
  })

  it(`stores credentials in storage`, async () => {
    const streamKey = `storage-test-${Date.now()}`

    ctx.upstream.setResponse(createAIStreamingResponse([`Test`]))

    const response = await durableFetch(ctx.urls.upstream + `/v1/chat`, {
      method: `POST`,
      body: JSON.stringify({ messages: [] }),
      stream_key: streamKey,
    })

    expect(response.ok).toBe(true)

    // Verify credentials were stored
    const proxyUrl = `${ctx.urls.proxy}/v1/proxy/chat`
    const storageKey = `durable-streams:${createScopeFromUrl(proxyUrl)}:${streamKey}`
    const storedData = storage.getItem(storageKey)
    expect(storedData).toBeDefined()

    const credentials = JSON.parse(storedData!) as StreamCredentials
    // RFC v1.1: Storage now contains streamId, expires, signature instead of path/readToken
    expect(credentials.streamId).toBeDefined()
    expect(credentials.streamId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    )
    expect(credentials.expires).toBeDefined()
    expect(credentials.signature).toBeDefined()
    expect(credentials.offset).toBe(`-1`)
  })

  it(`marks resumed responses correctly`, async () => {
    const streamKey = `resume-test-${Date.now()}`

    // Create initial stream
    ctx.upstream.setResponse(createAIStreamingResponse([`Part 1`]))

    // Enable auto-resume for this test
    const resumableFetch = createDurableFetch({
      proxyUrl: `${ctx.urls.proxy}/v1/proxy/chat`,
      storage,
      autoResume: true,
    })

    const response1 = await resumableFetch(ctx.urls.upstream + `/v1/chat`, {
      method: `POST`,
      body: JSON.stringify({ messages: [] }),
      stream_key: streamKey,
    })

    expect(response1.ok).toBe(true)
    expect(response1.wasResumed).toBe(false)

    // Wait for stream to complete
    await new Promise((r) => setTimeout(r, 200))

    // Second request with same stream_key should resume
    const response2 = await resumableFetch(ctx.urls.upstream + `/v1/chat`, {
      method: `POST`,
      body: JSON.stringify({ messages: [] }),
      stream_key: streamKey,
    })

    expect(response2.ok).toBe(true)
    expect(response2.wasResumed).toBe(true)
  })
})

describe(`createAbortFn client integration`, () => {
  let storage: Storage

  beforeEach(() => {
    storage = createMemoryStorage()
  })

  it(`aborts an in-progress stream`, async () => {
    const streamKey = `abort-test-${Date.now()}`

    // Set up a slow streaming response
    ctx.upstream.setResponse(
      createAIStreamingResponse([`Chunk 1`, `Chunk 2`, `Chunk 3`], 500) // 500ms delay
    )

    const durableFetch = createDurableFetch({
      proxyUrl: `${ctx.urls.proxy}/v1/proxy/chat`,
      storage,
      autoResume: false,
    })

    const response = await durableFetch(ctx.urls.upstream + `/v1/chat`, {
      method: `POST`,
      body: JSON.stringify({ messages: [] }),
      stream_key: streamKey,
    })

    expect(response.ok).toBe(true)

    // Get credentials from storage
    const proxyUrl = `${ctx.urls.proxy}/v1/proxy/chat`
    const storageKey = `durable-streams:${createScopeFromUrl(proxyUrl)}:${streamKey}`
    const storedData = storage.getItem(storageKey)
    expect(storedData).toBeDefined()
    const credentials = JSON.parse(storedData!) as StreamCredentials

    // Create abort function using the client library
    // RFC v1.1: Uses streamId, expires, signature instead of streamKey, readToken
    const abort = createAbortFn(
      `${ctx.urls.proxy}/v1/proxy/chat`,
      credentials.streamId,
      credentials.expires,
      credentials.signature
    )

    // Abort the stream - should not throw
    await abort()
  })

  it(`handles aborting already-completed streams`, async () => {
    const streamKey = `abort-complete-test-${Date.now()}`

    // Fast response that completes quickly
    ctx.upstream.setResponse(createAIStreamingResponse([`Done`]))

    const durableFetch = createDurableFetch({
      proxyUrl: `${ctx.urls.proxy}/v1/proxy/chat`,
      storage,
      autoResume: false,
    })

    const response = await durableFetch(ctx.urls.upstream + `/v1/chat`, {
      method: `POST`,
      body: JSON.stringify({ messages: [] }),
      stream_key: streamKey,
    })

    expect(response.ok).toBe(true)

    // Wait for stream to complete
    await new Promise((r) => setTimeout(r, 200))

    // Get credentials
    const proxyUrl = `${ctx.urls.proxy}/v1/proxy/chat`
    const storageKey = `durable-streams:${createScopeFromUrl(proxyUrl)}:${streamKey}`
    const storedData = storage.getItem(storageKey)
    const credentials = JSON.parse(storedData!) as StreamCredentials

    // Abort should succeed even though stream is complete (idempotent)
    const abort = createAbortFn(
      `${ctx.urls.proxy}/v1/proxy/chat`,
      credentials.streamId,
      credentials.expires,
      credentials.signature
    )

    await abort()
  })
})

describe(`client URL construction`, () => {
  it(`constructs correct read URL with pre-signed params`, async () => {
    const storage = createMemoryStorage()

    const durableFetch = createDurableFetch({
      proxyUrl: `${ctx.urls.proxy}/v1/proxy/chat`,
      storage,
      autoResume: false,
    })

    const streamKey = `url-test-${Date.now()}`

    ctx.upstream.setResponse(createAIStreamingResponse([`Test`]))

    const response = await durableFetch(ctx.urls.upstream + `/v1/chat`, {
      method: `POST`,
      body: JSON.stringify({ messages: [] }),
      stream_key: streamKey,
    })

    // If URL construction is wrong, this would fail with 404
    expect(response.ok).toBe(true)
    // RFC v1.1: Response now has UUIDv7 stream ID
    expect(response.durableStreamId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    )
  })

  it(`abort URL construction works correctly`, async () => {
    const storage = createMemoryStorage()
    const streamKey = `abort-url-test-${Date.now()}`

    ctx.upstream.setResponse(createAIStreamingResponse([`Test`], 500))

    const durableFetch = createDurableFetch({
      proxyUrl: `${ctx.urls.proxy}/v1/proxy/chat`,
      storage,
      autoResume: false,
    })

    const response = await durableFetch(ctx.urls.upstream + `/v1/chat`, {
      method: `POST`,
      body: JSON.stringify({ messages: [] }),
      stream_key: streamKey,
    })

    expect(response.ok).toBe(true)

    const proxyUrl = `${ctx.urls.proxy}/v1/proxy/chat`
    const storageKey = `durable-streams:${createScopeFromUrl(proxyUrl)}:${streamKey}`
    const storedData = storage.getItem(storageKey)
    const credentials = JSON.parse(storedData!) as StreamCredentials

    // This would fail with 404 if abort URL is constructed wrong
    const abort = createAbortFn(
      `${ctx.urls.proxy}/v1/proxy/chat`,
      credentials.streamId,
      credentials.expires,
      credentials.signature
    )

    await abort()
  })
})

describe(`client unit: storage key scoping`, () => {
  it(`creates different keys for different proxy URLs`, () => {
    const streamKey = `test-stream`
    const prefix = `durable-streams:`

    const scope1 = createScopeFromUrl(
      `https://proxy1.example.com/v1/proxy/chat`
    )
    const scope2 = createScopeFromUrl(
      `https://proxy2.example.com/v1/proxy/chat`
    )

    const key1 = createStorageKey(prefix, scope1, streamKey)
    const key2 = createStorageKey(prefix, scope2, streamKey)

    // Keys should be different even with same streamKey
    expect(key1).not.toBe(key2)
    expect(key1).toContain(`proxy1.example.com`)
    expect(key2).toContain(`proxy2.example.com`)
  })

  it(`creates different keys for different services on same proxy`, () => {
    const streamKey = `test-stream`
    const prefix = `durable-streams:`

    const scope1 = createScopeFromUrl(`https://proxy.example.com/v1/proxy/chat`)
    const scope2 = createScopeFromUrl(
      `https://proxy.example.com/v1/proxy/embeddings`
    )

    const key1 = createStorageKey(prefix, scope1, streamKey)
    const key2 = createStorageKey(prefix, scope2, streamKey)

    // Keys should be different even with same streamKey and host
    expect(key1).not.toBe(key2)
    expect(key1).toContain(`/chat`)
    expect(key2).toContain(`/embeddings`)
  })

  it(`scope includes full path for uniqueness`, () => {
    const scope = createScopeFromUrl(
      `https://api.example.com/custom/path/v1/proxy/chat`
    )

    // Should include the full origin + pathname
    expect(scope).toBe(`https://api.example.com/custom/path/v1/proxy/chat`)
  })
})

describe(`client unit: custom storage prefix`, () => {
  it(`uses custom storagePrefix when configured`, async () => {
    const storage = createMemoryStorage()
    const customPrefix = `my-app:`
    const streamKey = `prefix-test-${Date.now()}`

    ctx.upstream.setResponse(createAIStreamingResponse([`Test`]))

    const durableFetch = createDurableFetch({
      proxyUrl: `${ctx.urls.proxy}/v1/proxy/chat`,
      storage,
      storagePrefix: customPrefix,
      autoResume: false,
    })

    const response = await durableFetch(ctx.urls.upstream + `/v1/chat`, {
      method: `POST`,
      body: JSON.stringify({ messages: [] }),
      stream_key: streamKey,
    })

    expect(response.ok).toBe(true)

    // Verify credentials were stored with custom prefix
    const scope = createScopeFromUrl(`${ctx.urls.proxy}/v1/proxy/chat`)
    const expectedKey = `${customPrefix}${scope}:${streamKey}`
    const storedData = storage.getItem(expectedKey)

    expect(storedData).toBeDefined()
    expect(storedData).not.toBeNull()

    // Default prefix should NOT have data
    const defaultKey = `durable-streams:${scope}:${streamKey}`
    expect(storage.getItem(defaultKey)).toBeNull()
  })
})

describe(`client unit: TanStack adapter concurrent streams`, () => {
  it(`tracks multiple streams independently`, async () => {
    const storage = createMemoryStorage()

    const adapter = createDurableAdapter(ctx.urls.upstream + `/v1/chat`, {
      proxyUrl: `${ctx.urls.proxy}/v1/proxy/chat`,
      storage,
      getStreamKey: (_msgs, data) => {
        const d = data as { streamId?: string } | undefined
        return d?.streamId ?? `default`
      },
    })

    // Create first stream
    ctx.upstream.setResponse(createAIStreamingResponse([`Stream 1`], 500))
    const conn1 = await adapter.connect({
      url: ctx.urls.upstream + `/v1/chat`,
      body: { messages: [], data: { streamId: `stream-1-${Date.now()}` } },
    })
    expect(conn1.stream).toBeDefined()

    // Create second stream
    ctx.upstream.setResponse(createAIStreamingResponse([`Stream 2`], 500))
    const conn2 = await adapter.connect({
      url: ctx.urls.upstream + `/v1/chat`,
      body: { messages: [], data: { streamId: `stream-2-${Date.now()}` } },
    })
    expect(conn2.stream).toBeDefined()

    // Both streams should be active - abort should work
    // (This tests that the Map-based tracking doesn't lose the first stream)
    await adapter.abort()
  })
})

describe(`client unit: token expiration`, () => {
  it(`isExpired returns false for fresh credentials`, () => {
    // RFC v1.1: Credentials now use streamId, expires, signature
    const credentials: StreamCredentials = {
      streamId: `01234567-89ab-7cde-8f01-234567890abc`,
      expires: String(Math.floor(Date.now() / 1000) + 3600),
      signature: `test-signature`,
      offset: `-1`,
      createdAt: Date.now(),
    }

    expect(isExpired(credentials)).toBe(false)
  })

  it(`isExpired returns true for old credentials`, () => {
    const credentials: StreamCredentials = {
      streamId: `01234567-89ab-7cde-8f01-234567890abc`,
      expires: String(Math.floor(Date.now() / 1000) + 3600),
      signature: `test-signature`,
      offset: `-1`,
      createdAt: Date.now() - 25 * 60 * 60 * 1000, // 25 hours ago
    }

    expect(isExpired(credentials)).toBe(true)
  })

  it(`auto-resume skips expired credentials and creates new stream`, async () => {
    const storage = createMemoryStorage()
    const streamKey = `expired-test-${Date.now()}`

    // Manually insert expired credentials
    const proxyUrl = `${ctx.urls.proxy}/v1/proxy/chat`
    const scope = createScopeFromUrl(proxyUrl)
    const storageKey = `durable-streams:${scope}:${streamKey}`

    const expiredCredentials: StreamCredentials = {
      streamId: `01234567-89ab-7cde-8f01-234567890abc`,
      expires: String(Math.floor(Date.now() / 1000) - 3600), // Expired 1 hour ago
      signature: `old-signature`,
      offset: `100`,
      createdAt: Date.now() - 25 * 60 * 60 * 1000, // 25 hours ago (expired)
    }
    storage.setItem(storageKey, JSON.stringify(expiredCredentials))

    // Set up fresh upstream response
    ctx.upstream.setResponse(createAIStreamingResponse([`Fresh`]))

    const durableFetch = createDurableFetch({
      proxyUrl,
      storage,
      autoResume: true,
    })

    const response = await durableFetch(ctx.urls.upstream + `/v1/chat`, {
      method: `POST`,
      body: JSON.stringify({ messages: [] }),
      stream_key: streamKey,
    })

    expect(response.ok).toBe(true)
    // Should NOT be a resume - should have created new stream
    expect(response.wasResumed).toBe(false)

    // Credentials should be updated with fresh data
    const newCredentials = JSON.parse(
      storage.getItem(storageKey)!
    ) as StreamCredentials
    expect(newCredentials.createdAt).toBeGreaterThan(
      expiredCredentials.createdAt
    )
    // Stream ID should be different (new stream)
    expect(newCredentials.streamId).not.toBe(expiredCredentials.streamId)
  })
})

describe(`client unit: credentials persistence`, () => {
  it(`loadCredentials returns null for non-existent key`, () => {
    const storage = createMemoryStorage()
    const scope = createScopeFromUrl(`https://proxy.example.com/v1/proxy/chat`)

    const credentials = loadCredentials(
      storage,
      `durable-streams:`,
      scope,
      `non-existent-key`
    )

    expect(credentials).toBeNull()
  })

  it(`loadCredentials returns null for malformed JSON`, () => {
    const storage = createMemoryStorage()
    const scope = createScopeFromUrl(`https://proxy.example.com/v1/proxy/chat`)
    const key = `durable-streams:${scope}:test-key`

    storage.setItem(key, `not valid json`)

    const credentials = loadCredentials(
      storage,
      `durable-streams:`,
      scope,
      `test-key`
    )

    expect(credentials).toBeNull()
  })
})
