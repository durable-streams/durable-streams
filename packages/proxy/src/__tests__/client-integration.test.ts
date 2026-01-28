/**
 * Integration tests using the actual client library.
 *
 * These tests verify that the client library correctly interacts with the proxy server.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import {
  createAbortFn,
  createDurableFetch,
  createStorageKey,
  isUrlExpired,
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

const TEST_SECRET = `test-secret-key-for-development`

beforeAll(async () => {
  await ctx.setup()
})

afterAll(async () => {
  await ctx.teardown()
}, 60000) // Extended timeout for cleanup of SSE connections

describe(`createDurableFetch client integration`, () => {
  let durableFetch: DurableFetch
  let storage: Storage
  const proxyUrl = () => `${ctx.urls.proxy}/v1/proxy`

  beforeEach(() => {
    storage = createMemoryStorage()
    durableFetch = createDurableFetch({
      proxyUrl: proxyUrl(),
      proxyAuthorization: TEST_SECRET,
      storage,
      autoResume: false, // Disable for clearer test behavior
    })
  })

  it(`creates a stream and returns response with stream properties`, async () => {
    // Set up mock upstream response
    ctx.upstream.setResponse(createAIStreamingResponse([`Hello`]))

    const response = await durableFetch(ctx.urls.upstream + `/v1/chat`, {
      method: `POST`,
      headers: { "Content-Type": `application/json` },
      body: JSON.stringify({ messages: [{ role: `user`, content: `Hi` }] }),
    })

    expect(response.ok).toBe(true)
    expect(response.streamId).toBeDefined()
    expect(response.streamUrl).toBeDefined()
    expect(response.wasResumed).toBe(false)
  })

  it(`stores credentials in storage when requestId is provided`, async () => {
    const requestId = `storage-test-${Date.now()}`

    ctx.upstream.setResponse(createAIStreamingResponse([`Test`]))

    const response = await durableFetch(ctx.urls.upstream + `/v1/chat`, {
      method: `POST`,
      body: JSON.stringify({ messages: [] }),
      requestId,
    })

    expect(response.ok).toBe(true)

    // Verify credentials were stored
    const normalizedUrl = proxyUrl()
    const storageKey = createStorageKey(
      `durable-streams:`,
      normalizedUrl,
      requestId
    )
    const storedData = storage.getItem(storageKey)
    expect(storedData).toBeDefined()

    const credentials = JSON.parse(storedData!) as StreamCredentials
    expect(credentials.streamUrl).toBeDefined()
    expect(credentials.streamId).toBeDefined()
    expect(credentials.offset).toBe(`-1`)
    expect(credentials.expiresAt).toBeGreaterThan(0)
  })

  it(`does not store credentials when requestId is not provided`, async () => {
    ctx.upstream.setResponse(createAIStreamingResponse([`Test`]))

    const response = await durableFetch(ctx.urls.upstream + `/v1/chat`, {
      method: `POST`,
      body: JSON.stringify({ messages: [] }),
      // No requestId
    })

    expect(response.ok).toBe(true)

    // Storage should be empty (no requestId = no persistence)
    expect(storage.length).toBe(0)
  })

  it(`marks resumed responses correctly`, async () => {
    const requestId = `resume-test-${Date.now()}`

    // Create initial stream
    ctx.upstream.setResponse(createAIStreamingResponse([`Part 1`]))

    // Enable auto-resume for this test
    const resumableFetch = createDurableFetch({
      proxyUrl: proxyUrl(),
      proxyAuthorization: TEST_SECRET,
      storage,
      autoResume: true,
    })

    const response1 = await resumableFetch(ctx.urls.upstream + `/v1/chat`, {
      method: `POST`,
      body: JSON.stringify({ messages: [] }),
      requestId,
    })

    expect(response1.ok).toBe(true)
    expect(response1.wasResumed).toBe(false)

    // Wait for stream to complete
    await new Promise((r) => setTimeout(r, 200))

    // Second request with same requestId should resume
    const response2 = await resumableFetch(ctx.urls.upstream + `/v1/chat`, {
      method: `POST`,
      body: JSON.stringify({ messages: [] }),
      requestId,
    })

    expect(response2.ok).toBe(true)
    expect(response2.wasResumed).toBe(true)
  })
})

describe(`createAbortFn client integration`, () => {
  let storage: Storage
  const proxyUrl = () => `${ctx.urls.proxy}/v1/proxy`

  beforeEach(() => {
    storage = createMemoryStorage()
  })

  it(`aborts an in-progress stream`, async () => {
    // Set up a slow streaming response
    ctx.upstream.setResponse(
      createAIStreamingResponse([`Chunk 1`, `Chunk 2`, `Chunk 3`], 500) // 500ms delay
    )

    const durableFetch = createDurableFetch({
      proxyUrl: proxyUrl(),
      proxyAuthorization: TEST_SECRET,
      storage,
      autoResume: false,
    })

    const response = await durableFetch(ctx.urls.upstream + `/v1/chat`, {
      method: `POST`,
      body: JSON.stringify({ messages: [] }),
      requestId: `abort-test-${Date.now()}`,
    })

    expect(response.ok).toBe(true)
    expect(response.streamUrl).toBeDefined()

    // Create abort function using the pre-signed stream URL
    const abort = createAbortFn(response.streamUrl!)

    // Abort the stream - should not throw
    await abort()
  })

  it(`handles aborting already-completed streams`, async () => {
    // Fast response that completes quickly
    ctx.upstream.setResponse(createAIStreamingResponse([`Done`]))

    const durableFetch = createDurableFetch({
      proxyUrl: proxyUrl(),
      proxyAuthorization: TEST_SECRET,
      storage,
      autoResume: false,
    })

    const response = await durableFetch(ctx.urls.upstream + `/v1/chat`, {
      method: `POST`,
      body: JSON.stringify({ messages: [] }),
      requestId: `abort-complete-test-${Date.now()}`,
    })

    expect(response.ok).toBe(true)

    // Wait for stream to complete
    await new Promise((r) => setTimeout(r, 200))

    // Abort should succeed even though stream is complete (idempotent)
    const abort = createAbortFn(response.streamUrl!)
    await abort()
  })
})

describe(`client unit: storage key scoping`, () => {
  it(`creates different keys for different proxy URLs`, () => {
    const requestId = `test-stream`
    const prefix = `durable-streams:`

    const scope1 = `https://proxy1.example.com/v1/proxy`
    const scope2 = `https://proxy2.example.com/v1/proxy`

    const key1 = createStorageKey(prefix, scope1, requestId)
    const key2 = createStorageKey(prefix, scope2, requestId)

    // Keys should be different even with same requestId
    expect(key1).not.toBe(key2)
    expect(key1).toContain(`proxy1.example.com`)
    expect(key2).toContain(`proxy2.example.com`)
  })
})

describe(`client unit: custom storage prefix`, () => {
  it(`uses custom storagePrefix when configured`, async () => {
    const storage = createMemoryStorage()
    const customPrefix = `my-app:`
    const requestId = `prefix-test-${Date.now()}`
    const proxyUrl = `${ctx.urls.proxy}/v1/proxy`

    ctx.upstream.setResponse(createAIStreamingResponse([`Test`]))

    const durableFetch = createDurableFetch({
      proxyUrl,
      proxyAuthorization: TEST_SECRET,
      storage,
      storagePrefix: customPrefix,
      autoResume: false,
    })

    const response = await durableFetch(ctx.urls.upstream + `/v1/chat`, {
      method: `POST`,
      body: JSON.stringify({ messages: [] }),
      requestId,
    })

    expect(response.ok).toBe(true)

    // Verify credentials were stored with custom prefix
    const expectedKey = `${customPrefix}${proxyUrl}:${requestId}`
    const storedData = storage.getItem(expectedKey)

    expect(storedData).toBeDefined()
    expect(storedData).not.toBeNull()

    // Default prefix should NOT have data
    const defaultKey = `durable-streams:${proxyUrl}:${requestId}`
    expect(storage.getItem(defaultKey)).toBeNull()
  })
})

describe(`client unit: TanStack adapter concurrent streams`, () => {
  it(`tracks multiple streams independently`, async () => {
    const storage = createMemoryStorage()

    const adapter = createDurableAdapter(ctx.urls.upstream + `/v1/chat`, {
      proxyUrl: `${ctx.urls.proxy}/v1/proxy`,
      proxyAuthorization: TEST_SECRET,
      storage,
      getRequestId: (_msgs, data) => {
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
    await adapter.abort()
  })
})

describe(`client unit: URL expiration`, () => {
  it(`isUrlExpired returns false for fresh credentials`, () => {
    const credentials: StreamCredentials = {
      streamUrl: `http://example.com/v1/proxy/abc?expires=${Math.floor(Date.now() / 1000) + 3600}&signature=sig`,
      streamId: `abc`,
      offset: `-1`,
      createdAt: Date.now(),
      expiresAt: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
    }

    expect(isUrlExpired(credentials)).toBe(false)
  })

  it(`isUrlExpired returns true for expired credentials`, () => {
    const credentials: StreamCredentials = {
      streamUrl: `http://example.com/v1/proxy/abc?expires=${Math.floor(Date.now() / 1000) - 3600}&signature=sig`,
      streamId: `abc`,
      offset: `-1`,
      createdAt: Date.now() - 2 * 3600 * 1000,
      expiresAt: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
    }

    expect(isUrlExpired(credentials)).toBe(true)
  })

  it(`auto-resume skips expired credentials and creates new stream`, async () => {
    const storage = createMemoryStorage()
    const requestId = `expired-test-${Date.now()}`
    const proxyUrl = `${ctx.urls.proxy}/v1/proxy`

    // Manually insert expired credentials
    const storageKey = `durable-streams:${proxyUrl}:${requestId}`

    const expiredCredentials: StreamCredentials = {
      streamUrl: `${ctx.urls.proxy}/v1/proxy/old-stream-id?expires=${Math.floor(Date.now() / 1000) - 3600}&signature=sig`,
      streamId: `old-stream-id`,
      offset: `100`,
      createdAt: Date.now() - 2 * 3600 * 1000,
      expiresAt: Math.floor(Date.now() / 1000) - 3600, // expired
    }
    storage.setItem(storageKey, JSON.stringify(expiredCredentials))

    // Set up fresh upstream response
    ctx.upstream.setResponse(createAIStreamingResponse([`Fresh`]))

    const durableFetch = createDurableFetch({
      proxyUrl,
      proxyAuthorization: TEST_SECRET,
      storage,
      autoResume: true,
    })

    const response = await durableFetch(ctx.urls.upstream + `/v1/chat`, {
      method: `POST`,
      body: JSON.stringify({ messages: [] }),
      requestId,
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
    expect(newCredentials.streamId).not.toBe(`old-stream-id`)
  })
})

describe(`client unit: credentials persistence`, () => {
  it(`loadCredentials returns null for non-existent key`, () => {
    const storage = createMemoryStorage()
    const scope = `https://proxy.example.com/v1/proxy`

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
    const scope = `https://proxy.example.com/v1/proxy`
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
