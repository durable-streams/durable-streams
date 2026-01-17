/**
 * Tests for aborting streams through the proxy.
 *
 * POST /v1/proxy/{service}/streams/{key}/abort
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
  it(`returns 401 when no authorization header is provided`, async () => {
    const url = new URL(`/v1/proxy/chat/streams/some-key/abort`, ctx.urls.proxy)

    const response = await fetch(url.toString(), {
      method: `POST`,
    })

    expect(response.status).toBe(401)
    const body = await response.json()
    expect(body.error.code).toBe(`MISSING_TOKEN`)
  })

  it(`returns 401 when token is invalid`, async () => {
    const result = await abortStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamKey: `some-key`,
      readToken: `invalid-token`,
    })

    expect(result.status).toBe(401)
  })

  it(`returns 200 for already completed streams (idempotent)`, async () => {
    const streamKey = `abort-completed-${Date.now()}`

    // Create a stream that completes quickly
    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: `data: done\n\n`,
    })

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamKey,
      upstreamUrl: ctx.urls.upstream + `/v1/chat`,
      body: {},
    })

    // Wait for stream to complete
    await new Promise((r) => setTimeout(r, 100))

    // Abort should succeed idempotently
    const result = await abortStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamKey,
      readToken: createResult.readToken!,
    })

    expect(result.status).toBe(200)
    expect((result.body as { status: string }).status).toMatch(
      /already_completed|already_aborted/
    )
  })

  it(`returns 200 when aborting an in-progress stream`, async () => {
    const streamKey = `abort-progress-${Date.now()}`

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
      serviceName: `chat`,
      streamKey,
      upstreamUrl: ctx.urls.upstream + `/v1/chat`,
      body: {},
    })

    // Abort immediately
    const result = await abortStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamKey,
      readToken: createResult.readToken!,
    })

    expect(result.status).toBe(200)
    expect((result.body as { status: string }).status).toBe(`aborted`)
  })

  it(`is idempotent - multiple aborts return 200`, async () => {
    const streamKey = `abort-idempotent-${Date.now()}`

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
      serviceName: `chat`,
      streamKey,
      upstreamUrl: ctx.urls.upstream + `/v1/chat`,
      body: {},
    })

    // First abort
    const firstAbort = await abortStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamKey,
      readToken: createResult.readToken!,
    })
    expect(firstAbort.status).toBe(200)

    // Second abort should also succeed
    const secondAbort = await abortStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamKey,
      readToken: createResult.readToken!,
    })
    expect(secondAbort.status).toBe(200)
    expect((secondAbort.body as { status: string }).status).toBe(
      `already_aborted`
    )
  })

  it(`preserves data written before abort`, async () => {
    const streamKey = `abort-preserve-${Date.now()}`

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
      serviceName: `chat`,
      streamKey,
      upstreamUrl: ctx.urls.upstream + `/v1/chat`,
      body: {},
    })

    // Wait for some data to be written
    await new Promise((r) => setTimeout(r, 200))

    // Abort
    await abortStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamKey,
      readToken: createResult.readToken!,
    })

    // Read what was written - should have some data
    const readResult = await readStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamKey,
      readToken: createResult.readToken!,
      offset: `-1`,
    })

    expect(readResult.status).toBe(200)
    // Should have at least the first few chunks
    expect(readResult.body).toContain(`"chunk": 1`)
  })
})
