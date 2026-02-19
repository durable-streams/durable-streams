import { describe, expect, it } from "vitest"
import { MemoryStorage, createDurableSession } from "../../../src/client"

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

describe(`createDurableSession SSE parsing`, () => {
  it(`handles CRLF line endings, comments, and multiline data fields`, async () => {
    const encoder = new TextEncoder()
    const startPayload = encoder.encode(
      JSON.stringify({
        status: 200,
        headers: { "content-type": `text/plain` },
      })
    )
    const bodyPayload = encoder.encode(`hello over sse`)
    const framed = concatBytes(
      encodeFrame(`S`, 1, startPayload),
      encodeFrame(`D`, 1, bodyPayload),
      encodeFrame(`C`, 1, new Uint8Array(0))
    )
    const base64 = Buffer.from(framed).toString(`base64`)
    const midpoint = Math.floor(base64.length / 2)

    let readCount = 0
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input)
      if (url.includes(`action=connect`)) {
        return new Response(null, {
          status: 201,
          headers: {
            Location: `http://localhost:4440/v1/proxy/session-sse?expires=1&signature=sig`,
          },
        })
      }
      if (init?.method === `POST`) {
        return new Response(null, {
          status: 200,
          headers: {
            Location: `http://localhost:4440/v1/proxy/session-sse?expires=1&signature=sig`,
            "Stream-Response-Id": `1`,
          },
        })
      }
      if (url.includes(`/v1/proxy/session-sse`)) {
        readCount += 1
        if (readCount === 1) {
          const sse = [
            `: comment`,
            `event: data`,
            `data: ${base64.slice(0, midpoint)}`,
            `data: ${base64.slice(midpoint)}`,
            ``,
            `event: control`,
            `data: {"streamNextOffset":"5_5"}`,
            ``,
            ``,
          ].join(`\r\n`)
          return new Response(sse, {
            status: 200,
            headers: {
              "content-type": `text/event-stream`,
              "stream-sse-data-encoding": `base64`,
            },
          })
        }
        return new Response(
          `event: control\ndata: {"streamNextOffset":"6_6"}\n\n`,
          {
            status: 200,
            headers: { "content-type": `text/event-stream` },
          }
        )
      }
      throw new Error(`unexpected request: ${url}`)
    }

    const session = createDurableSession({
      proxyUrl: `http://localhost:4440/v1/proxy`,
      proxyAuthorization: `test-secret-key-for-development`,
      streamId: `session-sse`,
      storage: new MemoryStorage(),
      fetch: fetchMock,
    })

    const response = await session.fetch(`https://example.com/v1/chat`, {
      method: `POST`,
      body: JSON.stringify({ messages: [] }),
    })

    expect(await response.text()).toBe(`hello over sse`)
    session.close()
  })
})
