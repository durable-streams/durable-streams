import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import {
  createProxyStream,
  readProxyStream,
  waitFor,
} from "../harness/client.js"
import {
  createMockUpstream,
  createSSEChunks,
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

describe(`proxy conformance: create and read`, () => {
  it(`creates a stream and returns signed Location`, async () => {
    upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: createSSEChunks([{ data: `hello` }, { data: `world` }]),
      chunkDelayMs: 10,
    })

    const created = await createProxyStream({
      upstreamUrl: upstream.url + `/v1/chat`,
      body: { prompt: `test` },
    })

    expect(created.status).toBe(201)
    expect(created.streamUrl).toBeTruthy()
    expect(created.streamId).toBeTruthy()
  })

  it(`reads stream bytes with offset=-1`, async () => {
    upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: createSSEChunks([{ data: `one` }, { data: `two` }]),
      chunkDelayMs: 10,
    })

    const created = await createProxyStream({
      upstreamUrl: upstream.url + `/v1/chat`,
      body: {},
    })
    expect(created.streamUrl).toBeTruthy()

    await waitFor(async () => {
      const read = await readProxyStream({
        streamUrl: created.streamUrl!,
        offset: `-1`,
      })
      return read.status === 200 && (await read.text()).length > 0
    })

    const read = await readProxyStream({
      streamUrl: created.streamUrl!,
      offset: `-1`,
    })
    expect(read.status).toBe(200)
    expect(read.headers.get(`Stream-Next-Offset`)).toBeTruthy()
  })

  it(`rejects create without service authentication`, async () => {
    const runtime = getRuntime()
    const response = await fetch(
      runtime.adapter.createUrl(runtime.getBaseUrl()).toString(),
      {
        method: `POST`,
        headers: {
          "Upstream-URL": upstream.url + `/v1/chat`,
          "Upstream-Method": `POST`,
        },
        body: JSON.stringify({}),
      }
    )

    expect(response.status).toBe(401)
  })
})
