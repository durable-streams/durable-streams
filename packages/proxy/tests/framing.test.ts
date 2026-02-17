import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  createAIStreamingResponse,
  createStream,
  createTestContext,
} from "./harness"

const ctx = createTestContext()

interface ParsedFrame {
  type: string
  responseId: number
  payload: Uint8Array
}

function parseFrames(data: Uint8Array): Array<ParsedFrame> {
  const frames: Array<ParsedFrame> = []
  let offset = 0
  while (offset + 9 <= data.length) {
    const type = String.fromCharCode(data[offset]!)
    const view = new DataView(data.buffer, data.byteOffset + offset, 9)
    const responseId = view.getUint32(1, false)
    const payloadLength = view.getUint32(5, false)
    offset += 9
    if (offset + payloadLength > data.length) break
    const payload = data.slice(offset, offset + payloadLength)
    frames.push({ type, responseId, payload })
    offset += payloadLength
  }
  return frames
}

beforeAll(async () => {
  await ctx.setup()
})

afterAll(async () => {
  await ctx.teardown()
})

describe(`binary framing`, () => {
  it(`writes Start/Data/Complete frames with matching responseId`, async () => {
    ctx.upstream.setResponse(createAIStreamingResponse([`hello`, ` world`], 5))

    const created = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/chat`,
      body: {},
    })

    expect(created.status).toBe(201)
    expect(created.headers.get(`Stream-Response-Id`)).toBe(`1`)

    await new Promise((r) => setTimeout(r, 120))
    const readUrl = new URL(created.streamUrl!)
    readUrl.searchParams.set(`offset`, `-1`)
    const read = await fetch(readUrl.toString())
    expect(read.status).toBe(200)
    const bytes = new Uint8Array(await read.arrayBuffer())
    const frames = parseFrames(bytes)

    expect(frames.length).toBeGreaterThanOrEqual(3)
    expect(frames[0]?.type).toBe(`S`)
    expect(frames[0]?.responseId).toBe(1)
    expect(frames.at(-1)?.type).toBe(`C`)
    expect(frames.at(-1)?.responseId).toBe(1)
    expect(frames.some((f) => f.type === `D`)).toBe(true)
  })

  it(`increments Stream-Response-Id for append operations`, async () => {
    ctx.upstream.setResponse(createAIStreamingResponse([`one`]))
    const first = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/chat`,
      body: {},
    })
    expect(first.headers.get(`Stream-Response-Id`)).toBe(`1`)

    ctx.upstream.setResponse(createAIStreamingResponse([`two`]))
    const url = new URL(`/v1/proxy`, ctx.urls.proxy)
    url.searchParams.set(`secret`, `test-secret-key-for-development`)
    const append = await fetch(url.toString(), {
      method: `POST`,
      headers: {
        "Upstream-URL": ctx.urls.upstream + `/v1/chat`,
        "Upstream-Method": `POST`,
        "Use-Stream-URL": first.streamUrl!,
      },
      body: JSON.stringify({}),
    })

    expect(append.status).toBe(200)
    expect(append.headers.get(`Stream-Response-Id`)).toBe(`2`)
  })
})
