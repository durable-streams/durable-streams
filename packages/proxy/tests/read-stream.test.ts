/**
 * Tests for reading streams through the proxy.
 *
 * GET /v1/proxy/:streamId?expires=...&signature=...&offset=...&live=...
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import { generatePreSignedUrl } from "../src/server/tokens"
import { handleReadStream } from "../src/server/read-stream"
import {
  createSSEChunks,
  createStream,
  createTestContext,
  readStream,
} from "./harness"
import type { IncomingMessage, ServerResponse } from "node:http"

const TEST_SECRET = `test-secret-key-for-development`

const ctx = createTestContext()

beforeAll(async () => {
  await ctx.setup()
})

afterAll(async () => {
  await ctx.teardown()
})

describe(`stream reading`, () => {
  let streamUrl: string

  beforeEach(async () => {
    // Create a fresh stream for each test
    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: createSSEChunks([
        { data: `{"text": "Hello"}` },
        { data: `{"text": " World"}` },
      ]),
      chunkDelayMs: 10,
    })

    const result = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/chat/completions`,
      body: { messages: [] },
    })

    expect(result.status).toBe(201)
    streamUrl = result.streamUrl!

    // Wait for upstream to complete
    await new Promise((r) => setTimeout(r, 100))
  })

  it(`returns 401 when no authentication is provided`, async () => {
    // Construct a URL without expires/signature
    const streamId = new URL(streamUrl).pathname.split(`/`).pop()!
    const url = new URL(`/v1/proxy/${streamId}`, ctx.urls.proxy)
    url.searchParams.set(`offset`, `-1`)

    const response = await fetch(url.toString())

    expect(response.status).toBe(401)
    const body = await response.json()
    expect(body.error.code).toBe(`MISSING_SECRET`)
  })

  it(`returns 401 when signature is invalid`, async () => {
    const url = new URL(streamUrl)
    url.searchParams.set(`signature`, `invalid-signature`)
    url.searchParams.set(`offset`, `-1`)

    const response = await fetch(url.toString())

    expect(response.status).toBe(401)
  })

  it(`reads stream data with valid pre-signed URL`, async () => {
    const result = await readStream({
      streamUrl,
      offset: `-1`,
    })

    expect(result.status).toBe(200)
    expect(result.body).toContain(`Hello`)
    expect(result.body).toContain(`World`)
  })

  it(`returns next offset header`, async () => {
    const result = await readStream({
      streamUrl,
      offset: `-1`,
    })

    expect(result.status).toBe(200)
    expect(result.nextOffset).toBeDefined()
    expect(result.nextOffset).not.toBe(`-1`)
  })

  it(`supports reading from a specific offset`, async () => {
    // First read to get the tail offset
    const firstResult = await readStream({
      streamUrl,
      offset: `-1`,
    })

    expect(firstResult.nextOffset).toBeDefined()

    // Read from the end - should get no new data
    const secondResult = await readStream({
      streamUrl,
      offset: firstResult.nextOffset!,
    })

    // Should return empty or minimal response when at tail
    expect(secondResult.status).toBe(200)
  })

  it(`includes CORS headers in response`, async () => {
    const result = await readStream({
      streamUrl,
      offset: `-1`,
    })

    expect(result.headers.get(`access-control-allow-origin`)).toBe(`*`)
    expect(result.headers.get(`access-control-expose-headers`)).toContain(
      `Stream-Next-Offset`
    )
  })
})

describe(`stream reading - expired URLs`, () => {
  let streamUrl: string
  let streamId: string

  beforeEach(async () => {
    // Create a fresh stream for each test
    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: createSSEChunks([{ data: `{"text": "Hello"}` }]),
      chunkDelayMs: 10,
    })

    const result = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/chat/completions`,
      body: { messages: [] },
    })

    expect(result.status).toBe(201)
    streamUrl = result.streamUrl!
    streamId = new URL(streamUrl).pathname.split(`/`).pop()!

    // Wait for upstream to complete
    await new Promise((r) => setTimeout(r, 100))
  })

  it(`returns structured SIGNATURE_EXPIRED error for expired signed URLs`, async () => {
    // Generate an expired URL with valid HMAC
    const expiredAt = Math.floor(Date.now() / 1000) - 3600 // 1 hour ago
    const expiredUrl = generatePreSignedUrl(
      ctx.urls.proxy,
      streamId,
      TEST_SECRET,
      expiredAt
    )
    const url = new URL(expiredUrl)
    url.searchParams.set(`offset`, `-1`)

    const response = await fetch(url.toString())

    expect(response.status).toBe(401)
    const body = await response.json()
    expect(body.error.code).toBe(`SIGNATURE_EXPIRED`)
    expect(body.error.message).toBe(`Pre-signed URL has expired`)
    expect(body.error.streamId).toBe(streamId)
  })

  it(`returns structured SIGNATURE_EXPIRED error for connect-created streams`, async () => {
    const connectUrl = new URL(
      `/v1/proxy/read-expiry-session-1`,
      ctx.urls.proxy
    )
    connectUrl.searchParams.set(`secret`, TEST_SECRET)
    connectUrl.searchParams.set(`action`, `connect`)
    const connectRes = await fetch(connectUrl.toString(), {
      method: `POST`,
    })
    expect([200, 201]).toContain(connectRes.status)

    const location = connectRes.headers.get(`Location`)
    expect(location).toBeTruthy()
    const connectedUrl = new URL(location!, ctx.urls.proxy)
    const connectedStreamId = connectedUrl.pathname.split(`/`).pop()!
    const expiredAt = Math.floor(Date.now() / 1000) - 3600
    const expiredUrl = generatePreSignedUrl(
      ctx.urls.proxy,
      connectedStreamId,
      TEST_SECRET,
      expiredAt
    )
    const url = new URL(expiredUrl)
    url.searchParams.set(`offset`, `-1`)

    const response = await fetch(url.toString())
    expect(response.status).toBe(401)
    const body = await response.json()
    expect(body.error.code).toBe(`SIGNATURE_EXPIRED`)
    expect(body.error.streamId).toBe(connectedStreamId)
  })

  it(`returns structured SIGNATURE_EXPIRED error for expired URL with invalid HMAC`, async () => {
    // Construct URL with invalid signature
    const url = new URL(`/v1/proxy/${streamId}`, ctx.urls.proxy)
    const expiredAt = Math.floor(Date.now() / 1000) - 3600 // 1 hour ago
    url.searchParams.set(`expires`, expiredAt.toString())
    url.searchParams.set(`signature`, `invalid-signature`)
    url.searchParams.set(`offset`, `-1`)

    const response = await fetch(url.toString())

    expect(response.status).toBe(401)
    const body = await response.json()
    expect(body.error.code).toBe(`SIGNATURE_EXPIRED`)
    expect(body.error.message).toBe(`Pre-signed URL has expired`)
    expect(body.error.streamId).toBe(streamId)
  })
})

describe(`stream reading - offset=-1 replay`, () => {
  it(`reads from beginning when offset is -1`, async () => {
    // Create stream with known content
    ctx.upstream.setResponse({
      headers: { "Content-Type": `text/event-stream` },
      body: createSSEChunks([
        { data: `{"seq": 1}` },
        { data: `{"seq": 2}` },
        { data: `{"seq": 3}` },
      ]),
      chunkDelayMs: 10,
    })

    const createResult = await createStream({
      proxyUrl: ctx.urls.proxy,
      upstreamUrl: ctx.urls.upstream + `/v1/chat`,
      body: {},
    })

    await new Promise((r) => setTimeout(r, 150))

    // Read with offset=-1 should get all data
    const result = await readStream({
      streamUrl: createResult.streamUrl!,
      offset: `-1`,
    })

    expect(result.status).toBe(200)
    expect(result.body).toContain(`"seq": 1`)
    expect(result.body).toContain(`"seq": 2`)
    expect(result.body).toContain(`"seq": 3`)
  })
})

describe(`stream reading - cursor forwarding`, () => {
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
