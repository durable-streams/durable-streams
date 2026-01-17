/**
 * Integration tests using the actual client library.
 *
 * These tests verify that the client library correctly interacts with the proxy server.
 * They would have caught bugs like the URL construction issue.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createAbortFn, createDurableFetch } from "../client"
import { createAIStreamingResponse, createTestContext } from "./harness"
import type { DurableFetch } from "../client/types"

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

  it(`creates a stream and gets correct headers`, async () => {
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
    expect(response.durableStreamPath).toBeDefined()
    expect(response.durableStreamPath).toContain(
      `/v1/streams/chat/${streamKey}`
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
    const storedData = storage.getItem(`durable-streams:${streamKey}`)
    expect(storedData).toBeDefined()

    const credentials = JSON.parse(storedData!)
    expect(credentials.path).toContain(`/v1/streams/chat/`)
    expect(credentials.readToken).toBeDefined()
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
    const storedData = storage.getItem(`durable-streams:${streamKey}`)
    expect(storedData).toBeDefined()
    const credentials = JSON.parse(storedData!)

    // Create abort function using the client library
    const abort = createAbortFn(
      `${ctx.urls.proxy}/v1/proxy/chat`,
      streamKey,
      credentials.readToken
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
    const storedData = storage.getItem(`durable-streams:${streamKey}`)
    const credentials = JSON.parse(storedData!)

    // Abort should succeed even though stream is complete (idempotent)
    const abort = createAbortFn(
      `${ctx.urls.proxy}/v1/proxy/chat`,
      streamKey,
      credentials.readToken
    )

    await abort()
  })
})

describe(`client URL construction`, () => {
  it(`constructs correct read URL - would fail with old buggy code`, async () => {
    const storage = createMemoryStorage()

    // This test verifies the URL construction fix
    // The client should construct: /v1/proxy/{service}/streams/{key}
    // NOT the old buggy: /v1/proxy/v1/proxy/{service}/{key}

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
    expect(response.durableStreamPath).toContain(
      `/v1/streams/chat/${streamKey}`
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

    const storedData = storage.getItem(`durable-streams:${streamKey}`)
    const credentials = JSON.parse(storedData!)

    // This would fail with 404 if abort URL is constructed wrong
    const abort = createAbortFn(
      `${ctx.urls.proxy}/v1/proxy/chat`,
      streamKey,
      credentials.readToken
    )

    await abort()
  })
})
