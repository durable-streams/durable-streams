import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createProxyStream } from "../harness/client.js"
import { createMockUpstream } from "../harness/mock-upstream.js"
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

describe(`proxy conformance: async upstream piping`, () => {
  it(`returns create response before upstream body finishes streaming`, async () => {
    upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: [
        `data: ${JSON.stringify({ token: `a` })}\n\n`,
        `data: ${JSON.stringify({ token: `b` })}\n\n`,
        `data: ${JSON.stringify({ token: `c` })}\n\n`,
        `data: [DONE]\n\n`,
      ],
      chunkDelayMs: 300,
    })

    const startedAt = Date.now()
    const created = await createProxyStream({
      upstreamUrl: upstream.url + `/v1/chat`,
      body: {},
    })
    const elapsedMs = Date.now() - startedAt

    expect(created.status).toBe(201)
    // Upstream body takes ~1200ms. Create must not wait for full consumption.
    expect(elapsedMs).toBeLessThan(900)
  })
})
