/**
 * Tests for control messages appended by the proxy.
 *
 * Control messages indicate stream completion, abort, or error conditions.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  abortStream,
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

describe(`control messages`, () => {
  it(`closes stream when upstream finishes`, async () => {
    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: createSSEChunks([
        { data: `{"text": "Hello"}` },
        { data: `{"text": " World"}` },
      ]),
      chunkDelayMs: 10,
    })

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/chat`,
      body: {},
    })

    // Wait for completion
    await new Promise((r) => setTimeout(r, 200))

    const readResult = await readStream({
      streamUrl: createResult.streamUrl!,
      offset: `-1`,
    })

    expect(readResult.status).toBe(200)
    // Stream should contain the data
    expect(readResult.body).toContain(`Hello`)
    expect(readResult.body).toContain(`World`)
  })

  it(`stream is readable after abort`, async () => {
    // Create a slow stream
    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: createSSEChunks(
        Array(100)
          .fill(0)
          .map((_, i) => ({ data: `{"n": ${i}}` }))
      ),
      chunkDelayMs: 100,
    })

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/chat`,
      body: {},
    })

    // Wait for some data, then abort
    await new Promise((r) => setTimeout(r, 150))

    await abortStream({
      streamUrl: createResult.streamUrl!,
    })

    // Wait for abort to be processed
    await new Promise((r) => setTimeout(r, 100))

    const readResult = await readStream({
      streamUrl: createResult.streamUrl!,
      offset: `-1`,
    })

    expect(readResult.status).toBe(200)
    // Should have some data that was written before abort
    expect(readResult.body.length).toBeGreaterThan(0)
  })

  it(`handles upstream error`, async () => {
    // Upstream returns error
    ctx.upstream.setResponse({
      status: 500,
      headers: { "Content-Type": `application/json` },
      body: JSON.stringify({ error: `Internal server error` }),
    })

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/chat`,
      body: {},
    })

    // Upstream error should be returned directly (502)
    expect(createResult.status).toBe(502)
  })

  it(`includes upstream status code in error response`, async () => {
    ctx.upstream.setResponse({
      status: 429,
      headers: { "Content-Type": `application/json` },
      body: JSON.stringify({ error: `Rate limited` }),
    })

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/chat`,
      body: {},
    })

    expect(createResult.status).toBe(502)
    expect(createResult.headers.get(`Upstream-Status`)).toBe(`429`)
  })
})
