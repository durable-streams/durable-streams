/**
 * Tests for stream creation through the proxy.
 *
 * POST /v1/proxy with Upstream-URL and Upstream-Method headers
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  createAIStreamingResponse,
  createStream,
  createTestContext,
} from "./harness"

const ctx = createTestContext()

beforeAll(async () => {
  await ctx.setup()
})

afterAll(async () => {
  await ctx.teardown()
})

describe(`stream creation`, () => {
  it(`returns 201 with Location header on success`, async () => {
    ctx.upstream.setResponse(createAIStreamingResponse([`Hello`, ` World`]))

    const result = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/chat/completions`,
      body: { messages: [{ role: `user`, content: `Hello` }] },
    })

    expect(result.status).toBe(201)
    expect(result.streamUrl).toBeDefined()
    expect(result.streamId).toBeDefined()
    // Stream ID should be a UUID
    expect(result.streamId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    )
  })

  it(`returns 401 when secret is missing`, async () => {
    const url = new URL(`/v1/proxy`, ctx.urls.proxy)

    const response = await fetch(url.toString(), {
      method: `POST`,
      headers: {
        "Upstream-URL": ctx.urls.upstream + `/v1/chat`,
        "Upstream-Method": `POST`,
        "Content-Type": `application/json`,
      },
      body: JSON.stringify({}),
    })

    expect(response.status).toBe(401)
    const body = await response.json()
    expect(body.error.code).toBe(`MISSING_SECRET`)
  })

  it(`returns 400 when Upstream-URL is missing`, async () => {
    const url = new URL(`/v1/proxy`, ctx.urls.proxy)
    url.searchParams.set(`secret`, `test-secret-key-for-development`)

    const response = await fetch(url.toString(), {
      method: `POST`,
      headers: {
        "Upstream-Method": `POST`,
        "Content-Type": `application/json`,
      },
      body: JSON.stringify({}),
    })

    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error.code).toBe(`MISSING_UPSTREAM_URL`)
  })

  it(`returns 400 when Upstream-Method is missing`, async () => {
    const url = new URL(`/v1/proxy`, ctx.urls.proxy)
    url.searchParams.set(`secret`, `test-secret-key-for-development`)

    const response = await fetch(url.toString(), {
      method: `POST`,
      headers: {
        "Upstream-URL": ctx.urls.upstream + `/v1/chat`,
        "Content-Type": `application/json`,
      },
      body: JSON.stringify({}),
    })

    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error.code).toBe(`MISSING_UPSTREAM_METHOD`)
  })

  it(`returns 403 when upstream is not in allowlist`, async () => {
    const result = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: `https://evil.example.com/api`,
      body: {},
    })

    expect(result.status).toBe(403)
    expect((result.body as { error: { code: string } }).error.code).toBe(
      `UPSTREAM_NOT_ALLOWED`
    )
  })

  it(`allows upstream URLs matching allowlist patterns`, async () => {
    ctx.upstream.setResponse({ status: 200, body: `OK` })

    const result = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/api/chat`,
      body: {},
    })

    // Should succeed (not 403)
    expect(result.status).not.toBe(403)
  })

  it(`returns Upstream-Content-Type header`, async () => {
    ctx.upstream.setResponse(createAIStreamingResponse([`Response`]))

    const result = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/chat/completions`,
      body: {},
    })

    expect(result.status).toBe(201)
    expect(result.upstreamContentType).toBeDefined()
    expect(result.upstreamContentType).toContain(`text/event-stream`)
  })
})

describe(`security: SSRF redirect prevention`, () => {
  it(`blocks upstream 302 redirects`, async () => {
    ctx.upstream.setResponse({
      status: 302,
      headers: {
        Location: `http://169.254.169.254/latest/meta-data/`,
      },
      body: ``,
    })

    const result = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/chat`,
      body: {},
    })

    // 302 redirects should return 400 (redirect not allowed)
    expect(result.status).toBe(400)
    expect((result.body as { error: { code: string } }).error.code).toBe(
      `REDIRECT_NOT_ALLOWED`
    )
  })

  it(`blocks upstream 307 redirects`, async () => {
    ctx.upstream.setResponse({
      status: 307,
      headers: {
        Location: `http://internal.service/admin`,
      },
      body: ``,
    })

    const result = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/chat`,
      body: {},
    })

    expect(result.status).toBe(400)
    expect((result.body as { error: { code: string } }).error.code).toBe(
      `REDIRECT_NOT_ALLOWED`
    )
  })
})
