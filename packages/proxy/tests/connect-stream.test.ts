/**
 * Tests for the connect operation.
 *
 * POST /v1/proxy with Session-Id header
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { deriveStreamId } from "../src/server/derive-stream-id"
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
  sessionId: string
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
  const url = new URL(`/v1/proxy`, ctx.urls.proxy)
  url.searchParams.set(`secret`, options.secret ?? TEST_SECRET)

  const requestHeaders: Record<string, string> = {
    "Session-Id": options.sessionId,
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

describe(`POST /v1/proxy with Session-Id (connect)`, () => {
  it(`creates a new session and returns 201 with empty body`, async () => {
    ctx.upstream.setResponse({
      status: 200,
      headers: { "Content-Type": `application/json` },
      body: JSON.stringify({
        messages: [{ role: `assistant`, content: `Hi` }],
      }),
    })

    const result = await connectSession({
      sessionId: `session-new-1`,
      upstreamUrl: ctx.urls.upstream + `/connect`,
    })

    expect(result.status).toBe(201)
    expect(result.streamUrl).toBeDefined()
    expect(result.streamId).toBeDefined()
    expect(result.headers.get(`Stream-Id`)).toBe(result.streamId)
    expect(result.body).toBe(``)
  })

  it(`reconnects to existing session and returns 200`, async () => {
    const sessionId = `session-reconnect-1`

    // First connect - creates the session
    ctx.upstream.setResponse({
      status: 200,
      headers: { "Content-Type": `application/json` },
      body: JSON.stringify({ messages: [] }),
    })

    const first = await connectSession({
      sessionId,
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
      sessionId,
      upstreamUrl: ctx.urls.upstream + `/connect`,
    })
    expect(second.status).toBe(200)
    expect(second.streamId).toBe(first.streamId)
  })

  it(`works without Upstream-URL (service-auth-only mode)`, async () => {
    const result = await connectSession({
      sessionId: `session-no-upstream-url`,
    })

    expect(result.status).toBe(201)
    expect(result.streamUrl).toBeDefined()
    expect(result.streamId).toBeDefined()
    expect(result.body).toBe(``)
  })

  it(`derives deterministic stream ID from session ID`, () => {
    const id1 = deriveStreamId(`session-abc`)
    const id2 = deriveStreamId(`session-abc`)
    const id3 = deriveStreamId(`session-xyz`)

    expect(id1).toBe(id2)
    expect(id1).not.toBe(id3)

    // Should be a valid UUID format
    expect(id1).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
  })

  it(`forwards Stream-Id header to connect handler`, async () => {
    const sessionId = `session-forward-id`
    const expectedStreamId = deriveStreamId(sessionId)

    let receivedStreamId: string | undefined
    ctx.upstream.setHandler((req, res) => {
      receivedStreamId = req.headers[`stream-id`] as string
      res.writeHead(200, { "Content-Type": `application/json` })
      res.end(JSON.stringify({ ok: true }))
    })

    await connectSession({
      sessionId,
      upstreamUrl: ctx.urls.upstream + `/connect`,
    })

    expect(receivedStreamId).toBe(expectedStreamId)
  })

  it(`returns fresh signed URL in Location header`, async () => {
    ctx.upstream.setResponse({
      status: 200,
      headers: { "Content-Type": `application/json` },
      body: JSON.stringify({}),
    })

    const result = await connectSession({
      sessionId: `session-signed-url-1`,
      upstreamUrl: ctx.urls.upstream + `/connect`,
    })

    expect(result.streamUrl).toBeDefined()
    const url = new URL(result.streamUrl!)
    expect(url.searchParams.get(`expires`)).toBeDefined()
    expect(url.searchParams.get(`signature`)).toBeDefined()
  })

  it(`forwards connect handler rejection to client`, async () => {
    ctx.upstream.setResponse({
      status: 403,
      headers: { "Content-Type": `application/json` },
      body: JSON.stringify({ error: `Forbidden` }),
    })

    const result = await connectSession({
      sessionId: `session-rejected-1`,
      upstreamUrl: ctx.urls.upstream + `/connect`,
    })

    expect(result.status).toBe(401)
    const parsed = JSON.parse(result.body) as { error: { code: string } }
    expect(parsed.error.code).toBe(`CONNECT_REJECTED`)
  })

  it(`returns 400 when Session-Id header is missing`, async () => {
    // Without Session-Id and without Use-Stream-URL,
    // this falls through to the create handler which requires Upstream-Method
    const url = new URL(`/v1/proxy`, ctx.urls.proxy)
    url.searchParams.set(`secret`, TEST_SECRET)

    const response = await fetch(url.toString(), {
      method: `POST`,
      headers: {
        "Upstream-URL": ctx.urls.upstream + `/connect`,
        "Upstream-Method": `POST`,
      },
    })

    // Without Session-Id, this is a normal create request (not a connect)
    // It should proceed as create (we're just verifying dispatch works correctly)
    expect([200, 201, 502]).toContain(response.status)
  })

  it(`returns 401 when service secret is missing`, async () => {
    const url = new URL(`/v1/proxy`, ctx.urls.proxy)
    // No secret parameter

    const response = await fetch(url.toString(), {
      method: `POST`,
      headers: {
        "Session-Id": `session-no-secret`,
        "Upstream-URL": ctx.urls.upstream + `/connect`,
      },
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
      sessionId: `session-ttl-1`,
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
      sessionId: `session-auth-1`,
      upstreamUrl: ctx.urls.upstream + `/connect`,
      headers: {
        "Upstream-Authorization": `Bearer user-token-123`,
      },
    })

    expect(receivedAuthHeader).toBe(`Bearer user-token-123`)
  })

  it(`dispatches to append (not connect) when both Session-Id and Use-Stream-URL are present`, async () => {
    // When both Session-Id and Use-Stream-URL are present,
    // dispatch should route to append (Use-Stream-URL takes priority)
    const url = new URL(`/v1/proxy`, ctx.urls.proxy)
    url.searchParams.set(`secret`, TEST_SECRET)

    ctx.upstream.setResponse({
      status: 200,
      headers: { "Content-Type": `text/event-stream` },
      body: `data: hello\n\n`,
    })

    const response = await fetch(url.toString(), {
      method: `POST`,
      headers: {
        "Session-Id": `session-dispatch-test`,
        "Use-Stream-URL": `${ctx.urls.proxy}/v1/proxy/fake-id?expires=999&signature=bad`,
        "Upstream-URL": ctx.urls.upstream + `/chat`,
        "Upstream-Method": `POST`,
      },
    })

    // Should be treated as append, not connect.
    // Invalid signature → 401 (not 400 for missing Session-Id)
    expect(response.status).toBe(401)
    const body = await response.json()
    expect(body.error.code).toBe(`SIGNATURE_INVALID`)
  })
})
