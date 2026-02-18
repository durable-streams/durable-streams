/**
 * Tests for HEAD stream metadata through the proxy.
 *
 * HEAD /v1/proxy/:streamId?secret=...
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { handleHeadStream } from "../src/server/head-stream"
import {
  createAIStreamingResponse,
  createStream,
  createTestContext,
  headStream,
  waitForStreamReady,
} from "./harness"
import type { IncomingMessage, ServerResponse } from "node:http"

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

  it(`returns 502 when durable storage HEAD fails`, async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(`upstream error`, { status: 503 })
    })
    vi.stubGlobal(`fetch`, fetchMock)

    const req = {
      url: `/v1/proxy/failed-metadata?secret=test-secret-key-for-development`,
      headers: { host: `proxy.test` },
      method: `HEAD`,
    } as unknown as IncomingMessage

    const written = {
      status: 0,
      body: ``,
      headers: {} as Record<string, string>,
    }
    const res = {
      headersSent: false,
      writeHead(status: number, headers: Record<string, string>) {
        written.status = status
        written.headers = headers
        return undefined
      },
      end(body?: string) {
        written.body = body ?? ``
        return undefined
      },
    } as unknown as ServerResponse

    await handleHeadStream(
      req,
      res,
      `failed-metadata`,
      {
        durableStreamsUrl: `http://durable.example`,
        jwtSecret: `test-secret-key-for-development`,
      },
      new Map()
    )

    expect(written.status).toBe(502)
    expect(written.body).toContain(`STORAGE_ERROR`)
    vi.unstubAllGlobals()
  })
})
