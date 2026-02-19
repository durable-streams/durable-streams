import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import {
  abortProxyStream,
  createProxyStream,
  deleteProxyStream,
  headProxyStream,
  readProxyStream,
  waitFor,
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

beforeEach(() => {
  upstream.reset()
})

afterAll(async () => {
  await upstream.stop()
})

describe(`proxy conformance: abort/head/delete`, () => {
  it(`aborts in-flight stream idempotently`, async () => {
    upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: createSSEChunks(
        Array.from({ length: 80 }, (_, i) => ({ data: `chunk-${i}` }))
      ),
      chunkDelayMs: 25,
    })

    const created = await createProxyStream({
      upstreamUrl: upstream.url + `/v1/chat`,
      body: {},
    })
    expect(created.streamUrl).toBeTruthy()

    const first = await abortProxyStream({ streamUrl: created.streamUrl! })
    const second = await abortProxyStream({ streamUrl: created.streamUrl! })
    expect(first.status).toBe(204)
    expect(second.status).toBe(204)
  })

  it(`returns metadata over HEAD for existing stream`, async () => {
    upstream.setResponse({
      headers: { "Content-Type": `text/plain` },
      body: `meta`,
    })

    const created = await createProxyStream({
      upstreamUrl: upstream.url + `/v1/meta`,
      method: `GET`,
    })
    expect(created.streamId).toBeTruthy()

    await waitFor(async () => {
      const response = await headProxyStream(created.streamId!)
      return response.status === 200
    })

    const response = await headProxyStream(created.streamId!)
    expect(response.status).toBe(200)
  })

  it(`deletes stream and makes it unreadable`, async () => {
    upstream.setResponse({
      headers: { "Content-Type": `text/plain` },
      body: `to-delete`,
    })

    const created = await createProxyStream({
      upstreamUrl: upstream.url + `/v1/delete`,
      method: `GET`,
    })
    expect(created.streamId).toBeTruthy()

    const deleted = await deleteProxyStream(created.streamId!)
    expect(deleted.status).toBe(204)

    const read = await readProxyStream({ streamUrl: created.streamUrl! })
    expect([404, 410]).toContain(read.status)
  })
})
