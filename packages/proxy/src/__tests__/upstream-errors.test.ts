/**
 * Tests for upstream failure scenarios.
 *
 * Tests that the proxy correctly handles upstream errors:
 * - Connection failures (502 UPSTREAM_ERROR)
 * - 4xx/5xx upstream responses (502 with Upstream-Status)
 * - Redirect blocking (400 REDIRECT_NOT_ALLOWED)
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createStream, createTestContext } from "./harness"

const ctx = createTestContext()

beforeAll(async () => {
  await ctx.setup()
})

afterAll(async () => {
  await ctx.teardown()
})

describe(`upstream connection failure`, () => {
  it(`returns 502 UPSTREAM_ERROR when upstream is unreachable`, async () => {
    // Use a port that is extremely unlikely to be listening
    const result = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: `http://localhost:1/v1/chat`,
      body: {},
    })

    expect(result.status).toBe(502)
    expect((result.body as { error: { code: string } }).error.code).toBe(
      `UPSTREAM_ERROR`
    )
  })

  it(`returns 502 with upstream status for 500 errors`, async () => {
    ctx.upstream.setResponse({
      status: 500,
      headers: { "Content-Type": `application/json` },
      body: JSON.stringify({ error: `Internal server error` }),
    })

    const result = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/chat`,
      body: {},
    })

    expect(result.status).toBe(502)
    expect(result.headers.get(`Upstream-Status`)).toBe(`500`)
  })

  it(`returns 502 with upstream status for 429 rate limit`, async () => {
    ctx.upstream.setResponse({
      status: 429,
      headers: {
        "Content-Type": `application/json`,
        "Retry-After": `60`,
      },
      body: JSON.stringify({ error: `Rate limit exceeded` }),
    })

    const result = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/chat`,
      body: {},
    })

    expect(result.status).toBe(502)
    expect(result.headers.get(`Upstream-Status`)).toBe(`429`)
  })

  it(`returns 502 with upstream status for 503 unavailable`, async () => {
    ctx.upstream.setResponse({
      status: 503,
      headers: { "Content-Type": `text/plain` },
      body: `Service temporarily unavailable`,
    })

    const result = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/chat`,
      body: {},
    })

    expect(result.status).toBe(502)
    expect(result.headers.get(`Upstream-Status`)).toBe(`503`)
  })

  it(`returns 400 INVALID_UPSTREAM_METHOD for disallowed methods`, async () => {
    const url = new URL(`/v1/proxy`, ctx.urls.proxy)
    url.searchParams.set(`secret`, `test-secret-key-for-development`)

    const response = await fetch(url.toString(), {
      method: `POST`,
      headers: {
        "Upstream-URL": ctx.urls.upstream + `/v1/chat`,
        "Upstream-Method": `TRACE`,
        "Content-Type": `application/json`,
      },
      body: JSON.stringify({}),
    })

    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error.code).toBe(`INVALID_UPSTREAM_METHOD`)
  })
})
