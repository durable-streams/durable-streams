/**
 * Tests for HEAD stream metadata through the proxy.
 *
 * HEAD /v1/proxy/:streamId?secret=...
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  createAIStreamingResponse,
  createStream,
  createTestContext,
  headStream,
  waitForStreamReady,
} from "./harness"

const ctx = createTestContext()

beforeAll(async () => {
  await ctx.setup()
})

afterAll(async () => {
  await ctx.teardown()
})

describe(`stream HEAD metadata`, () => {
  it(`returns 401 when secret is missing`, async () => {
    const url = new URL(`/v1/proxy/some-stream-id`, ctx.urls.proxy)

    const response = await fetch(url.toString(), {
      method: `HEAD`,
    })

    expect(response.status).toBe(401)
  })

  it(`returns 401 when secret is invalid`, async () => {
    const result = await headStream({
      proxyUrl: ctx.urls.proxy,
      streamId: `some-stream-id`,
      secret: `wrong-secret`,
    })

    expect(result.status).toBe(401)
  })

  it(`returns 404 for non-existent stream`, async () => {
    const result = await headStream({
      proxyUrl: ctx.urls.proxy,
      streamId: `00000000-0000-0000-0000-000000000000`,
    })

    expect(result.status).toBe(404)
  })

  it(`returns 200 with metadata headers for existing stream`, async () => {
    ctx.upstream.setResponse(createAIStreamingResponse([`Hello`]))

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/chat/completions`,
      body: {},
    })

    expect(createResult.status).toBe(201)
    expect(createResult.streamId).toBeDefined()

    await waitForStreamReady(ctx.urls.proxy, createResult.streamId!)

    const result = await headStream({
      proxyUrl: ctx.urls.proxy,
      streamId: createResult.streamId!,
    })

    expect(result.status).toBe(200)
    expect(result.headers.get(`Access-Control-Allow-Origin`)).toBe(`*`)
  })

  it(`returns Upstream-Content-Type header`, async () => {
    ctx.upstream.setResponse(createAIStreamingResponse([`Test`]))

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/chat/completions`,
      body: {},
    })

    expect(createResult.streamId).toBeDefined()

    await waitForStreamReady(ctx.urls.proxy, createResult.streamId!)

    const result = await headStream({
      proxyUrl: ctx.urls.proxy,
      streamId: createResult.streamId!,
    })

    expect(result.status).toBe(200)
    expect(result.headers.get(`Upstream-Content-Type`)).toContain(
      `text/event-stream`
    )
  })
})
