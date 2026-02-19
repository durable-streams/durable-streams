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

describe(`proxy conformance: framing`, () => {
  it(`writes Start/Data/Complete frames for proxied stream`, async () => {
    if (!getRuntime().capabilities.framing) {
      return
    }

    upstream.setResponse(createAIStreamingResponse([`hello`, `world`], 10))
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
      if (read.status !== 200) return false
      const bytes = new Uint8Array(await read.arrayBuffer())
      const types = parseFrames(bytes).map((frame) => frame.type)
      return types.includes(`S`) && types.includes(`D`) && types.includes(`C`)
    })

    const read = await readProxyStream({
      streamUrl: created.streamUrl!,
      offset: `-1`,
    })
    expect(read.status).toBe(200)
    const frames = parseFrames(new Uint8Array(await read.arrayBuffer()))
    expect(frames[0]?.type).toBe(`S`)
    expect(frames.some((frame) => frame.type === `D`)).toBe(true)
    expect(frames.at(-1)?.type).toBe(`C`)

    const byResponse = new Map<number, Array<(typeof frames)[number]>>()
    for (const frame of frames) {
      const list = byResponse.get(frame.responseId) ?? []
      list.push(frame)
      byResponse.set(frame.responseId, list)
    }
    for (const responseFrames of byResponse.values()) {
      const starts = responseFrames.filter((frame) => frame.type === `S`)
      expect(starts).toHaveLength(1)
      expect(responseFrames[0]?.type).toBe(`S`)
      const terminals = responseFrames.filter((frame) =>
        [`C`, `A`, `E`].includes(frame.type)
      )
      expect(terminals).toHaveLength(1)
    }

    const startPayload = JSON.parse(
      new TextDecoder().decode(frames[0]!.payload)
    ) as { status?: number; headers?: Record<string, string> }
    expect(typeof startPayload.status).toBe(`number`)
    expect(startPayload.headers).toBeTypeOf(`object`)
    const headerNames = Object.keys(startPayload.headers ?? {})
    for (const headerName of headerNames) {
      expect(headerName).toBe(headerName.toLowerCase())
      expect(typeof startPayload.headers?.[headerName]).toBe(`string`)
    }
  })
})
