/**
 * Tests for URL-path based stream reuse functionality.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  createAIStreamingResponse,
  createStream,
  createTestContext,
  waitForStreamReady,
} from "./harness"

const ctx = createTestContext()
const TEST_SECRET = `test-secret-key-for-development`

beforeAll(async () => {
  await ctx.setup()
})

afterAll(async () => {
  await ctx.teardown()
})

async function appendToStream(
  streamId: string,
  options?: { ttl?: number }
): Promise<Response> {
  const url = new URL(
    `/v1/proxy/${encodeURIComponent(streamId)}`,
    ctx.urls.proxy
  )
  url.searchParams.set(`secret`, TEST_SECRET)

  const headers: Record<string, string> = {
    "Upstream-URL": ctx.urls.upstream + `/v1/chat/completions`,
    "Upstream-Method": `POST`,
    "Content-Type": `application/json`,
  }
  if (options?.ttl !== undefined) {
    headers[`Stream-Signed-URL-TTL`] = String(options.ttl)
  }

  return fetch(url.toString(), {
    method: `POST`,
    headers,
    body: JSON.stringify({ messages: [{ role: `user`, content: `Continue` }] }),
  })
}

describe(`POST /v1/proxy/:streamId create-or-append`, () => {
  it(`returns 200 when appending to an existing stream`, async () => {
    ctx.upstream.setResponse(createAIStreamingResponse([`Hello`]))
    const created = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/chat/completions`,
      body: {},
    })
    expect(created.status).toBe(201)
    await waitForStreamReady(ctx.urls.proxy, created.streamId!)

    ctx.upstream.setResponse(createAIStreamingResponse([` World`]))
    const appended = await appendToStream(created.streamId!)

    expect(appended.status).toBe(200)
    expect(appended.headers.get(`Stream-Response-Id`)).toBe(`2`)
    expect(appended.headers.get(`Stream-Id`)).toBe(created.streamId)
  })

  it(`returns 201 and creates stream when streamId does not exist`, async () => {
    const streamId = `created-via-path-${Date.now()}`
    ctx.upstream.setResponse(createAIStreamingResponse([`Hello`]))

    const response = await appendToStream(streamId)

    expect(response.status).toBe(201)
    expect(response.headers.get(`Stream-Id`)).toBe(streamId)
    expect(response.headers.get(`Location`)).toBeTruthy()
  })

  it(`respects Stream-Signed-URL-TTL when appending`, async () => {
    const streamId = `ttl-via-path-${Date.now()}`
    ctx.upstream.setResponse(createAIStreamingResponse([`Hello`]))
    const created = await appendToStream(streamId)
    expect(created.status).toBe(201)

    ctx.upstream.setResponse(createAIStreamingResponse([` World`]))
    const appended = await appendToStream(streamId, { ttl: 1800 })
    expect(appended.status).toBe(200)

    const locationHeader = appended.headers.get(`Location`)
    expect(locationHeader).toBeTruthy()
    const streamUrl = new URL(locationHeader!, ctx.urls.proxy)
    const expires = parseInt(streamUrl.searchParams.get(`expires`) ?? `0`, 10)
    const expectedExpires = Math.floor(Date.now() / 1000) + 1800
    expect(expires).toBeGreaterThan(expectedExpires - 5)
    expect(expires).toBeLessThan(expectedExpires + 5)
  })
})

describe(`strict action dispatch`, () => {
  it(`returns INVALID_ACTION for POST /v1/proxy?action=connect`, async () => {
    const url = new URL(`/v1/proxy`, ctx.urls.proxy)
    url.searchParams.set(`secret`, TEST_SECRET)
    url.searchParams.set(`action`, `connect`)
    url.searchParams.set(`streamId`, `ignored`)

    const response = await fetch(url.toString(), { method: `POST` })

    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error.code).toBe(`INVALID_ACTION`)
  })

  it(`does not treat Session-Id header as connect on POST /v1/proxy`, async () => {
    const url = new URL(`/v1/proxy`, ctx.urls.proxy)
    url.searchParams.set(`secret`, TEST_SECRET)

    const response = await fetch(url.toString(), {
      method: `POST`,
      headers: {
        "Session-Id": `legacy-session-id`,
      },
    })

    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error.code).toBe(`MISSING_UPSTREAM_URL`)
  })
})
