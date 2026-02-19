import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  abortProxyStream,
  createProxyStream,
  readProxyStream,
} from "../harness/client.js"
import {
  createMockUpstream,
  createSSEChunks,
} from "../harness/mock-upstream.js"
import type { MockUpstreamServer } from "../harness/mock-upstream.js"

let upstream: MockUpstreamServer

beforeAll(async () => {
  upstream = await createMockUpstream()
})

afterAll(async () => {
  await upstream.stop()
})

describe(`proxy conformance: control messages extended`, () => {
  it(`stream is readable after abort and preserves earlier data`, async () => {
    upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: createSSEChunks(
        Array.from({ length: 100 }, (_, i) => ({ data: `{"n": ${i}}` }))
      ),
      chunkDelayMs: 50,
    })

    const created = await createProxyStream({
      upstreamUrl: upstream.url + `/v1/chat`,
      body: {},
    })
    await new Promise((resolve) => setTimeout(resolve, 150))
    const aborted = await abortProxyStream({ streamUrl: created.streamUrl! })
    expect(aborted.status).toBe(204)
    await new Promise((resolve) => setTimeout(resolve, 100))

    const read = await readProxyStream({
      streamUrl: created.streamUrl!,
      offset: `-1`,
    })
    expect(read.status).toBe(200)
    const body = await read.text()
    expect(body.length).toBeGreaterThan(0)
  })

  it(`returns upstream status details on errors`, async () => {
    upstream.setResponse({
      status: 429,
      headers: { "Content-Type": `application/json` },
      body: JSON.stringify({ error: `Rate limited` }),
    })
    const created = await createProxyStream({
      upstreamUrl: upstream.url + `/v1/chat`,
      body: {},
    })
    expect(created.status).toBe(502)
    expect(created.headers.get(`Upstream-Status`)).toBe(`429`)
  })
})
