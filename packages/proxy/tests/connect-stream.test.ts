/**
 * Tests for the connect operation.
 *
 * POST /v1/proxy/:streamId?action=connect
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createTestContext } from "./harness"

const ctx = createTestContext()

const TEST_SECRET = `test-secret-key-for-development`

beforeAll(async () => {
  await ctx.setup()
})

afterAll(async () => {
  await ctx.teardown()
})

/**
 * Helper to POST a connect request.
 */
async function connectSession(options: {
  streamId: string
  upstreamUrl?: string
  body?: string
  headers?: Record<string, string>
  secret?: string
}): Promise<{
  status: number
  streamUrl?: string
  streamId?: string
  body: string
  headers: Headers
}> {
  const url = new URL(
    `/v1/proxy/${encodeURIComponent(options.streamId)}`,
    ctx.urls.proxy
  )
  url.searchParams.set(`secret`, options.secret ?? TEST_SECRET)
  url.searchParams.set(`action`, `connect`)

  const requestHeaders: Record<string, string> = {
    ...options.headers,
  }
  if (options.upstreamUrl) {
    requestHeaders[`Upstream-URL`] = options.upstreamUrl
  }

  const response = await fetch(url.toString(), {
    method: `POST`,
    headers: requestHeaders,
    body: options.body,
  })

  const body = await response.text()

  const locationHeader = response.headers.get(`Location`)
  let streamUrl: string | undefined
  let streamId: string | undefined

  if (locationHeader) {
    streamUrl = new URL(locationHeader, ctx.urls.proxy).toString()
    const match = new URL(streamUrl).pathname.match(/\/v1\/proxy\/([^/]+)\/?$/)
    if (match) {
      streamId = decodeURIComponent(match[1]!)
    }
  }

  return {
    status: response.status,
    streamUrl,
    streamId,
    body,
    headers: response.headers,
  }
}

describe(`POST /v1/proxy/:streamId?action=connect`, () => {
  it(`creates a new session and returns 201 with empty body`, async () => {
    ctx.upstream.setResponse({
      status: 200,
      headers: { "Content-Type": `application/json` },
      body: JSON.stringify({
        messages: [{ role: `assistant`, content: `Hi` }],
      }),
    })

    const result = await connectSession({
      streamId: `session-new-1`,
      upstreamUrl: ctx.urls.upstream + `/connect`,
    })

    expect(result.status).toBe(201)
    expect(result.streamUrl).toBeDefined()
    expect(result.streamId).toBeDefined()
    expect(result.body).toBe(``)
  })

  it(`reconnects to existing session and returns 200`, async () => {
    const streamId = `session-reconnect-1`

    // First connect - creates the session
    ctx.upstream.setResponse({
      status: 200,
      headers: { "Content-Type": `application/json` },
      body: JSON.stringify({ messages: [] }),
    })

    const first = await connectSession({
      streamId,
      upstreamUrl: ctx.urls.upstream + `/connect`,
    })
    expect(first.status).toBe(201)

    // Second connect - reconnects
    ctx.upstream.setResponse({
      status: 200,
      headers: { "Content-Type": `application/json` },
      body: JSON.stringify({ messages: [`msg1`] }),
    })

    const second = await connectSession({
      streamId,
      upstreamUrl: ctx.urls.upstream + `/connect`,
    })
    expect(second.status).toBe(200)
    expect(second.streamId).toBe(first.streamId)
  })

  it(`works without Upstream-URL (service-auth-only mode)`, async () => {
    const result = await connectSession({
      streamId: `session-no-upstream-url`,
    })

    expect(result.status).toBe(201)
    expect(result.streamUrl).toBeDefined()
    expect(result.streamId).toBeDefined()
    expect(result.body).toBe(``)
  })

  it(`forwards Stream-Id header to connect handler`, async () => {
    const streamId = `session-forward-id`

    let receivedStreamId: string | undefined
    ctx.upstream.setHandler((req, res) => {
      receivedStreamId = req.headers[`stream-id`] as string
      res.writeHead(200, { "Content-Type": `application/json` })
      res.end(JSON.stringify({ ok: true }))
    })

    await connectSession({
      streamId,
      upstreamUrl: ctx.urls.upstream + `/connect`,
    })

    expect(receivedStreamId).toBe(streamId)
  })

  it(`returns fresh signed URL in Location header`, async () => {
    ctx.upstream.setResponse({
      status: 200,
      headers: { "Content-Type": `application/json` },
      body: JSON.stringify({}),
    })

    const result = await connectSession({
      streamId: `session-signed-url-1`,
      upstreamUrl: ctx.urls.upstream + `/connect`,
    })

    expect(result.streamUrl).toBeDefined()
    const url = new URL(result.streamUrl!)
    expect(url.searchParams.get(`expires`)).toBeDefined()
    expect(url.searchParams.get(`signature`)).toBeDefined()
  })

  it(`preserves passthrough query params in connect Location URL`, async () => {
    const streamId = `session-passthrough-1`
    const url = new URL(`/v1/proxy/${streamId}`, ctx.urls.proxy)
    url.searchParams.set(`secret`, TEST_SECRET)
    url.searchParams.set(`action`, `connect`)
    url.searchParams.set(`offset`, `4096`)
    url.searchParams.set(`live`, `sse`)

    const response = await fetch(url.toString(), { method: `POST` })
    expect([200, 201]).toContain(response.status)

    const location = response.headers.get(`Location`)
    expect(location).toBeTruthy()
    const locationUrl = new URL(location!, ctx.urls.proxy)
    expect(locationUrl.searchParams.get(`offset`)).toBe(`4096`)
    expect(locationUrl.searchParams.get(`live`)).toBe(`sse`)
    expect(locationUrl.searchParams.get(`expires`)).toBeTruthy()
    expect(locationUrl.searchParams.get(`signature`)).toBeTruthy()
  })

  it(`forwards connect handler rejection to client`, async () => {
    ctx.upstream.setResponse({
      status: 403,
      headers: { "Content-Type": `application/json` },
      body: JSON.stringify({ error: `Forbidden` }),
    })

    const result = await connectSession({
      streamId: `session-rejected-1`,
      upstreamUrl: ctx.urls.upstream + `/connect`,
    })

    expect(result.status).toBe(401)
    const parsed = JSON.parse(result.body) as { error: { code: string } }
    expect(parsed.error.code).toBe(`CONNECT_REJECTED`)
  })

  it(`does not return upstream response headers on connect`, async () => {
    const result = await connectSession({
      streamId: `session-connect-headers-only`,
    })

    expect([200, 201]).toContain(result.status)
    expect(result.headers.get(`Location`)).toBeTruthy()
    expect(result.headers.get(`Upstream-Content-Type`)).toBeNull()
    expect(result.headers.get(`Stream-Response-Id`)).toBeNull()
  })

  it(`returns 400 when action is invalid`, async () => {
    const url = new URL(`/v1/proxy/session-invalid-action`, ctx.urls.proxy)
    url.searchParams.set(`secret`, TEST_SECRET)
    url.searchParams.set(`action`, `invalid`)

    const response = await fetch(url.toString(), {
      method: `POST`,
    })

    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error.code).toBe(`INVALID_ACTION`)
  })

  it(`returns 401 when service secret is missing`, async () => {
    const url = new URL(`/v1/proxy/session-no-secret`, ctx.urls.proxy)
    url.searchParams.set(`action`, `connect`)
    // No secret parameter

    const response = await fetch(url.toString(), {
      method: `POST`,
      headers: { "Upstream-URL": ctx.urls.upstream + `/connect` },
    })

    expect(response.status).toBe(401)
    const body = await response.json()
    expect(body.error.code).toBe(`MISSING_SECRET`)
  })

  it(`respects Stream-Signed-URL-TTL header`, async () => {
    ctx.upstream.setResponse({
      status: 200,
      headers: { "Content-Type": `application/json` },
      body: JSON.stringify({}),
    })

    const result = await connectSession({
      streamId: `session-ttl-1`,
      upstreamUrl: ctx.urls.upstream + `/connect`,
      headers: {
        "Stream-Signed-URL-TTL": `1800`,
      },
    })

    expect(result.status).toBe(201)
    const url = new URL(result.streamUrl!)
    const expires = parseInt(url.searchParams.get(`expires`)!, 10)
    const expectedExpires = Math.floor(Date.now() / 1000) + 1800
    expect(expires).toBeGreaterThan(expectedExpires - 5)
    expect(expires).toBeLessThan(expectedExpires + 5)
  })

  it(`forwards client auth headers to connect handler`, async () => {
    let receivedAuthHeader: string | undefined
    ctx.upstream.setHandler((req, res) => {
      receivedAuthHeader = req.headers.authorization
      res.writeHead(200, { "Content-Type": `application/json` })
      res.end(JSON.stringify({ ok: true }))
    })

    await connectSession({
      streamId: `session-auth-1`,
      upstreamUrl: ctx.urls.upstream + `/connect`,
      headers: {
        "Upstream-Authorization": `Bearer user-token-123`,
      },
    })

    expect(receivedAuthHeader).toBe(`Bearer user-token-123`)
  })

  it(`dispatches by URL path even when legacy headers are present`, async () => {
    const url = new URL(`/v1/proxy/session-dispatch-test`, ctx.urls.proxy)
    url.searchParams.set(`secret`, TEST_SECRET)
    url.searchParams.set(`action`, `connect`)

    ctx.upstream.setResponse({
      status: 200,
      headers: { "Content-Type": `text/event-stream` },
      body: `data: hello\n\n`,
    })

    const response = await fetch(url.toString(), {
      method: `POST`,
      headers: {
        "Use-Stream-URL": `${ctx.urls.proxy}/v1/proxy/fake-id?expires=999&signature=bad`,
      },
    })

    expect(response.status).toBe(201)
  })
})
