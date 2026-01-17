/**
 * Tests for reading streams through the proxy.
 *
 * GET /v1/proxy/{service}/streams/{key}?offset=-1&live=...
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import {
  createSSEChunks,
  createStream,
  createTestContext,
  readStream,
} from "./harness"

const ctx = createTestContext()

beforeAll(async () => {
  await ctx.setup()
})

afterAll(async () => {
  await ctx.teardown()
})

describe(`stream reading`, () => {
  let streamPath: string
  let readToken: string

  beforeEach(async () => {
    // Create a fresh stream for each test
    const streamKey = `read-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: createSSEChunks([
        { data: `{"text": "Hello"}` },
        { data: `{"text": " World"}` },
      ]),
      chunkDelayMs: 10,
    })

    const result = await createStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamKey,
      upstreamUrl: ctx.urls.upstream + `/v1/chat/completions`,
      body: { messages: [] },
    })

    expect(result.status).toBe(201)
    streamPath = result.streamPath!
    readToken = result.readToken!

    // Wait for upstream to complete
    await new Promise((r) => setTimeout(r, 100))
  })

  it(`returns 401 when no authorization header is provided`, async () => {
    const url = new URL(`/v1/proxy/chat/streams/some-key`, ctx.urls.proxy)
    url.searchParams.set(`offset`, `-1`)

    const response = await fetch(url.toString())

    expect(response.status).toBe(401)
    const body = await response.json()
    expect(body.error.code).toBe(`MISSING_TOKEN`)
  })

  it(`returns 401 when token is invalid`, async () => {
    const result = await readStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamKey: `some-key`,
      readToken: `invalid-token`,
      offset: `-1`,
    })

    expect(result.status).toBe(401)
  })

  it(`returns 403 when token is for a different stream`, async () => {
    // Create a second stream to get a valid token for it
    const otherKey = `other-stream-${Date.now()}`
    ctx.upstream.setResponse({ body: `other` })
    const otherResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamKey: otherKey,
      upstreamUrl: ctx.urls.upstream + `/api`,
      body: {},
    })

    // Try to read first stream with second stream's token
    const streamKey = streamPath.split(`/`).pop()!
    const result = await readStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamKey,
      readToken: otherResult.readToken!, // Wrong token
      offset: `-1`,
    })

    expect(result.status).toBe(403)
  })

  it(`reads stream data with valid token`, async () => {
    const streamKey = streamPath.split(`/`).pop()!

    const result = await readStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamKey,
      readToken,
      offset: `-1`,
    })

    expect(result.status).toBe(200)
    expect(result.body).toContain(`Hello`)
    expect(result.body).toContain(`World`)
  })

  it(`returns next offset header`, async () => {
    const streamKey = streamPath.split(`/`).pop()!

    const result = await readStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamKey,
      readToken,
      offset: `-1`,
    })

    expect(result.status).toBe(200)
    expect(result.nextOffset).toBeDefined()
    expect(result.nextOffset).not.toBe(`-1`)
  })

  it(`supports reading from a specific offset`, async () => {
    const streamKey = streamPath.split(`/`).pop()!

    // First read to get the tail offset
    const firstResult = await readStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamKey,
      readToken,
      offset: `-1`,
    })

    expect(firstResult.nextOffset).toBeDefined()

    // Read from the end - should get no new data
    const secondResult = await readStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamKey,
      readToken,
      offset: firstResult.nextOffset!,
    })

    // Should return empty or minimal response when at tail
    expect(secondResult.status).toBe(200)
  })

  it(`includes CORS headers in response`, async () => {
    const streamKey = streamPath.split(`/`).pop()!

    const result = await readStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamKey,
      readToken,
      offset: `-1`,
    })

    expect(result.headers.get(`access-control-allow-origin`)).toBe(`*`)
    expect(result.headers.get(`access-control-expose-headers`)).toContain(
      `Stream-Next-Offset`
    )
  })
})

describe(`stream reading - offset=-1 replay`, () => {
  it(`reads from beginning when offset is -1`, async () => {
    const streamKey = `replay-test-${Date.now()}`

    // Create stream with known content
    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: createSSEChunks([
        { data: `{"seq": 1}` },
        { data: `{"seq": 2}` },
        { data: `{"seq": 3}` },
      ]),
      chunkDelayMs: 10,
    })

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamKey,
      upstreamUrl: ctx.urls.upstream + `/v1/chat`,
      body: {},
    })

    await new Promise((r) => setTimeout(r, 150))

    // Read with offset=-1 should get all data
    const result = await readStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamKey,
      readToken: createResult.readToken!,
      offset: `-1`,
    })

    expect(result.status).toBe(200)
    expect(result.body).toContain(`"seq": 1`)
    expect(result.body).toContain(`"seq": 2`)
    expect(result.body).toContain(`"seq": 3`)
  })
})
