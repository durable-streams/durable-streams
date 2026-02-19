import { describe, expect, it } from "vitest"
import { createProxyStream } from "../harness/client.js"
import { getRuntime } from "../runtime.js"

describe(`proxy conformance: headers and cors`, () => {
  it(`does not forward proxy-only and selected hop-by-hop headers upstream`, async () => {
    const runtime = getRuntime()
    const capturedHeaders: Record<string, string> = {}

    const originalFetch = globalThis.fetch
    try {
      globalThis.fetch = async (input, init) => {
        const url = String(input)
        if (url.startsWith(runtime.getBaseUrl())) {
          return originalFetch(input, init)
        }
        const headers = new Headers(init?.headers ?? {})
        for (const [k, v] of headers.entries()) capturedHeaders[k] = v
        return new Response(`ok`, {
          status: 200,
          headers: { "Content-Type": `text/plain` },
        })
      }

      const result = await createProxyStream({
        upstreamUrl: `https://api.openai.com/v1/chat`,
        headers: {
          "Stream-Signed-URL-TTL": `60`,
          "Proxy-Authenticate": `Basic realm="test"`,
          "Proxy-Authorization": `Basic abc123`,
          trailers: `x-debug`,
        },
        body: {},
      })
      expect([200, 201]).toContain(result.status)
      expect(capturedHeaders[`stream-signed-url-ttl`]).toBeUndefined()
      expect(capturedHeaders[`proxy-authenticate`]).toBeUndefined()
      expect(capturedHeaders[`proxy-authorization`]).toBeUndefined()
      expect(capturedHeaders[`trailers`]).toBeUndefined()
    } finally {
      globalThis.fetch = originalFetch
    }
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
