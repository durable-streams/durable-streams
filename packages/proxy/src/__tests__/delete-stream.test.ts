/**
 * Tests for deleting streams through the proxy.
 *
 * DELETE /v1/proxy/:streamId?secret=...
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  createAIStreamingResponse,
  createSSEChunks,
  createStream,
  createTestContext,
  deleteStream,
  headStream,
  readStream,
  waitFor,
} from "./harness"

const ctx = createTestContext()

beforeAll(async () => {
  await ctx.setup()
})

afterAll(async () => {
  await ctx.teardown()
})

describe(`stream deletion`, () => {
  it(`returns 401 when secret is missing`, async () => {
    const url = new URL(`/v1/proxy/some-stream-id`, ctx.urls.proxy)

    const response = await fetch(url.toString(), {
      method: `DELETE`,
    })

    expect(response.status).toBe(401)
  })

  it(`returns 401 when secret is invalid`, async () => {
    const result = await deleteStream({
      proxyUrl: ctx.urls.proxy,
      streamId: `some-stream-id`,
      secret: `wrong-secret`,
    })

    expect(result.status).toBe(401)
  })

  it(`returns 204 for existing stream`, async () => {
    ctx.upstream.setResponse(createAIStreamingResponse([`Hello`]))

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/chat/completions`,
      body: {},
    })

    expect(createResult.status).toBe(201)
    expect(createResult.streamId).toBeDefined()

    // Wait for data to be piped
    await waitFor(async () => {
      const r = await headStream({
        proxyUrl: ctx.urls.proxy,
        streamId: createResult.streamId!,
      })
      return r.status === 200
    })

    const result = await deleteStream({
      proxyUrl: ctx.urls.proxy,
      streamId: createResult.streamId!,
    })

    expect(result.status).toBe(204)
  })

  it(`is idempotent - deleting non-existent stream returns 204`, async () => {
    const result = await deleteStream({
      proxyUrl: ctx.urls.proxy,
      streamId: `00000000-0000-0000-0000-000000000000`,
    })

    expect(result.status).toBe(204)
  })

  it(`stream is not readable after deletion`, async () => {
    ctx.upstream.setResponse(createAIStreamingResponse([`Data`]))

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/chat/completions`,
      body: {},
    })

    expect(createResult.streamId).toBeDefined()

    // Wait for data to be piped
    await waitFor(async () => {
      const r = await headStream({
        proxyUrl: ctx.urls.proxy,
        streamId: createResult.streamId!,
      })
      return r.status === 200
    })

    // Delete the stream
    const deleteResult = await deleteStream({
      proxyUrl: ctx.urls.proxy,
      streamId: createResult.streamId!,
    })
    expect(deleteResult.status).toBe(204)

    // Attempt to read should fail (404 from underlying durable stream)
    const readResult = await readStream({
      streamUrl: createResult.streamUrl!,
    })

    expect(readResult.status).toBe(404)
  })

  it(`aborts in-flight upstream when deleting`, async () => {
    // Create a slow stream
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

    expect(createResult.streamId).toBeDefined()

    // Delete while still streaming
    const result = await deleteStream({
      proxyUrl: ctx.urls.proxy,
      streamId: createResult.streamId!,
    })

    expect(result.status).toBe(204)
  })
})
