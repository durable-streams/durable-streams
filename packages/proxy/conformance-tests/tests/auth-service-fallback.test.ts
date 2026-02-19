import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
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

beforeEach(() => {
  upstream.reset()
})

afterAll(async () => {
  await upstream.stop()
})

describe(`proxy conformance: service auth fallback`, () => {
  it(`accepts service authentication for read without signed URL`, async () => {
    upstream.setResponse(createAIStreamingResponse([`read-fallback`], 10))
    const created = await createProxyStream({
      upstreamUrl: upstream.url + `/v1/chat`,
      body: {},
    })
    expect(created.streamId).toBeTruthy()

    const runtime = getRuntime()
    const readUrl = runtime.adapter.streamUrl(
      runtime.getBaseUrl(),
      created.streamId!
    )
    readUrl.searchParams.set(`offset`, `-1`)
    const headers = new Headers()
    await runtime.adapter.applyServiceAuth(readUrl, headers)
    const response = await fetch(readUrl.toString(), {
      method: `GET`,
      headers,
    })

    expect(response.status).toBe(200)
  })

  it(`accepts service authentication for abort without signed URL`, async () => {
    upstream.setResponse(createAIStreamingResponse([`abort-fallback`], 50))
    const created = await createProxyStream({
      upstreamUrl: upstream.url + `/v1/chat`,
      body: {},
    })
    expect(created.streamId).toBeTruthy()

    const runtime = getRuntime()
    const abortUrl = runtime.adapter.streamUrl(
      runtime.getBaseUrl(),
      created.streamId!
    )
    abortUrl.searchParams.set(`action`, `abort`)
    const headers = new Headers()
    await runtime.adapter.applyServiceAuth(abortUrl, headers)
    const response = await fetch(abortUrl.toString(), {
      method: `PATCH`,
      headers,
    })

    expect(response.status).toBe(204)
  })
})
