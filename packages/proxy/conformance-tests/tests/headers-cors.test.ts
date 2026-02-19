import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createProxyStream } from "../harness/client.js"
import { createMockUpstream } from "../harness/mock-upstream.js"
import { getRuntime } from "../runtime.js"
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

describe(`proxy conformance: headers and cors`, () => {
  it(`does not forward proxy-only and hop-by-hop headers upstream`, async () => {
    upstream.setResponse({ status: 200, body: `ok` })
    const result = await createProxyStream({
      upstreamUrl: upstream.url + `/v1/chat`,
      headers: {
        Authorization: `Bearer proxy-auth-token`,
        "Upstream-Authorization": `Bearer upstream-auth-token`,
        "Stream-Signed-URL-TTL": `60`,
        "Proxy-Authenticate": `Basic realm="test"`,
        "Proxy-Authorization": `Basic abc123`,
        Trailers: `x-debug`,
      },
      body: {},
    })
    expect(result.status).toBe(201)

    const lastRequest = upstream.getLastRequest()
    expect(lastRequest).toBeTruthy()
    expect(lastRequest?.headers[`authorization`]).toBe(
      `Bearer upstream-auth-token`
    )
    expect(lastRequest?.headers[`stream-signed-url-ttl`]).toBeUndefined()
    expect(lastRequest?.headers[`proxy-authenticate`]).toBeUndefined()
    expect(lastRequest?.headers[`proxy-authorization`]).toBeUndefined()
    expect(lastRequest?.headers[`trailers`]).toBeUndefined()
  })

  it(`returns CORS headers on OPTIONS request`, async () => {
    const response = await fetch(`${getRuntime().getBaseUrl()}/v1/proxy`, {
      method: `OPTIONS`,
    })
    expect(response.status).toBe(204)
    expect(response.headers.get(`access-control-allow-origin`)).toBe(`*`)
    expect(response.headers.get(`access-control-allow-methods`)).toContain(
      `POST`
    )
    expect(response.headers.get(`access-control-allow-methods`)).toContain(
      `GET`
    )
  })

  it(`includes required proxy headers in Access-Control-Allow-Headers`, async () => {
    const response = await fetch(`${getRuntime().getBaseUrl()}/v1/proxy`, {
      method: `OPTIONS`,
    })
    expect(response.status).toBe(204)
    const allowHeaders =
      response.headers.get(`access-control-allow-headers`)?.toLowerCase() ?? ``
    expect(allowHeaders).toContain(`upstream-url`)
    expect(allowHeaders).toContain(`upstream-authorization`)
    expect(allowHeaders).toContain(`upstream-method`)
    expect(allowHeaders).toContain(`stream-signed-url-ttl`)
  })
})
