/**
 * Tests for stream reuse functionality.
 *
 * Tests the Use-Stream-URL header support for appending to existing streams.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { generatePreSignedUrl } from "../server/tokens"
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

/**
 * Helper to create a stream and get the pre-signed URL
 */
async function createAndGetStreamUrl(): Promise<{
  streamUrl: string
  streamId: string
}> {
  ctx.upstream.setResponse(createAIStreamingResponse([`Hello`]))

  const result = await createStream({
    proxyUrl: ctx.urls.proxy,
    upstreamUrl: ctx.urls.upstream + `/v1/chat/completions`,
    body: { messages: [{ role: `user`, content: `Hello` }] },
  })

  expect(result.status).toBe(201)
  expect(result.streamUrl).toBeDefined()
  expect(result.streamId).toBeDefined()

  // Wait for stream to be ready
  await waitForStreamReady(ctx.urls.proxy, result.streamId!)

  return { streamUrl: result.streamUrl!, streamId: result.streamId! }
}

/**
 * Helper to make a request with Use-Stream-URL header
 */
async function createStreamWithReuse(
  streamUrl: string,
  options?: { ttl?: number }
): Promise<{
  status: number
  streamUrl?: string
  streamId?: string
  body: unknown
  headers: Headers
}> {
  ctx.upstream.setResponse(createAIStreamingResponse([` World`]))

  const url = new URL(`/v1/proxy`, ctx.urls.proxy)
  url.searchParams.set(`secret`, TEST_SECRET)

  const headers: Record<string, string> = {
    "Upstream-URL": ctx.urls.upstream + `/v1/chat/completions`,
    "Upstream-Method": `POST`,
    "Use-Stream-URL": streamUrl,
    "Content-Type": `application/json`,
  }

  if (options?.ttl !== undefined) {
    headers[`Stream-Signed-URL-TTL`] = String(options.ttl)
  }

  const response = await fetch(url.toString(), {
    method: `POST`,
    headers,
    body: JSON.stringify({ messages: [{ role: `user`, content: `Continue` }] }),
  })

  const contentType = response.headers.get(`content-type`) ?? ``
  let responseBody: unknown

  if (contentType.includes(`application/json`)) {
    responseBody = await response.json()
  } else {
    responseBody = await response.text()
  }

  const locationHeader = response.headers.get(`Location`)
  let newStreamUrl: string | undefined
  let streamId: string | undefined

  if (locationHeader) {
    newStreamUrl = new URL(locationHeader, ctx.urls.proxy).toString()
    const match = new URL(newStreamUrl).pathname.match(
      /\/v1\/proxy\/([^/]+)\/?$/
    )
    if (match) {
      streamId = decodeURIComponent(match[1]!)
    }
  }

  return {
    status: response.status,
    streamUrl: newStreamUrl,
    streamId,
    body: responseBody,
    headers: response.headers,
  }
}

describe(`stream reuse with Use-Stream-URL`, () => {
  it(`returns 200 OK when reusing existing stream`, async () => {
    const { streamUrl } = await createAndGetStreamUrl()

    const reuse = await createStreamWithReuse(streamUrl)

    expect(reuse.status).toBe(200)
    expect(reuse.headers.get(`Stream-Response-Id`)).toBe(`2`)
  })

  it(`returns fresh signed URL in Location header on reuse`, async () => {
    const { streamUrl, streamId } = await createAndGetStreamUrl()

    const reuse = await createStreamWithReuse(streamUrl)

    expect(reuse.status).toBe(200)
    expect(reuse.streamUrl).toBeDefined()
    // The returned URL should point to the same stream
    expect(reuse.streamId).toBe(streamId)
    // URL should have expires and signature params
    const url = new URL(reuse.streamUrl!)
    expect(url.searchParams.get(`expires`)).toBeDefined()
    expect(url.searchParams.get(`signature`)).toBeDefined()
  })

  it(`appends data to stream before it closes`, async () => {
    // Create a stream with slow chunks so it doesn't close immediately
    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: [
        `data: {"text": "Hello"}\n\n`,
        `data: {"text": " "}\n\n`,
        `data: {"text": "World"}\n\n`,
      ],
      chunkDelayMs: 500, // Slow enough to allow reuse before close
    })

    const result = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/chat/completions`,
      body: { messages: [{ role: `user`, content: `Hello` }] },
    })

    expect(result.status).toBe(201)
    const streamUrl = result.streamUrl!

    // Set up the next upstream response for reuse
    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: [`data: {"text": "Appended"}\n\n`],
      chunkDelayMs: 10,
    })

    // Immediately try to reuse the stream (before first request completes)
    const url = new URL(`/v1/proxy`, ctx.urls.proxy)
    url.searchParams.set(`secret`, TEST_SECRET)

    const response = await fetch(url.toString(), {
      method: `POST`,
      headers: {
        "Upstream-URL": ctx.urls.upstream + `/v1/chat/completions`,
        "Upstream-Method": `POST`,
        "Use-Stream-URL": streamUrl,
        "Content-Type": `application/json`,
      },
      body: JSON.stringify({
        messages: [{ role: `user`, content: `Continue` }],
      }),
    })

    // Should succeed with 200 (append to existing stream)
    expect(response.status).toBe(200)
    expect(response.headers.get(`Location`)).toBeDefined()
  })

  it(`returns 400 for malformed Use-Stream-URL`, async () => {
    const url = new URL(`/v1/proxy`, ctx.urls.proxy)
    url.searchParams.set(`secret`, TEST_SECRET)

    const response = await fetch(url.toString(), {
      method: `POST`,
      headers: {
        "Upstream-URL": ctx.urls.upstream + `/v1/chat/completions`,
        "Upstream-Method": `POST`,
        "Use-Stream-URL": `not-a-valid-url`,
        "Content-Type": `application/json`,
      },
      body: JSON.stringify({}),
    })

    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error.code).toBe(`MALFORMED_STREAM_URL`)
  })

  it(`returns 401 for invalid HMAC signature`, async () => {
    const url = new URL(`/v1/proxy`, ctx.urls.proxy)
    url.searchParams.set(`secret`, TEST_SECRET)

    // Create a URL with invalid signature
    const fakeStreamUrl = `${ctx.urls.proxy}/v1/proxy/fake-stream-id?expires=9999999999&signature=invalid-signature`

    const response = await fetch(url.toString(), {
      method: `POST`,
      headers: {
        "Upstream-URL": ctx.urls.upstream + `/v1/chat/completions`,
        "Upstream-Method": `POST`,
        "Use-Stream-URL": fakeStreamUrl,
        "Content-Type": `application/json`,
      },
      body: JSON.stringify({}),
    })

    expect(response.status).toBe(401)
    const body = await response.json()
    expect(body.error.code).toBe(`SIGNATURE_INVALID`)
  })

  it(`returns 404 for non-existent stream`, async () => {
    // Generate a valid signed URL for a non-existent stream
    const nonExistentStreamId = `non-existent-stream-12345`
    const expiresAt = Math.floor(Date.now() / 1000) + 3600
    const nonExistentStreamUrl = generatePreSignedUrl(
      ctx.urls.proxy,
      nonExistentStreamId,
      TEST_SECRET,
      expiresAt
    )

    // Set up upstream to respond (though we shouldn't reach it)
    ctx.upstream.setResponse(createAIStreamingResponse([`Hello`]))

    // Try to reuse a non-existent stream
    const url = new URL(`/v1/proxy`, ctx.urls.proxy)
    url.searchParams.set(`secret`, TEST_SECRET)

    const response = await fetch(url.toString(), {
      method: `POST`,
      headers: {
        "Upstream-URL": ctx.urls.upstream + `/v1/chat/completions`,
        "Upstream-Method": `POST`,
        "Content-Type": `application/json`,
        "Use-Stream-URL": nonExistentStreamUrl,
      },
      body: JSON.stringify({}),
    })

    expect(response.status).toBe(404)
    const body = await response.json()
    expect(body.error.code).toBe(`STREAM_NOT_FOUND`)
  })
})

describe(`Stream-Signed-URL-TTL header`, () => {
  it(`respects Stream-Signed-URL-TTL in generated URLs`, async () => {
    ctx.upstream.setResponse(createAIStreamingResponse([`Hello`]))

    const url = new URL(`/v1/proxy`, ctx.urls.proxy)
    url.searchParams.set(`secret`, TEST_SECRET)

    const response = await fetch(url.toString(), {
      method: `POST`,
      headers: {
        "Upstream-URL": ctx.urls.upstream + `/v1/chat/completions`,
        "Upstream-Method": `POST`,
        "Stream-Signed-URL-TTL": `3600`, // 1 hour
        "Content-Type": `application/json`,
      },
      body: JSON.stringify({}),
    })

    expect(response.status).toBe(201)

    const locationHeader = response.headers.get(`Location`)
    expect(locationHeader).toBeDefined()

    const streamUrl = new URL(locationHeader!, ctx.urls.proxy)
    const expires = parseInt(streamUrl.searchParams.get(`expires`)!, 10)

    // Expires should be approximately now + 3600 seconds
    const expectedExpires = Math.floor(Date.now() / 1000) + 3600
    expect(expires).toBeGreaterThan(expectedExpires - 5)
    expect(expires).toBeLessThan(expectedExpires + 5)
  })

  it(`respects Stream-Signed-URL-TTL on stream reuse`, async () => {
    const { streamUrl } = await createAndGetStreamUrl()

    const reuse = await createStreamWithReuse(streamUrl, { ttl: 1800 }) // 30 minutes

    expect(reuse.status).toBe(200)
    expect(reuse.streamUrl).toBeDefined()

    const newUrl = new URL(reuse.streamUrl!)
    const expires = parseInt(newUrl.searchParams.get(`expires`)!, 10)

    // Expires should be approximately now + 1800 seconds
    const expectedExpires = Math.floor(Date.now() / 1000) + 1800
    expect(expires).toBeGreaterThan(expectedExpires - 5)
    expect(expires).toBeLessThan(expectedExpires + 5)
  })
})

describe(`reuse after completed response`, () => {
  it(`allows append to stream after a prior response completed`, async () => {
    // Create a stream with regular response
    ctx.upstream.setResponse(createAIStreamingResponse([`Hello`]))

    const result = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/chat/completions`,
      body: {},
    })

    expect(result.status).toBe(201)
    await waitForStreamReady(ctx.urls.proxy, result.streamId!)

    // Wait for the response to complete.
    await new Promise((r) => setTimeout(r, 500))

    // Reuse the same stream again.
    ctx.upstream.setResponse(createAIStreamingResponse([` World`]))

    const url = new URL(`/v1/proxy`, ctx.urls.proxy)
    url.searchParams.set(`secret`, TEST_SECRET)

    const response = await fetch(url.toString(), {
      method: `POST`,
      headers: {
        "Upstream-URL": ctx.urls.upstream + `/v1/chat/completions`,
        "Upstream-Method": `POST`,
        "Use-Stream-URL": result.streamUrl!,
        "Content-Type": `application/json`,
      },
      body: JSON.stringify({}),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get(`Location`)).toBeDefined()
  })
})

describe(`mixed session and non-session requests`, () => {
  it(`first request without Use-Stream-URL creates new stream (201)`, async () => {
    ctx.upstream.setResponse(createAIStreamingResponse([`Hello`]))

    const result = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/chat/completions`,
      body: {},
    })

    expect(result.status).toBe(201)
    expect(result.streamUrl).toBeDefined()
  })

  it(`subsequent request with Use-Stream-URL appends (200)`, async () => {
    const { streamUrl } = await createAndGetStreamUrl()

    const reuse = await createStreamWithReuse(streamUrl)

    expect(reuse.status).toBe(200)
    expect(reuse.streamUrl).toBeDefined()
  })

  it(`request without Use-Stream-URL after reuse creates new stream`, async () => {
    const { streamUrl } = await createAndGetStreamUrl()

    // Reuse existing stream
    const reuse = await createStreamWithReuse(streamUrl)
    expect(reuse.status).toBe(200)

    // Create a new stream without Use-Stream-URL
    ctx.upstream.setResponse(createAIStreamingResponse([`New stream`]))

    const newResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/chat/completions`,
      body: {},
    })

    expect(newResult.status).toBe(201)
    expect(newResult.streamId).not.toBe(reuse.streamId)
  })
})
