import { describe, expect, it } from "vitest"
import { FrameDemuxer } from "../../../src/client/frame-demuxer"

function encodeFrame(
  type: string,
  responseId: number,
  payload: Uint8Array
): Uint8Array {
  const bytes = new Uint8Array(9 + payload.length)
  bytes[0] = type.charCodeAt(0)
  const view = new DataView(bytes.buffer)
  view.setUint32(1, responseId, false)
  view.setUint32(5, payload.length, false)
  bytes.set(payload, 9)
  return bytes
}

function concatBytes(...chunks: Array<Uint8Array>): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

describe(`FrameDemuxer`, () => {
  it(`handles frames split across multiple chunks`, async () => {
    const demuxer = new FrameDemuxer()
    const encoder = new TextEncoder()
    const startPayload = encoder.encode(
      JSON.stringify({
        status: 200,
        headers: { "content-type": `text/plain` },
      })
    )
    const dataPayload = encoder.encode(`hello`)
    const stream = concatBytes(
      encodeFrame(`S`, 1, startPayload),
      encodeFrame(`D`, 1, dataPayload),
      encodeFrame(`C`, 1, new Uint8Array(0))
    )
    const responsePromise = demuxer.waitForResponse(1)

    demuxer.pushChunk(stream.slice(0, 7))
    demuxer.pushChunk(stream.slice(7, 15))
    demuxer.pushChunk(stream.slice(15))

    const response = await responsePromise
    expect(response.responseId).toBe(1)
    expect(await response.text()).toBe(`hello`)
  })

  it(`processes multiple complete frames in a single chunk`, async () => {
    const demuxer = new FrameDemuxer()
    const encoder = new TextEncoder()
    const startPayload = encoder.encode(
      JSON.stringify({
        status: 200,
        headers: { "content-type": `text/plain` },
      })
    )
    const stream = concatBytes(
      encodeFrame(`S`, 7, startPayload),
      encodeFrame(`D`, 7, encoder.encode(`abc`)),
      encodeFrame(`C`, 7, new Uint8Array(0))
    )
    const responsePromise = demuxer.waitForResponse(7)

    demuxer.pushChunk(stream)

    const response = await responsePromise
    expect(await response.text()).toBe(`abc`)
  })

  it(`rejects on unknown frame types`, async () => {
    const demuxer = new FrameDemuxer()
    const pending = demuxer.waitForResponse(1)
    demuxer.pushChunk(encodeFrame(`X`, 1, new TextEncoder().encode(`oops`)))
    await expect(pending).rejects.toThrow(`Unknown frame type`)
  })

  it(`rejects when frame buffer limit is exceeded`, async () => {
    const demuxer = new FrameDemuxer()
    const tooLarge = new Uint8Array(4 * 1024 * 1024 + 1)
    demuxer.pushChunk(tooLarge)
    await expect(demuxer.waitForResponse(1)).rejects.toThrow(
      `Frame buffer exceeded`
    )
  })
})
