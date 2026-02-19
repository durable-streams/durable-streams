import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import {
  abortProxyStream,
  createProxyStream,
  readProxyStream,
} from "../harness/client.js"
import { parseFrames } from "../harness/frames.js"
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

describe(`proxy conformance: targeted abort`, () => {
  it(`aborts only targeted response ID`, async () => {
    if (!getRuntime().capabilities.targetedAbort) return

    const streamId = `targeted-abort-${Date.now()}`
    const runtime = getRuntime()
    const url = runtime.adapter.streamUrl(runtime.getBaseUrl(), streamId)
    const headers = new Headers({
      "Upstream-URL": upstream.url + `/v1/chat`,
      "Upstream-Method": `POST`,
      "Content-Type": `application/json`,
    })
    await runtime.adapter.applyServiceAuth(url, headers)

    upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: createSSEChunks(
        Array.from({ length: 80 }, (_, i) => ({ data: `slow-${i}` }))
      ),
      chunkDelayMs: 40,
    })
    const first = await fetch(url.toString(), {
      method: `POST`,
      headers,
      body: JSON.stringify({ request: `slow` }),
    })
    expect(first.status).toBe(201)
    const streamUrl = new URL(
      first.headers.get(`Location`)!,
      runtime.getBaseUrl()
    ).toString()

    upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: createSSEChunks([{ data: `fast-1` }, { data: `fast-2` }]),
      chunkDelayMs: 5,
    })
    const second = await fetch(url.toString(), {
      method: `POST`,
      headers,
      body: JSON.stringify({ request: `fast` }),
    })
    expect(second.status).toBe(200)
    expect(second.headers.get(`Stream-Response-Id`)).toBe(`2`)

    const abortResponse = await abortProxyStream({
      streamUrl,
      responseId: `1`,
    })
    expect(abortResponse.status).toBe(204)

    await new Promise((resolve) => setTimeout(resolve, 350))
    const read = await readProxyStream({ streamUrl, offset: `-1` })
    expect(read.status).toBe(200)
    const frames = parseFrames(new Uint8Array(await read.arrayBuffer()))
    const response1Terminal = frames.find(
      (f) =>
        f.responseId === 1 &&
        (f.type === `A` || f.type === `C` || f.type === `E`)
    )
    const response2Terminal = frames.find(
      (f) =>
        f.responseId === 2 &&
        (f.type === `A` || f.type === `C` || f.type === `E`)
    )
    expect(response1Terminal?.type).toBe(`A`)
    expect(response2Terminal?.type).toBe(`C`)
  })

  it(`returns 204 when targeted response ID does not exist`, async () => {
    if (!getRuntime().capabilities.targetedAbort) return

    upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: createSSEChunks([{ data: `one` }, { data: `[DONE]` }]),
      chunkDelayMs: 5,
    })
    const created = await createProxyStream({
      upstreamUrl: upstream.url + `/v1/chat`,
      body: {},
    })
    expect(created.status).toBe(201)
    const abort = await abortProxyStream({
      streamUrl: created.streamUrl!,
      responseId: `999`,
    })
    expect(abort.status).toBe(204)
  })
})
