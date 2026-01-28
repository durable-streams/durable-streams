/**
 * Tests for aborting streams through the proxy.
 *
 * PATCH /v1/proxy/{service}/{stream_id}?action=abort&expires=...&signature=...
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
  it(`returns 401 when pre-signed URL is missing signature`, async () => {
    const url = new URL(`/v1/proxy/chat/some-stream-id`, ctx.urls.proxy)
    url.searchParams.set(`action`, `abort`)
    url.searchParams.set(
      `expires`,
      String(Math.floor(Date.now() / 1000) + 3600)
    )
    // Missing signature

    const response = await fetch(url.toString(), {
      method: `PATCH`,
    })

    expect(response.status).toBe(401)
  })

  it(`returns 401 when signature is invalid`, async () => {
    // First create a valid stream
    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: createSSEChunks([{ data: `test` }]),
      chunkDelayMs: 100,
    })

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      upstreamUrl: ctx.urls.upstream + `/v1/chat`,
      body: {},
    })

    expect(createResult.status).toBe(201)

    // Try to abort with invalid signature
    const url = new URL(
      `/v1/proxy/chat/${createResult.streamId}`,
      ctx.urls.proxy
    )
    url.searchParams.set(`action`, `abort`)
    url.searchParams.set(`expires`, createResult.expires!)
    url.searchParams.set(`signature`, `invalid-signature`)

    const response = await fetch(url.toString(), {
      method: `PATCH`,
    })

    expect(response.status).toBe(401)
  })

  it(`returns 204 for already completed streams (idempotent)`, async () => {
    // Create a stream that completes quickly
    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: `data: done\n\n`,
    })

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      upstreamUrl: ctx.urls.upstream + `/v1/chat`,
      body: {},
    })

    expect(createResult.status).toBe(201)

    // Wait for stream to complete
    await new Promise((r) => setTimeout(r, 100))

    // Abort should succeed idempotently with 204
    const result = await abortStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamId: createResult.streamId!,
      expires: createResult.expires!,
      signature: createResult.signature!,
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
      serviceName: `chat`,
      upstreamUrl: ctx.urls.upstream + `/v1/chat`,
      body: {},
    })

    expect(createResult.status).toBe(201)

    // Abort immediately
    const result = await abortStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamId: createResult.streamId!,
      expires: createResult.expires!,
      signature: createResult.signature!,
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
      serviceName: `chat`,
      upstreamUrl: ctx.urls.upstream + `/v1/chat`,
      body: {},
    })

    expect(createResult.status).toBe(201)

    // First abort
    const firstAbort = await abortStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamId: createResult.streamId!,
      expires: createResult.expires!,
      signature: createResult.signature!,
    })
    expect(firstAbort.status).toBe(204)

    // Second abort should also succeed with 204
    const secondAbort = await abortStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamId: createResult.streamId!,
      expires: createResult.expires!,
      signature: createResult.signature!,
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
      serviceName: `chat`,
      upstreamUrl: ctx.urls.upstream + `/v1/chat`,
      body: {},
    })

    expect(createResult.status).toBe(201)

    // Wait for some data to be written
    await new Promise((r) => setTimeout(r, 200))

    // Abort
    await abortStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamId: createResult.streamId!,
      expires: createResult.expires!,
      signature: createResult.signature!,
    })

    // Wait for abort to complete
    await new Promise((r) => setTimeout(r, 100))

    // Read what was written - should have some data
    const readResult = await readStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      streamId: createResult.streamId!,
      expires: createResult.expires!,
      signature: createResult.signature!,
      offset: `-1`,
    })

    expect(readResult.status).toBe(200)
    // Should have at least the first few chunks
    expect(readResult.body).toContain(`"chunk": 1`)
  })

  it(`returns 400 when action is not abort`, async () => {
    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: createSSEChunks([{ data: `test` }]),
    })

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      serviceName: `chat`,
      upstreamUrl: ctx.urls.upstream + `/v1/chat`,
      body: {},
    })

    expect(createResult.status).toBe(201)

    // Try PATCH with invalid action
    const url = new URL(
      `/v1/proxy/chat/${createResult.streamId}`,
      ctx.urls.proxy
    )
    url.searchParams.set(`action`, `invalid`)
    url.searchParams.set(`expires`, createResult.expires!)
    url.searchParams.set(`signature`, createResult.signature!)

    const response = await fetch(url.toString(), {
      method: `PATCH`,
    })

    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error.code).toBe(`INVALID_ACTION`)
  })
})
