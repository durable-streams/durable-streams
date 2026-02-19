import { describe, expect, it } from "vitest"
import { createProxyStream } from "../harness/client.js"
import { getRuntime } from "../runtime.js"

describe(`proxy conformance: upstream errors extended`, () => {
  it(`returns 502 UPSTREAM_ERROR when upstream is unreachable`, async () => {
    const result = await createProxyStream({
      upstreamUrl: `http://localhost:1/v1/chat`,
      body: {},
    })
    expect(result.status).toBe(502)
    expect((result.body as { error: { code: string } }).error.code).toBe(
      `UPSTREAM_ERROR`
    )
  })

  it(`returns 400 INVALID_UPSTREAM_METHOD for disallowed methods`, async () => {
    const runtime = getRuntime()
    const url = runtime.adapter.createUrl(runtime.getBaseUrl())
    const headers = new Headers({
      "Upstream-URL": `https://api.openai.com/v1/chat`,
      "Upstream-Method": `TRACE`,
      "Content-Type": `application/json`,
    })
    await runtime.adapter.applyServiceAuth(url, headers)
    const response = await fetch(url.toString(), {
      method: `POST`,
      headers,
      body: JSON.stringify({}),
    })
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error.code).toBe(`INVALID_UPSTREAM_METHOD`)
  })
})
