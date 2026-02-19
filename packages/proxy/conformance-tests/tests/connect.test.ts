import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { connectProxyStream } from "../harness/client.js"
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

describe(`proxy conformance: connect`, () => {
  it(`creates or reconnects session via action=connect`, async () => {
    if (!getRuntime().capabilities.connect) {
      return
    }

    upstream.setResponse({
      headers: { "Content-Type": `application/json` },
      body: JSON.stringify({ ok: true }),
    })

    const streamId = `conformance-connect-${Date.now()}`
    const first = await connectProxyStream({
      streamId,
      upstreamUrl: upstream.url + `/v1/connect`,
    })
    expect(first.status).toBe(201)
    expect(first.headers.get(`Location`)).toBeTruthy()

    const second = await connectProxyStream({
      streamId,
      upstreamUrl: upstream.url + `/v1/connect`,
    })
    expect(second.status).toBe(200)
    expect(second.headers.get(`Location`)).toBeTruthy()
  })
})
