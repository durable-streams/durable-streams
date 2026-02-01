/**
 * Tests for the renewal endpoint and client auto-renewal functionality.
 *
 * POST /v1/proxy/renew
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
 * Helper to call the renew endpoint
 */
async function renewStream(options: {
  streamUrl: string
  upstreamUrl: string
  upstreamAuthHeader?: string
  secret?: string
}): Promise<{
  status: number
  streamUrl?: string
  body: unknown
  headers: Headers
}> {
  const url = new URL(`/v1/proxy/renew`, ctx.urls.proxy)
  url.searchParams.set(`secret`, options.secret ?? TEST_SECRET)

  const headers: Record<string, string> = {
    "Use-Stream-URL": options.streamUrl,
    "Upstream-URL": options.upstreamUrl,
  }

  if (options.upstreamAuthHeader) {
    headers[`Upstream-Authorization`] = options.upstreamAuthHeader
  }

  const response = await fetch(url.toString(), {
    method: `POST`,
    headers,
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

  if (locationHeader) {
    newStreamUrl = new URL(locationHeader, ctx.urls.proxy).toString()
  }

  return {
    status: response.status,
    streamUrl: newStreamUrl,
    body: responseBody,
    headers: response.headers,
  }
}

describe(`POST /v1/proxy/renew`, () => {
  it(`returns 200 with fresh URL when upstream returns 2xx`, async () => {
    const { streamUrl } = await createAndGetStreamUrl()

    // Set upstream to return 200 OK
    ctx.upstream.setResponse({ status: 200, body: `OK` })

    const result = await renewStream({
      streamUrl,
      upstreamUrl: ctx.urls.upstream + `/v1/renew`,
    })

    expect(result.status).toBe(200)
    expect(result.streamUrl).toBeDefined()
    // Fresh URL should have expires and signature
    const url = new URL(result.streamUrl!)
    expect(url.searchParams.get(`expires`)).toBeDefined()
    expect(url.searchParams.get(`signature`)).toBeDefined()
  })

  it(`returns 401 when upstream returns 4xx`, async () => {
    const { streamUrl } = await createAndGetStreamUrl()

    // Set upstream to return 401 Unauthorized
    ctx.upstream.setResponse({ status: 401, body: `Unauthorized` })

    const result = await renewStream({
      streamUrl,
      upstreamUrl: ctx.urls.upstream + `/v1/renew`,
    })

    expect(result.status).toBe(401)
    const body = result.body as { error: { code: string } }
    expect(body.error.code).toBe(`RENEWAL_REJECTED`)
  })

  it(`returns 401 when HMAC signature is invalid`, async () => {
    // Create a URL with invalid signature
    const fakeStreamUrl = `${ctx.urls.proxy}/v1/proxy/fake-stream-id?expires=9999999999&signature=invalid-signature`

    ctx.upstream.setResponse({ status: 200, body: `OK` })

    const result = await renewStream({
      streamUrl: fakeStreamUrl,
      upstreamUrl: ctx.urls.upstream + `/v1/renew`,
    })

    expect(result.status).toBe(401)
    const body = result.body as { error: { code: string } }
    expect(body.error.code).toBe(`SIGNATURE_INVALID`)
  })

  it(`returns 404 when stream does not exist`, async () => {
    // Generate a valid signed URL for a non-existent stream
    const nonExistentStreamId = `non-existent-stream-12345`
    const expiresAt = Math.floor(Date.now() / 1000) + 3600
    const streamUrl = generatePreSignedUrl(
      ctx.urls.proxy,
      nonExistentStreamId,
      TEST_SECRET,
      expiresAt
    )

    ctx.upstream.setResponse({ status: 200, body: `OK` })

    const result = await renewStream({
      streamUrl,
      upstreamUrl: ctx.urls.upstream + `/v1/renew`,
    })

    expect(result.status).toBe(404)
    const body = result.body as { error: { code: string } }
    expect(body.error.code).toBe(`STREAM_NOT_FOUND`)
  })

  it(`returns 400 when Use-Stream-URL header is missing`, async () => {
    const url = new URL(`/v1/proxy/renew`, ctx.urls.proxy)
    url.searchParams.set(`secret`, TEST_SECRET)

    const response = await fetch(url.toString(), {
      method: `POST`,
      headers: {
        "Upstream-URL": ctx.urls.upstream + `/v1/renew`,
      },
    })

    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error.code).toBe(`MISSING_USE_STREAM_URL`)
  })

  it(`returns 400 when Upstream-URL header is missing`, async () => {
    const { streamUrl } = await createAndGetStreamUrl()

    const url = new URL(`/v1/proxy/renew`, ctx.urls.proxy)
    url.searchParams.set(`secret`, TEST_SECRET)

    const response = await fetch(url.toString(), {
      method: `POST`,
      headers: {
        "Use-Stream-URL": streamUrl,
      },
    })

    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error.code).toBe(`MISSING_UPSTREAM_URL`)
  })

  it(`returns 401 when service secret is missing`, async () => {
    const { streamUrl } = await createAndGetStreamUrl()

    const url = new URL(`/v1/proxy/renew`, ctx.urls.proxy)
    // Note: no secret parameter

    const response = await fetch(url.toString(), {
      method: `POST`,
      headers: {
        "Use-Stream-URL": streamUrl,
        "Upstream-URL": ctx.urls.upstream + `/v1/renew`,
      },
    })

    expect(response.status).toBe(401)
    const body = await response.json()
    expect(body.error.code).toBe(`MISSING_SECRET`)
  })

  it(`respects Stream-Signed-URL-TTL header in generated URL`, async () => {
    const { streamUrl } = await createAndGetStreamUrl()

    ctx.upstream.setResponse({ status: 200, body: `OK` })

    const url = new URL(`/v1/proxy/renew`, ctx.urls.proxy)
    url.searchParams.set(`secret`, TEST_SECRET)

    const response = await fetch(url.toString(), {
      method: `POST`,
      headers: {
        "Use-Stream-URL": streamUrl,
        "Upstream-URL": ctx.urls.upstream + `/v1/renew`,
        "Stream-Signed-URL-TTL": `1800`, // 30 minutes
      },
    })

    expect(response.status).toBe(200)

    const locationHeader = response.headers.get(`Location`)
    expect(locationHeader).toBeDefined()

    const newUrl = new URL(locationHeader!, ctx.urls.proxy)
    const expires = parseInt(newUrl.searchParams.get(`expires`)!, 10)

    // Expires should be approximately now + 1800 seconds
    const expectedExpires = Math.floor(Date.now() / 1000) + 1800
    expect(expires).toBeGreaterThan(expectedExpires - 5)
    expect(expires).toBeLessThan(expectedExpires + 5)
  })
})

describe(`expired URL handling`, () => {
  it(`accepts expired HMAC for renewal (HMAC validation ignores expiry)`, async () => {
    // Create a stream
    const { streamId } = await createAndGetStreamUrl()

    // Generate an expired signed URL (expires in the past)
    const expiredAt = Math.floor(Date.now() / 1000) - 3600 // 1 hour ago
    const expiredStreamUrl = generatePreSignedUrl(
      ctx.urls.proxy,
      streamId,
      TEST_SECRET,
      expiredAt
    )

    ctx.upstream.setResponse({ status: 200, body: `OK` })

    const result = await renewStream({
      streamUrl: expiredStreamUrl,
      upstreamUrl: ctx.urls.upstream + `/v1/renew`,
    })

    // Should succeed - renew endpoint ignores expiry
    expect(result.status).toBe(200)
    expect(result.streamUrl).toBeDefined()
  })
})

describe(`upstream error scenarios`, () => {
  it(`returns 401 when upstream returns 403 Forbidden`, async () => {
    const { streamUrl } = await createAndGetStreamUrl()

    ctx.upstream.setResponse({ status: 403, body: `Forbidden` })

    const result = await renewStream({
      streamUrl,
      upstreamUrl: ctx.urls.upstream + `/v1/renew`,
    })

    expect(result.status).toBe(401)
    const body = result.body as { error: { code: string } }
    expect(body.error.code).toBe(`RENEWAL_REJECTED`)
  })

  it(`returns 401 when upstream returns 500 Internal Server Error`, async () => {
    const { streamUrl } = await createAndGetStreamUrl()

    ctx.upstream.setResponse({ status: 500, body: `Internal Server Error` })

    const result = await renewStream({
      streamUrl,
      upstreamUrl: ctx.urls.upstream + `/v1/renew`,
    })

    expect(result.status).toBe(401)
    const body = result.body as { error: { code: string } }
    expect(body.error.code).toBe(`RENEWAL_REJECTED`)
  })

  it(`forwards Upstream-Authorization header to upstream`, async () => {
    const { streamUrl } = await createAndGetStreamUrl()

    // Set up a custom handler to verify headers
    let receivedAuthHeader: string | undefined
    ctx.upstream.setHandler((req, res) => {
      receivedAuthHeader = req.headers.authorization
      res.writeHead(200)
      res.end(`OK`)
    })

    await renewStream({
      streamUrl,
      upstreamUrl: ctx.urls.upstream + `/v1/renew`,
      upstreamAuthHeader: `Bearer test-token`,
    })

    expect(receivedAuthHeader).toBe(`Bearer test-token`)
  })
})
