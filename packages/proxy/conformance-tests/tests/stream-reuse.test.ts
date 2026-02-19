import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createProxyStream, waitFor } from "../harness/client.js"
import {
  createAIStreamingResponse,
  createMockUpstream,
} from "../harness/mock-upstream.js"
import { getRuntime } from "../runtime.js"
import type { MockUpstreamServer } from "../harness/mock-upstream.js"

let upstream: MockUpstreamServer

async function appendToStream(
  streamId: string,
  upstreamUrl: string,
  ttl?: number
): Promise<Response> {
  const runtime = getRuntime()
  const url = runtime.adapter.streamUrl(runtime.getBaseUrl(), streamId)
  const headers = new Headers({
    "Upstream-URL": upstreamUrl,
    "Upstream-Method": `POST`,
    "Content-Type": `application/json`,
  })
  if (ttl !== undefined) {
    headers.set(`Stream-Signed-URL-TTL`, String(ttl))
  }
  await runtime.adapter.applyServiceAuth(url, headers)
  return fetch(url.toString(), {
    method: `POST`,
    headers,
    body: JSON.stringify({ messages: [{ role: `user`, content: `Continue` }] }),
  })
}

beforeAll(async () => {
  upstream = await createMockUpstream()
})

beforeEach(() => {
  upstream.reset()
})

afterAll(async () => {
  await upstream.stop()
})

describe(`proxy conformance: stream reuse`, () => {
  it(`returns 200 when appending to an existing stream`, async () => {
    upstream.setResponse(createAIStreamingResponse([`Hello`]))
    const created = await createProxyStream({
      upstreamUrl: upstream.url + `/v1/chat`,
      body: {},
    })
    expect(created.status).toBe(201)
    await waitFor(() => Boolean(created.streamId))

    upstream.setResponse(createAIStreamingResponse([` World`]))
    const appended = await appendToStream(
      created.streamId!,
      upstream.url + `/v1/chat`
    )
    expect(appended.status).toBe(200)
    expect(appended.headers.get(`Stream-Response-Id`)).toBe(`2`)
  })

  it(`returns 201 and creates stream when streamId does not exist`, async () => {
    const streamId = `created-via-path-${Date.now()}`
    upstream.setResponse(createAIStreamingResponse([`Hello`]))
    const response = await appendToStream(streamId, upstream.url + `/v1/chat`)
    expect(response.status).toBe(201)
    expect(response.headers.get(`Location`)).toBeTruthy()
  })

  it(`respects Stream-Signed-URL-TTL when appending`, async () => {
    const streamId = `ttl-via-path-${Date.now()}`
    upstream.setResponse(createAIStreamingResponse([`Hello`]))
    const created = await appendToStream(streamId, upstream.url + `/v1/chat`)
    expect(created.status).toBe(201)

    upstream.setResponse(createAIStreamingResponse([`World`]))
    const appended = await appendToStream(
      streamId,
      upstream.url + `/v1/chat`,
      1800
    )
    expect(appended.status).toBe(200)
    const locationHeader = appended.headers.get(`Location`)
    expect(locationHeader).toBeTruthy()
    const streamUrl = new URL(locationHeader!, getRuntime().getBaseUrl())
    const expires = parseInt(streamUrl.searchParams.get(`expires`) ?? `0`, 10)
    const expectedExpires = Math.floor(Date.now() / 1000) + 1800
    expect(expires).toBeGreaterThan(expectedExpires - 5)
    expect(expires).toBeLessThan(expectedExpires + 5)
  })
})
