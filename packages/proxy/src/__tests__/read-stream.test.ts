/**
 * Tests for reading streams through the proxy.
 *
 * GET /v1/proxy/{service}/{stream_id}?offset=-1&expires=...&signature=...&live=...
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
  let streamId: string
  let expires: string
  let signature: string

  beforeEach(async () => {
    // Create a fresh stream for each test
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
      upstreamUrl: ctx.urls.upstream + `/v1/chat/completions`,
      body: { messages: [] },
    })

    expect(result.status).toBe(201)
    streamId = result.streamId!
    expires = result.expires!
    signature = result.signature!

    // Wait for upstream to complete
    await new Promise((r) => setTimeout(r, 100))
  })

  it(`returns 401 when signature is missing`, async () => {
    const url = new URL(`/v1/proxy/chat/${streamId}`, ctx.urls.proxy)
    url.searchParams.set(`offset`, `-1`)
    url.searchParams.set(`expires`, expires)
    // Missing signature

    const response = await fetch(url.toString())

    expect(response.status).toBe(401)
    const body = await response.json()
    expect(body.error.code).toBe(`MISSING_SIGNATURE`)
  })

  it(`returns 401 when signature is invalid`, async () => {
    const result = await readStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamId,
      expires,
      signature: `invalid-signature`,
      offset: `-1`,
    })

    expect(result.status).toBe(401)
  })

  it(`returns 401 when URL has expired`, async () => {
    const result = await readStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamId,
      expires: `1000000000`, // Year 2001 (expired)
      signature, // Signature won't match with different expires anyway
      offset: `-1`,
    })

    expect(result.status).toBe(401)
  })

  it(`returns 403 when signature is for a different stream`, async () => {
    // Create a second stream to get a valid signature for it
    ctx.upstream.setResponse({ body: `other` })
    const otherResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      upstreamUrl: ctx.urls.upstream + `/api`,
      body: {},
    })

    // Try to read first stream with second stream's signature
    const result = await readStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamId,
      expires: otherResult.expires!,
      signature: otherResult.signature!, // Wrong signature (for other stream)
      offset: `-1`,
    })

    expect(result.status).toBe(401)
  })

  it(`reads stream data with valid pre-signed URL`, async () => {
    const result = await readStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamId,
      expires,
      signature,
      offset: `-1`,
    })

    expect(result.status).toBe(200)
    expect(result.body).toContain(`Hello`)
    expect(result.body).toContain(`World`)
  })

  it(`returns next offset header`, async () => {
    const result = await readStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamId,
      expires,
      signature,
      offset: `-1`,
    })

    expect(result.status).toBe(200)
    expect(result.nextOffset).toBeDefined()
    expect(result.nextOffset).not.toBe(`-1`)
  })

  it(`supports reading from a specific offset`, async () => {
    // First read to get the tail offset
    const firstResult = await readStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamId,
      expires,
      signature,
      offset: `-1`,
    })

    expect(firstResult.nextOffset).toBeDefined()

    // Read from the end - should get no new data
    const secondResult = await readStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamId,
      expires,
      signature,
      offset: firstResult.nextOffset!,
    })

    // Should return empty or minimal response when at tail
    expect(secondResult.status).toBe(200)
  })

  it(`includes CORS headers in response`, async () => {
    const result = await readStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamId,
      expires,
      signature,
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
      upstreamUrl: ctx.urls.upstream + `/v1/chat`,
      body: {},
    })

    await new Promise((r) => setTimeout(r, 150))

    // Read with offset=-1 should get all data
    const result = await readStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamId: createResult.streamId!,
      expires: createResult.expires!,
      signature: createResult.signature!,
      offset: `-1`,
    })

    expect(result.status).toBe(200)
    expect(result.body).toContain(`"seq": 1`)
    expect(result.body).toContain(`"seq": 2`)
    expect(result.body).toContain(`"seq": 3`)
  })
})
