import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createProxyStream } from "../harness/client.js"
import { createMockUpstream } from "../harness/mock-upstream.js"
import type { MockUpstreamServer } from "../harness/mock-upstream.js"

let upstream: MockUpstreamServer

beforeAll(async () => {
  upstream = await createMockUpstream()
})

afterAll(async () => {
  await upstream.stop()
})

describe(`proxy conformance: headers, allowlist, upstream errors`, () => {
  it(`forwards custom headers and request body upstream`, async () => {
    upstream.setResponse({ status: 200, body: `ok` })

    const created = await createProxyStream({
      upstreamUrl: upstream.url + `/v1/headers`,
      headers: {
        "X-Custom-Header": `custom-value`,
        "Content-Type": `application/json`,
      },
      body: { hello: `world` },
    })
    expect([200, 201]).toContain(created.status)

    const lastRequest = upstream.getLastRequest()
    expect(lastRequest).toBeTruthy()
    expect(lastRequest!.headers[`x-custom-header`]).toBe(`custom-value`)
    expect(lastRequest!.headers[`content-type`]).toContain(`application/json`)
    expect(lastRequest!.body).toContain(`hello`)
  })

  it(`rejects non-allowlisted upstream URL`, async () => {
    const created = await createProxyStream({
      upstreamUrl: `https://blocked.invalid.example/v1/chat`,
      body: {},
    })
    expect(created.status).toBe(403)
  })

  it(`maps upstream non-2xx to proxy error with Upstream-Status`, async () => {
    upstream.setResponse({
      status: 429,
      headers: { "Content-Type": `application/json` },
      body: JSON.stringify({ error: `rate limit` }),
    })

    const created = await createProxyStream({
      upstreamUrl: upstream.url + `/v1/rate-limited`,
      body: {},
    })
    expect(created.status).toBe(502)
    expect(created.headers.get(`Upstream-Status`)).toBe(`429`)
  })
})
