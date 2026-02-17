/**
 * End-to-end framing tests for proxy read path.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  createAIStreamingResponse,
  createStream,
  createTestContext,
} from "./harness"

const ctx = createTestContext()

function parseFrameTypes(bytes: Uint8Array): Array<string> {
  const types: Array<string> = []
  let offset = 0
  while (offset + 9 <= bytes.length) {
    const type = String.fromCharCode(bytes[offset] as number)
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 9)
    const payloadLen = view.getUint32(5, false)
    offset += 9
    if (offset + payloadLen > bytes.length) break
    types.push(type)
    offset += payloadLen
  }
  return types
}

beforeAll(async () => {
  await ctx.setup()
})

afterAll(async () => {
  await ctx.teardown()
})

describe(`proxy e2e framing`, () => {
  it(`persists framed response bytes and exposes upstream content type`, async () => {
    ctx.upstream.setResponse(createAIStreamingResponse([`hello`, ` world`], 10))

    const created = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/test`,
      body: {},
    })

    expect(created.status).toBe(201)
    expect(created.upstreamContentType).toContain(`text/event-stream`)

    await new Promise((r) => setTimeout(r, 150))
    const readUrl = new URL(created.streamUrl!)
    readUrl.searchParams.set(`offset`, `-1`)
    const read = await fetch(readUrl.toString())
    expect(read.status).toBe(200)
    const bytes = new Uint8Array(await read.arrayBuffer())
    const frameTypes = parseFrameTypes(bytes)
    expect(frameTypes[0]).toBe(`S`)
    expect(frameTypes.includes(`D`)).toBe(true)
    expect(frameTypes.at(-1)).toBe(`C`)
  })
})
