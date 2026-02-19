import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import {
  createProxyStream,
  readProxyStream,
  waitFor,
} from "../harness/client.js"
import { parseFrames } from "../harness/frames.js"
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

  it(`writes Error terminal frame when upstream fails mid-stream`, async () => {
    if (!getRuntime().capabilities.framing) return

    upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: [
        `data: ${JSON.stringify({ choices: [{ delta: { content: `hello` } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: `world` } }] })}\n\n`,
      ],
      chunkDelayMs: 10,
      abortAfterChunks: 1,
    })
    const created = await createProxyStream({
      upstreamUrl: upstream.url + `/v1/chat`,
      body: {},
    })
    expect(created.status).toBe(201)

    await waitFor(async () => {
      const read = await readProxyStream({
        streamUrl: created.streamUrl!,
        offset: `-1`,
      })
      if (read.status !== 200) return false
      const frames = parseFrames(new Uint8Array(await read.arrayBuffer()))
      return frames.some((frame) => frame.type === `E`)
    })

    const read = await readProxyStream({
      streamUrl: created.streamUrl!,
      offset: `-1`,
    })
    const frames = parseFrames(new Uint8Array(await read.arrayBuffer()))
    const errorFrame = frames.find((frame) => frame.type === `E`)
    expect(errorFrame).toBeTruthy()
    const payload = JSON.parse(
      new TextDecoder().decode(errorFrame!.payload)
    ) as { code?: string; message?: string }
    expect(payload.code).toBeTruthy()
    expect(payload.message).toBeTruthy()
  })
})
