/**
 * Tests for aborting streams through the proxy.
 *
 * PATCH /v1/proxy/:streamId?action=abort&expires=...&signature=...
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

describe(`stream abort`, () => {
  it(`returns 401 when no authentication is provided`, async () => {
    // Use a stream ID without pre-signed URL params
    const url = new URL(`/v1/proxy/some-stream-id`, ctx.urls.proxy)
    url.searchParams.set(`action`, `abort`)

    const response = await fetch(url.toString(), {
      method: `PATCH`,
    })

    expect(response.status).toBe(401)
    const body = await response.json()
    expect(body.error.code).toBe(`MISSING_SIGNATURE`)
  })

  it(`returns 204 for already completed streams (idempotent)`, async () => {
    // Create a stream that completes quickly
    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: `data: done\n\n`,
    })

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/chat`,
      body: {},
    })

    // Wait for stream to complete
    await new Promise((r) => setTimeout(r, 100))

    // Abort should succeed idempotently
    const result = await abortStream({
      streamUrl: createResult.streamUrl!,
    })

    expect(result.status).toBe(204)
  })

  it(`returns 204 when aborting an in-progress stream`, async () => {
    // Create a slow stream
    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: createSSEChunks(
        Array(100)
          .fill(0)
          .map((_, i) => ({ data: `chunk ${i}` }))
      ),
      chunkDelayMs: 100, // Very slow - 10 seconds total
    })

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/chat`,
      body: {},
    })

    // Abort immediately
    const result = await abortStream({
      streamUrl: createResult.streamUrl!,
    })

    expect(result.status).toBe(204)
  })

  it(`is idempotent - multiple aborts return 204`, async () => {
    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: createSSEChunks(
        Array(100)
          .fill(0)
          .map((_, i) => ({ data: `chunk ${i}` }))
      ),
      chunkDelayMs: 100,
    })

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/chat`,
      body: {},
    })

    // First abort
    const firstAbort = await abortStream({
      streamUrl: createResult.streamUrl!,
    })
    expect(firstAbort.status).toBe(204)

    // Second abort should also succeed
    const secondAbort = await abortStream({
      streamUrl: createResult.streamUrl!,
    })
    expect(secondAbort.status).toBe(204)
  })

  it(`preserves data written before abort`, async () => {
    // Create a stream with some chunks, then we'll abort
    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: createSSEChunks([
        { data: `{"chunk": 1}` },
        { data: `{"chunk": 2}` },
        { data: `{"chunk": 3}` },
        // More chunks would come but we'll abort
        ...Array(50)
          .fill(0)
          .map((_, i) => ({ data: `{"chunk": ${i + 4}}` })),
      ]),
      chunkDelayMs: 50,
    })

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/chat`,
      body: {},
    })

    // Wait for some data to be written
    await new Promise((r) => setTimeout(r, 200))

    // Abort
    await abortStream({
      streamUrl: createResult.streamUrl!,
    })

    // Read what was written - should have some data
    const readResult = await readStream({
      streamUrl: createResult.streamUrl!,
      offset: `-1`,
    })

    expect(readResult.status).toBe(200)
    // Should have at least the first few chunks
    expect(readResult.body).toContain(`"chunk": 1`)
  })
})
