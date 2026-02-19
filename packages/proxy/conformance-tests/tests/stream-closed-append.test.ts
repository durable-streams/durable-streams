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

describe(`proxy conformance: append to closed stream`, () => {
  it(`returns 409 STREAM_CLOSED when appending to a closed stream`, async () => {
    const runtime = getRuntime()

    upstream.setResponse(createAIStreamingResponse([`one`]))
    const created = await createProxyStream({
      upstreamUrl: upstream.url + `/v1/chat`,
      body: {},
    })
    expect(created.status).toBe(201)
    expect(created.streamId).toBeTruthy()

    await runtime.adapter.closeStream(created.streamId!)

    upstream.setResponse(createAIStreamingResponse([`two`]))
    const appended = await createProxyStream({
      streamId: created.streamId,
      upstreamUrl: upstream.url + `/v1/chat`,
      body: {},
    })
    expect(appended.status).toBe(409)
    expect((appended.body as { error?: { code?: string } }).error?.code).toBe(
      `STREAM_CLOSED`
    )
  })
})
