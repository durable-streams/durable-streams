import { describe, expect, it, vi } from "vitest"
import { handleHeadStream } from "../../../src/server/head-stream"
import type { IncomingMessage, ServerResponse } from "node:http"

describe(`server unit: handleHeadStream`, () => {
  it(`returns 502 when durable storage HEAD fails`, async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(`upstream error`, { status: 503 })
    })
    vi.stubGlobal(`fetch`, fetchMock)

    const req = {
      url: `/v1/proxy/failed-metadata?secret=test-secret-key-for-development`,
      headers: { host: `proxy.test` },
      method: `HEAD`,
    } as unknown as IncomingMessage

    const written = {
      status: 0,
      body: ``,
      headers: {} as Record<string, string>,
    }
    const res = {
      headersSent: false,
      writeHead(status: number, headers: Record<string, string>) {
        written.status = status
        written.headers = headers
        return undefined
      },
      end(body?: string) {
        written.body = body ?? ``
        return undefined
      },
    } as unknown as ServerResponse

    await handleHeadStream(
      req,
      res,
      `failed-metadata`,
      {
        durableStreamsUrl: `http://durable.example`,
        jwtSecret: `test-secret-key-for-development`,
      },
      new Map()
    )

    expect(written.status).toBe(502)
    expect(written.body).toContain(`STORAGE_ERROR`)
    vi.unstubAllGlobals()
  })
})
