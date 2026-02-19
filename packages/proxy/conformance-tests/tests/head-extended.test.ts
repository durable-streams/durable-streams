import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createProxyStream, headProxyStream } from "../harness/client.js"
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

describe(`proxy conformance: head extended`, () => {
  it(`returns 401 when secret is missing`, async () => {
    const response = await fetch(
      new URL(`/v1/proxy/some-stream-id`, getRuntime().getBaseUrl()).toString(),
      { method: `HEAD` }
    )
    expect(response.status).toBe(401)
  })

  it(`returns 404 for non-existent stream`, async () => {
    const result = await headProxyStream(`00000000-0000-0000-0000-000000000000`)
    expect(result.status).toBe(404)
  })

  it(`returns Upstream-Content-Type for existing stream`, async () => {
    upstream.setResponse(createAIStreamingResponse([`Test`]))
    const created = await createProxyStream({
      upstreamUrl: upstream.url + `/v1/chat`,
      body: {},
    })
    const result = await headProxyStream(created.streamId!)
    expect(result.status).toBe(200)
    expect(result.headers.get(`Upstream-Content-Type`)).toContain(
      `text/event-stream`
    )
  })
})
