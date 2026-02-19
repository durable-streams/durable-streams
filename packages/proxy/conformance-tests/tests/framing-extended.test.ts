import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createProxyStream } from "../harness/client.js"
import {
  createAIStreamingResponse,
  createMockUpstream,
} from "../harness/mock-upstream.js"
import { getRuntime } from "../runtime.js"
import type { MockUpstreamServer } from "../harness/mock-upstream.js"

let upstream: MockUpstreamServer

beforeAll(async () => {
  upstream = await createMockUpstream()
})

afterAll(async () => {
  await upstream.stop()
})

describe(`proxy conformance: framing extended`, () => {
  it(`increments Stream-Response-Id for append operations`, async () => {
    if (!getRuntime().capabilities.framing) return

    upstream.setResponse(createAIStreamingResponse([`one`]))
    const first = await createProxyStream({
      upstreamUrl: upstream.url + `/v1/chat`,
      body: {},
    })
    expect(first.headers.get(`Stream-Response-Id`)).toBe(`1`)

    const streamUrl = new URL(first.streamUrl!)
    const streamId = decodeURIComponent(streamUrl.pathname.split(`/`).at(-1)!)
    const runtime = getRuntime()
    const appendUrl = runtime.adapter.streamUrl(runtime.getBaseUrl(), streamId)
    const headers = new Headers({
      "Upstream-URL": upstream.url + `/v1/chat`,
      "Upstream-Method": `POST`,
      "Content-Type": `application/json`,
    })
    await runtime.adapter.applyServiceAuth(appendUrl, headers)

    upstream.setResponse(createAIStreamingResponse([`two`]))
    const append = await fetch(appendUrl.toString(), {
      method: `POST`,
      headers,
      body: JSON.stringify({}),
    })
    expect(append.status).toBe(200)
    expect(append.headers.get(`Stream-Response-Id`)).toBe(`2`)
  })
})
