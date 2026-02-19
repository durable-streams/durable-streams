import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createProxyStream, readProxyStream } from "../harness/client.js"
import {
  createMockUpstream,
  createSSEChunks,
} from "../harness/mock-upstream.js"
import { getRuntime } from "../runtime.js"
import type { MockUpstreamServer } from "../harness/mock-upstream.js"

let upstream: MockUpstreamServer

beforeAll(async () => {
  upstream = await createMockUpstream()
})

beforeEach(() => {
  upstream.reset()
})

afterAll(async () => {
  await upstream.stop()
})

describe(`proxy conformance: read extended`, () => {
  it(`returns 401 when no authentication is provided`, async () => {
    upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: createSSEChunks([{ data: `hello` }]),
    })
    const created = await createProxyStream({
      upstreamUrl: upstream.url + `/v1/chat`,
      body: {},
    })
    const streamId = new URL(created.streamUrl!).pathname.split(`/`).pop()!
    const url = new URL(
      `/v1/proxy/${streamId}`,
      new URL(created.streamUrl!).origin
    )
    url.searchParams.set(`offset`, `-1`)
    const response = await fetch(url.toString())
    expect(response.status).toBe(401)
    const body = (await response.json()) as { error?: { code?: string } }
    expect([`MISSING_SECRET`, `MISSING_SIGNATURE`]).toContain(body.error?.code)
  })

  it(`returns 401 when signature is invalid`, async () => {
    upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: createSSEChunks([{ data: `hello` }]),
    })
    const created = await createProxyStream({
      upstreamUrl: upstream.url + `/v1/chat`,
      body: {},
    })
    const url = new URL(created.streamUrl!)
    url.searchParams.set(`signature`, `invalid-signature`)
    url.searchParams.set(`offset`, `-1`)
    const response = await fetch(url.toString())
    expect(response.status).toBe(401)
  })

  it(`returns SIGNATURE_EXPIRED with streamId when URL is expired`, async () => {
    upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: createSSEChunks([{ data: `hello` }]),
    })
    const created = await createProxyStream({
      upstreamUrl: upstream.url + `/v1/chat`,
      headers: { "Stream-Signed-URL-TTL": `0` },
      body: {},
    })
    await new Promise((resolve) => setTimeout(resolve, 1100))

    const response = await readProxyStream({
      streamUrl: created.streamUrl!,
      offset: `-1`,
    })
    expect(response.status).toBe(401)
    const body = (await response.json()) as {
      error?: { code?: string; streamId?: string }
    }
    expect(body.error?.code).toBe(`SIGNATURE_EXPIRED`)
    expect(body.error?.streamId).toBe(created.streamId)
  })

  it(`supports reading from a specific offset`, async () => {
    upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: createSSEChunks([{ data: `a` }, { data: `b` }, { data: `c` }]),
      chunkDelayMs: 10,
    })
    const created = await createProxyStream({
      upstreamUrl: upstream.url + `/v1/chat`,
      body: {},
    })

    await new Promise((resolve) => setTimeout(resolve, 150))
    const first = await readProxyStream({
      streamUrl: created.streamUrl!,
      offset: `-1`,
    })
    expect(first.status).toBe(200)
    const nextOffset = first.headers.get(`Stream-Next-Offset`)
    expect(nextOffset).toBeTruthy()

    const second = await readProxyStream({
      streamUrl: created.streamUrl!,
      offset: nextOffset!,
    })
    expect(second.status).toBe(200)
  })

  it(`returns 404 STREAM_NOT_FOUND for non-existent stream with service auth`, async () => {
    const runtime = getRuntime()
    const url = runtime.adapter.streamUrl(
      runtime.getBaseUrl(),
      `00000000-0000-0000-0000-000000000000`
    )
    url.searchParams.set(`offset`, `-1`)
    const headers = new Headers()
    await runtime.adapter.applyServiceAuth(url, headers)
    const response = await fetch(url.toString(), { method: `GET`, headers })

    expect(response.status).toBe(404)
    const body = (await response.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe(`STREAM_NOT_FOUND`)
  })

  it(`includes CORS and exposed headers in read responses`, async () => {
    upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: createSSEChunks([{ data: `hello` }]),
    })
    const created = await createProxyStream({
      upstreamUrl: upstream.url + `/v1/chat`,
      body: {},
    })
    const read = await readProxyStream({
      streamUrl: created.streamUrl!,
      offset: `-1`,
    })
    expect(read.headers.get(`access-control-allow-origin`)).toBe(`*`)
    expect(read.headers.get(`access-control-expose-headers`)).toContain(
      `Stream-Next-Offset`
    )
  })
})
