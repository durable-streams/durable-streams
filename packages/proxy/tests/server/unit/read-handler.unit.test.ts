import { describe, expect, it, vi } from "vitest"
import { handleReadStream } from "../../../src/server/read-stream"
import type { IncomingMessage, ServerResponse } from "node:http"

const TEST_SECRET = `test-secret-key-for-development`

describe(`server unit: handleReadStream`, () => {
  it(`forwards cursor query parameter to durable streams`, async () => {
    const fetchMock = vi.fn(() => {
      return new Response(``, {
        status: 200,
        headers: {
          "content-type": `application/octet-stream`,
        },
      })
    })
    vi.stubGlobal(`fetch`, fetchMock)

    const req = {
      url: `/v1/proxy/cursor-forwarded?secret=${encodeURIComponent(TEST_SECRET)}&offset=-1&live=long-poll&cursor=cursor-token`,
      headers: { host: `proxy.test` },
      method: `GET`,
    } as unknown as IncomingMessage

    const responseHeaders: Record<string, string> = {}
    const res = {
      headersSent: false,
      writeHead(_status: number, headers: Record<string, string>) {
        Object.assign(responseHeaders, headers)
        return undefined
      },
      end() {
        return undefined
      },
      write() {
        return true
      },
      once(_event: string, listener: () => void) {
        listener()
        return undefined
      },
      setHeader(name: string, value: string) {
        responseHeaders[name] = value
      },
    } as unknown as ServerResponse

    await handleReadStream(
      req,
      res,
      `cursor-forwarded`,
      {
        durableStreamsUrl: `http://durable.example`,
        jwtSecret: TEST_SECRET,
      },
      new Map()
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const mockCalls = fetchMock.mock.calls as Array<Array<unknown>>
    const calledUrl = String(mockCalls[0]?.[0] ?? ``)
    const dsUrl = new URL(calledUrl)
    expect(dsUrl.searchParams.get(`cursor`)).toBe(`cursor-token`)

    vi.unstubAllGlobals()
  })

  it(`forwards Stream-SSE-Data-Encoding header from durable streams`, async () => {
    const fetchMock = vi.fn(() => {
      return new Response(
        `event: control\ndata: {"streamNextOffset":"1_1"}\n\n`,
        {
          status: 200,
          headers: {
            "content-type": `text/event-stream`,
            "stream-sse-data-encoding": `base64`,
            "stream-next-offset": `1_1`,
          },
        }
      )
    })
    vi.stubGlobal(`fetch`, fetchMock)

    const req = {
      url: `/v1/proxy/stream-sse-encoding?secret=${encodeURIComponent(TEST_SECRET)}&offset=-1&live=sse`,
      headers: { host: `proxy.test`, accept: `text/event-stream` },
      method: `GET`,
    } as unknown as IncomingMessage

    const responseHeaders: Record<string, string> = {}
    const res = {
      headersSent: false,
      writeHead(_status: number, headers: Record<string, string>) {
        Object.assign(responseHeaders, headers)
        return undefined
      },
      end() {
        return undefined
      },
      write() {
        return true
      },
      once(_event: string, listener: () => void) {
        listener()
        return undefined
      },
      setHeader(name: string, value: string) {
        responseHeaders[name] = value
      },
    } as unknown as ServerResponse

    await handleReadStream(
      req,
      res,
      `stream-sse-encoding`,
      {
        durableStreamsUrl: `http://durable.example`,
        jwtSecret: TEST_SECRET,
      },
      new Map()
    )

    expect(responseHeaders[`stream-sse-data-encoding`]).toBe(`base64`)
    expect(responseHeaders[`Access-Control-Expose-Headers`]).toContain(
      `Stream-SSE-Data-Encoding`
    )

    vi.unstubAllGlobals()
  })
})
