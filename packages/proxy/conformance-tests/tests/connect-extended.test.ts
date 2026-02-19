import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { connectProxyStream } from "../harness/client.js"
import { createMockUpstream } from "../harness/mock-upstream.js"
import { getRuntime } from "../runtime.js"
import type { MockUpstreamServer } from "../harness/mock-upstream.js"

let upstream: MockUpstreamServer

beforeAll(async () => {
  upstream = await createMockUpstream()
})

afterAll(async () => {
  await upstream.stop()
})

describe(`proxy conformance: connect extended`, () => {
  it(`preserves passthrough query params in connect Location URL`, async () => {
    if (!getRuntime().capabilities.connect) return

    const streamId = `session-passthrough-${Date.now()}`
    const runtime = getRuntime()
    const url = runtime.adapter.connectUrl(runtime.getBaseUrl(), streamId)
    url.searchParams.set(`offset`, `4096`)
    url.searchParams.set(`live`, `sse`)
    const headers = new Headers()
    await runtime.adapter.applyServiceAuth(url, headers)

    const response = await fetch(url.toString(), { method: `POST`, headers })
    expect([200, 201]).toContain(response.status)
    const location = response.headers.get(`Location`)
    expect(location).toBeTruthy()
    const locationUrl = new URL(location!, runtime.getBaseUrl())
    expect(locationUrl.searchParams.get(`offset`)).toBe(`4096`)
    expect(locationUrl.searchParams.get(`live`)).toBe(`sse`)
  })

  it(`forwards connect handler rejection to client`, async () => {
    if (!getRuntime().capabilities.connect) return

    upstream.setResponse({
      status: 403,
      headers: { "Content-Type": `application/json` },
      body: JSON.stringify({ error: `Forbidden` }),
    })

    const result = await connectProxyStream({
      streamId: `session-rejected-${Date.now()}`,
      upstreamUrl: upstream.url + `/connect`,
    })
    expect(result.status).toBe(401)
    const body = await result.json()
    expect(body.error.code).toBe(`CONNECT_REJECTED`)
  })

  it(`returns 400 when action is invalid`, async () => {
    if (!getRuntime().capabilities.connect) return

    const runtime = getRuntime()
    const url = runtime.adapter.streamUrl(
      runtime.getBaseUrl(),
      `session-invalid-action-${Date.now()}`
    )
    url.searchParams.set(`action`, `invalid`)
    const headers = new Headers()
    await runtime.adapter.applyServiceAuth(url, headers)

    const response = await fetch(url.toString(), { method: `POST`, headers })
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error.code).toBe(`INVALID_ACTION`)
  })
})
