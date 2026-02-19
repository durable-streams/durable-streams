import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
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

describe(`proxy conformance: legacy renew stream URL`, () => {
  it(`does not trigger dedicated renew operation`, async () => {
    const runtime = getRuntime()
    const url = runtime.adapter.createUrl(runtime.getBaseUrl())
    const headers = new Headers({
      "Upstream-URL": upstream.url + `/v1/chat`,
      "Upstream-Method": `POST`,
      "Renew-Stream-URL": `https://example.com/legacy`,
    })
    await runtime.adapter.applyServiceAuth(url, headers)

    const response = await fetch(url.toString(), {
      method: `POST`,
      headers,
      body: JSON.stringify({}),
    })
    expect([200, 201]).toContain(response.status)
    expect(response.headers.get(`Location`)).toBeTruthy()
  })

  it(`still requires create headers when Renew-Stream-URL is set`, async () => {
    const runtime = getRuntime()
    const url = runtime.adapter.createUrl(runtime.getBaseUrl())
    const headers = new Headers({
      "Renew-Stream-URL": `https://example.com/legacy`,
    })
    await runtime.adapter.applyServiceAuth(url, headers)
    const response = await fetch(url.toString(), {
      method: `POST`,
      headers,
    })
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error.code).toBe(`MISSING_UPSTREAM_URL`)
  })
})
