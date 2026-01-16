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
  it(`appends complete control message when upstream finishes`, async () => {
    const streamKey = `control-complete-${Date.now()}`

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
      serviceName: `chat`,
      streamKey,
      upstreamUrl: ctx.urls.upstream + `/v1/chat`,
      body: {},
    })

    // Wait for completion
    await new Promise((r) => setTimeout(r, 200))

    const readResult = await readStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamKey,
      readToken: createResult.readToken!,
      offset: `-1`,
    })

    expect(readResult.status).toBe(200)
    // Should contain the completion control message
    expect(readResult.body).toContain(`"type":"close"`)
    expect(readResult.body).toContain(`"reason":"complete"`)
  })

  it(`appends abort control message when stream is aborted`, async () => {
    const streamKey = `control-abort-${Date.now()}`

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
      serviceName: `chat`,
      streamKey,
      upstreamUrl: ctx.urls.upstream + `/v1/chat`,
      body: {},
    })

    // Wait for some data, then abort
    await new Promise((r) => setTimeout(r, 150))

    await abortStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamKey,
      readToken: createResult.readToken!,
    })

    // Wait for abort message to be written
    await new Promise((r) => setTimeout(r, 100))

    const readResult = await readStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamKey,
      readToken: createResult.readToken!,
      offset: `-1`,
    })

    expect(readResult.status).toBe(200)
    expect(readResult.body).toContain(`"type":"close"`)
    expect(readResult.body).toContain(`"reason":"aborted"`)
  })

  it(`appends error control message when upstream fails`, async () => {
    const streamKey = `control-error-${Date.now()}`

    // Upstream returns error
    ctx.upstream.setResponse({
      status: 500,
      headers: { "Content-Type": `application/json` },
      body: JSON.stringify({ error: `Internal server error` }),
    })

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamKey,
      upstreamUrl: ctx.urls.upstream + `/v1/chat`,
      body: {},
    })

    // Wait for error to be processed
    await new Promise((r) => setTimeout(r, 200))

    const readResult = await readStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamKey,
      readToken: createResult.readToken!,
      offset: `-1`,
    })

    expect(readResult.status).toBe(200)
    expect(readResult.body).toContain(`"type":"close"`)
    expect(readResult.body).toContain(`"reason":"error"`)
    expect(readResult.body).toContain(`UPSTREAM_ERROR`)
  })

  it(`includes error status code in error control message`, async () => {
    const streamKey = `control-error-status-${Date.now()}`

    ctx.upstream.setResponse({
      status: 429,
      headers: { "Content-Type": `application/json` },
      body: JSON.stringify({ error: `Rate limited` }),
    })

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamKey,
      upstreamUrl: ctx.urls.upstream + `/v1/chat`,
      body: {},
    })

    await new Promise((r) => setTimeout(r, 200))

    const readResult = await readStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamKey,
      readToken: createResult.readToken!,
      offset: `-1`,
    })

    expect(readResult.body).toContain(`"status":429`)
  })
})
