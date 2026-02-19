import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createProxyStream } from "../harness/client.js"
import { createMockUpstream } from "../harness/mock-upstream.js"
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

describe(`proxy conformance: upstream status mapping`, () => {
  it(`returns 502 with upstream status for 500 errors`, async () => {
    upstream.setResponse({
      status: 500,
      headers: { "Content-Type": `application/json` },
      body: JSON.stringify({ error: `Internal server error` }),
    })
    const result = await createProxyStream({
      upstreamUrl: upstream.url + `/v1/chat`,
      body: {},
    })
    expect(result.status).toBe(502)
    expect(result.headers.get(`Upstream-Status`)).toBe(`500`)
  })

  it(`returns 502 with upstream status for 429 errors`, async () => {
    upstream.setResponse({
      status: 429,
      headers: { "Content-Type": `application/json` },
      body: JSON.stringify({ error: `Rate limit exceeded` }),
    })
    const result = await createProxyStream({
      upstreamUrl: upstream.url + `/v1/chat`,
      body: {},
    })
    expect(result.status).toBe(502)
    expect(result.headers.get(`Upstream-Status`)).toBe(`429`)
  })

  it(`returns 502 with upstream status for 503 errors`, async () => {
    upstream.setResponse({
      status: 503,
      headers: { "Content-Type": `text/plain` },
      body: `Service unavailable`,
    })
    const result = await createProxyStream({
      upstreamUrl: upstream.url + `/v1/chat`,
      body: {},
    })
    expect(result.status).toBe(502)
    expect(result.headers.get(`Upstream-Status`)).toBe(`503`)
  })
})
