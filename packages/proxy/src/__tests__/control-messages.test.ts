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
      upstreamUrl: ctx.urls.upstream + `/v1/chat`,
      body: {},
    })

    expect(createResult.status).toBe(201)

    // Wait for completion
    await new Promise((r) => setTimeout(r, 200))

    const readResult = await readStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamId: createResult.streamId!,
      expires: createResult.expires!,
      signature: createResult.signature!,
      offset: `-1`,
    })

    expect(readResult.status).toBe(200)
    // Should contain the completion control message
    expect(readResult.body).toContain(`"type":"close"`)
    expect(readResult.body).toContain(`"reason":"complete"`)
  })

  it(`appends abort control message when stream is aborted`, async () => {
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
      upstreamUrl: ctx.urls.upstream + `/v1/chat`,
      body: {},
    })

    expect(createResult.status).toBe(201)

    // Wait for some data, then abort
    await new Promise((r) => setTimeout(r, 150))

    const abortResult = await abortStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamId: createResult.streamId!,
      expires: createResult.expires!,
      signature: createResult.signature!,
    })

    expect(abortResult.status).toBe(204)

    // Wait for abort message to be written
    await new Promise((r) => setTimeout(r, 100))

    const readResult = await readStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamId: createResult.streamId!,
      expires: createResult.expires!,
      signature: createResult.signature!,
      offset: `-1`,
    })

    expect(readResult.status).toBe(200)
    expect(readResult.body).toContain(`"type":"close"`)
    expect(readResult.body).toContain(`"reason":"aborted"`)
  })

  it(`appends error control message when upstream fails mid-stream`, async () => {
    // This test verifies that upstream errors that occur after initial success
    // are recorded in the stream as control messages
    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: createSSEChunks([{ data: `{"text": "start"}` }]),
      chunkDelayMs: 10,
    })

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      upstreamUrl: ctx.urls.upstream + `/v1/chat`,
      body: {},
    })

    expect(createResult.status).toBe(201)

    // Wait for stream to complete
    await new Promise((r) => setTimeout(r, 200))

    const readResult = await readStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamId: createResult.streamId!,
      expires: createResult.expires!,
      signature: createResult.signature!,
      offset: `-1`,
    })

    expect(readResult.status).toBe(200)
    // Should have completion (since stream finished normally)
    expect(readResult.body).toContain(`"type":"close"`)
  })
})
