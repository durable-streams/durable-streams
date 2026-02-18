import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import {
  MemoryStorage,
  createAbortFn,
  createDurableFetch,
  createDurableSession,
  createRequestIdStorageKey,
  loadRequestIdMapping,
} from "../src/client"
import { createDurableAdapter } from "../src/transports/tanstack"
import { createDurableChatTransport } from "../src/transports/vercel"
import { createAIStreamingResponse, createTestContext } from "./harness"

const ctx = createTestContext()
const TEST_SECRET = `test-secret-key-for-development`
const encoder = new TextEncoder()

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

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString(`base64`)
}

function createFragmentedSSEBody(
  sseText: string,
  splitIndexes: Array<number>
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let start = 0
      for (const end of splitIndexes) {
        controller.enqueue(encoder.encode(sseText.slice(start, end)))
        start = end
      }
      controller.enqueue(encoder.encode(sseText.slice(start)))
      controller.close()
    },
  })
}

beforeAll(async () => {
  await ctx.setup()
})

afterAll(async () => {
  await ctx.teardown()
}, 60000)

describe(`createDurableFetch`, () => {
  let storage: MemoryStorage

  beforeEach(() => {
    storage = new MemoryStorage()
  })

  it(`returns a framed response with responseId`, async () => {
    ctx.upstream.setResponse(createAIStreamingResponse([`Hello`]))
    const durableFetch = createDurableFetch({
      proxyUrl: `${ctx.urls.proxy}/v1/proxy`,
      proxyAuthorization: TEST_SECRET,
      storage,
    })

    const response = await durableFetch(ctx.urls.upstream + `/v1/chat`, {
      method: `POST`,
      headers: { "Content-Type": `application/json` },
      body: JSON.stringify({ messages: [] }),
    })

    expect(response.ok).toBe(true)
    expect(response.responseId).toBe(1)
    expect(response.streamUrl).toBeDefined()
    expect(response.body).toBeDefined()
  })

  it(`stores requestId mapping in one-off key format`, async () => {
    ctx.upstream.setResponse(createAIStreamingResponse([`Token`]))
    const durableFetch = createDurableFetch({
      proxyUrl: `${ctx.urls.proxy}/v1/proxy`,
      proxyAuthorization: TEST_SECRET,
      storage,
    })
    const proxyUrl = `${ctx.urls.proxy}/v1/proxy`
    const requestId = `request-id-test`

    await durableFetch(ctx.urls.upstream + `/v1/chat`, {
      method: `POST`,
      body: JSON.stringify({ messages: [] }),
      requestId,
    })

    const key = createRequestIdStorageKey(
      `durable-streams:`,
      proxyUrl,
      requestId
    )
    const raw = storage.getItem(key)
    expect(raw).toBeTruthy()
    const mapping = loadRequestIdMapping(
      storage,
      `durable-streams:`,
      proxyUrl,
      requestId
    )
    expect(mapping?.responseId).toBe(1)
    expect(mapping?.streamUrl).toBeTruthy()
  })
})

describe(`createDurableSession`, () => {
  it(`connects and appends with sequential response IDs`, async () => {
    ctx.upstream.setResponse(createAIStreamingResponse([`A`]))
    const session = createDurableSession({
      proxyUrl: `${ctx.urls.proxy}/v1/proxy`,
      proxyAuthorization: TEST_SECRET,
      streamId: `session-1`,
      storage: new MemoryStorage(),
    })

    const first = await session.fetch(ctx.urls.upstream + `/v1/chat`, {
      method: `POST`,
      body: JSON.stringify({ messages: [] }),
    })
    expect(first.responseId).toBe(1)

    ctx.upstream.setResponse(createAIStreamingResponse([`B`]))
    const second = await session.fetch(ctx.urls.upstream + `/v1/chat`, {
      method: `POST`,
      body: JSON.stringify({ messages: [] }),
    })
    expect(second.responseId).toBe(2)
    session.close()
  })

  it(`aborts active session stream`, async () => {
    const session = createDurableSession({
      proxyUrl: `${ctx.urls.proxy}/v1/proxy`,
      proxyAuthorization: TEST_SECRET,
      streamId: `session-abort`,
      storage: new MemoryStorage(),
    })
    await session.connect()
    await session.abort()
    session.close()
  })

  it(`supports concurrent fetch calls on one session`, async () => {
    ctx.upstream.setResponse(createAIStreamingResponse([`parallel`], 10))
    const session = createDurableSession({
      proxyUrl: `${ctx.urls.proxy}/v1/proxy`,
      proxyAuthorization: TEST_SECRET,
      streamId: `session-concurrent`,
      storage: new MemoryStorage(),
    })

    const [first, second] = await Promise.all([
      session.fetch(ctx.urls.upstream + `/v1/chat`, {
        method: `POST`,
        requestId: `parallel-1`,
        body: JSON.stringify({ messages: [{ role: `user`, content: `A` }] }),
      }),
      session.fetch(ctx.urls.upstream + `/v1/chat`, {
        method: `POST`,
        requestId: `parallel-2`,
        body: JSON.stringify({ messages: [{ role: `user`, content: `B` }] }),
      }),
    ])

    expect([first.responseId, second.responseId].sort((a, b) => a - b)).toEqual(
      [1, 2]
    )
    expect(first.body).toBeDefined()
    expect(second.body).toBeDefined()
    session.close()
  })

  it(`shares the same response object between fetch and responses`, async () => {
    ctx.upstream.setResponse(createAIStreamingResponse([`shared`], 10))
    const session = createDurableSession({
      proxyUrl: `${ctx.urls.proxy}/v1/proxy`,
      proxyAuthorization: TEST_SECRET,
      streamId: `session-shared-response`,
      storage: new MemoryStorage(),
    })

    const iterator = session.responses()[Symbol.asyncIterator]()
    const fetched = await session.fetch(ctx.urls.upstream + `/v1/chat`, {
      method: `POST`,
      requestId: `shared-1`,
      body: JSON.stringify({ messages: [] }),
    })
    const yielded = await iterator.next()

    expect(yielded.done).toBe(false)
    expect(yielded.value).toBe(fetched)
    session.close()
  })

  it(`decodes base64 SSE data and parses framed response bytes`, async () => {
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

    const firstChunk = framed.slice(0, 13)
    const secondChunk = framed.slice(13)
    const sse = [
      `event: data`,
      `data: ${toBase64(firstChunk)}`,
      ``,
      `event: data`,
      `data: ${toBase64(secondChunk)}`,
      ``,
      `event: control`,
      `data: {"streamNextOffset":"5_5"}`,
      ``,
    ].join(`\n`)

    let readCallCount = 0
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input)
      if (url.includes(`action=connect`)) {
        return new Response(null, {
          status: 201,
          headers: {
            Location: `${ctx.urls.proxy}/v1/proxy/sse-base64-session?expires=1&signature=sig`,
          },
        })
      }
      if (
        init?.method === `POST` &&
        url.includes(`/v1/proxy/sse-base64-session`)
      ) {
        return new Response(null, {
          status: 200,
          headers: {
            Location: `${ctx.urls.proxy}/v1/proxy/sse-base64-session?expires=1&signature=sig`,
            "Stream-Response-Id": `1`,
          },
        })
      }
      if (
        init?.method !== `POST` &&
        url.includes(`/v1/proxy/sse-base64-session`)
      ) {
        readCallCount += 1
        if (readCallCount === 1) {
          return new Response(sse, {
            status: 200,
            headers: {
              "content-type": `text/event-stream`,
              "stream-sse-data-encoding": `base64`,
            },
          })
        }
        return new Response(``, { status: 500 })
      }
      throw new Error(`unexpected request: ${url}`)
    }

    const session = createDurableSession({
      proxyUrl: `${ctx.urls.proxy}/v1/proxy`,
      proxyAuthorization: TEST_SECRET,
      streamId: `sse-base64-session`,
      storage: new MemoryStorage(),
      fetch: fetchMock,
    })

    const response = await session.fetch(ctx.urls.upstream + `/v1/chat`, {
      method: `POST`,
      body: JSON.stringify({ messages: [] }),
    })

    expect(response.responseId).toBe(1)
    expect(await response.text()).toBe(`hello over sse`)
    session.close()
  })

  it(`handles fragmented SSE chunks and multiline data payloads`, async () => {
    const startPayload = encoder.encode(
      JSON.stringify({
        status: 200,
        headers: { "content-type": `text/plain` },
      })
    )
    const bodyPayload = encoder.encode(`chunk boundary test`)
    const framed = concatBytes(
      encodeFrame(`S`, 1, startPayload),
      encodeFrame(`D`, 1, bodyPayload),
      encodeFrame(`C`, 1, new Uint8Array(0))
    )
    const dataBase64 = toBase64(framed)
    const midpoint = Math.floor(dataBase64.length / 2)
    const sse = [
      `event: data`,
      `data: ${dataBase64.slice(0, midpoint)}`,
      `data: ${dataBase64.slice(midpoint)}`,
      ``,
      `event: control`,
      `data: {"streamNextOffset":"9_9"}`,
      ``,
    ].join(`\n`)

    let readCallCount = 0
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input)
      if (url.includes(`action=connect`)) {
        return new Response(null, {
          status: 201,
          headers: {
            Location: `${ctx.urls.proxy}/v1/proxy/sse-fragment-session?expires=1&signature=sig`,
          },
        })
      }
      if (
        init?.method === `POST` &&
        url.includes(`/v1/proxy/sse-fragment-session`)
      ) {
        return new Response(null, {
          status: 200,
          headers: {
            Location: `${ctx.urls.proxy}/v1/proxy/sse-fragment-session?expires=1&signature=sig`,
            "Stream-Response-Id": `1`,
          },
        })
      }
      if (
        init?.method !== `POST` &&
        url.includes(`/v1/proxy/sse-fragment-session`)
      ) {
        readCallCount += 1
        if (readCallCount === 1) {
          return new Response(
            createFragmentedSSEBody(sse, [5, 18, 41, 87, 131]),
            {
              status: 200,
              headers: {
                "content-type": `text/event-stream`,
                "stream-sse-data-encoding": `base64`,
              },
            }
          )
        }
        return new Response(``, { status: 500 })
      }
      throw new Error(`unexpected request: ${url}`)
    }

    const session = createDurableSession({
      proxyUrl: `${ctx.urls.proxy}/v1/proxy`,
      proxyAuthorization: TEST_SECRET,
      streamId: `sse-fragment-session`,
      storage: new MemoryStorage(),
      fetch: fetchMock,
    })

    const response = await session.fetch(ctx.urls.upstream + `/v1/chat`, {
      method: `POST`,
      body: JSON.stringify({ messages: [] }),
    })

    expect(await response.text()).toBe(`chunk boundary test`)
    session.close()
  })

  it(`advances read offset from SSE control events`, async () => {
    const startPayload = encoder.encode(
      JSON.stringify({
        status: 200,
        headers: { "content-type": `text/plain` },
      })
    )
    const bodyPayload = encoder.encode(`offset`)
    const framed = concatBytes(
      encodeFrame(`S`, 1, startPayload),
      encodeFrame(`D`, 1, bodyPayload),
      encodeFrame(`C`, 1, new Uint8Array(0))
    )
    const sse = [
      `event: data`,
      `data: ${toBase64(framed)}`,
      ``,
      `event: control`,
      `data: {"streamNextOffset":"22_22"}`,
      ``,
      ``,
    ].join(`\n`)

    const readUrls: Array<string> = []
    let readCallCount = 0
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input)
      if (url.includes(`action=connect`)) {
        return new Response(null, {
          status: 201,
          headers: {
            Location: `${ctx.urls.proxy}/v1/proxy/sse-offset-session?expires=1&signature=sig`,
          },
        })
      }
      if (
        init?.method === `POST` &&
        url.includes(`/v1/proxy/sse-offset-session`)
      ) {
        return new Response(null, {
          status: 200,
          headers: {
            Location: `${ctx.urls.proxy}/v1/proxy/sse-offset-session?expires=1&signature=sig`,
            "Stream-Response-Id": `1`,
          },
        })
      }
      if (
        init?.method !== `POST` &&
        url.includes(`/v1/proxy/sse-offset-session`)
      ) {
        readUrls.push(url)
        readCallCount += 1
        if (readCallCount === 1) {
          return new Response(sse, {
            status: 200,
            headers: {
              "content-type": `text/event-stream`,
              "stream-sse-data-encoding": `base64`,
            },
          })
        }
        if (readCallCount === 2) {
          return new Response(
            `event: control\ndata: {"streamNextOffset":"23_23"}\n\n`,
            {
              status: 200,
              headers: {
                "content-type": `text/event-stream`,
              },
            }
          )
        }
        return new Response(``, { status: 500 })
      }
      throw new Error(`unexpected request: ${url}`)
    }

    const session = createDurableSession({
      proxyUrl: `${ctx.urls.proxy}/v1/proxy`,
      proxyAuthorization: TEST_SECRET,
      streamId: `sse-offset-session`,
      storage: new MemoryStorage(),
      fetch: fetchMock,
    })

    const response = await session.fetch(ctx.urls.upstream + `/v1/chat`, {
      method: `POST`,
      body: JSON.stringify({ messages: [] }),
    })
    expect(await response.text()).toBe(`offset`)

    // Wait briefly for the reader loop to issue the second read.
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(readUrls[0]).toContain(`offset=-1`)
    expect(readUrls[1]).toContain(`offset=22_22`)
    session.close()
  })
})

describe(`transport integration`, () => {
  it(`tanstack adapter can open and abort stream`, async () => {
    const adapter = createDurableAdapter(ctx.urls.upstream + `/v1/chat`, {
      proxyUrl: `${ctx.urls.proxy}/v1/proxy`,
      proxyAuthorization: TEST_SECRET,
      storage: new MemoryStorage(),
      getRequestId: () => `adapter-request`,
    })
    ctx.upstream.setResponse(createAIStreamingResponse([`Adapter`], 20))
    const connection = await adapter.connect({
      url: ctx.urls.upstream + `/v1/chat`,
      body: { messages: [] },
    })
    expect(connection.stream).toBeDefined()
    await adapter.abort()
  })

  it(`createAbortFn sends abort PATCH`, async () => {
    ctx.upstream.setResponse(createAIStreamingResponse([`abort-me`], 100))
    const durableFetch = createDurableFetch({
      proxyUrl: `${ctx.urls.proxy}/v1/proxy`,
      proxyAuthorization: TEST_SECRET,
      storage: new MemoryStorage(),
    })
    const response = await durableFetch(ctx.urls.upstream + `/v1/chat`, {
      method: `POST`,
      body: JSON.stringify({ messages: [] }),
    })

    expect(response.streamUrl).toBeDefined()
    const abort = createAbortFn(response.streamUrl as string)
    await abort()
  })

  it(`vercel transport sends and receives stream`, async () => {
    ctx.upstream.setResponse(createAIStreamingResponse([`Vercel`], 20))
    const transport = createDurableChatTransport({
      api: ctx.urls.upstream + `/v1/chat`,
      proxyUrl: `${ctx.urls.proxy}/v1/proxy`,
      proxyAuthorization: TEST_SECRET,
      storage: new MemoryStorage(),
      getRequestId: () => `vercel-request`,
    })

    const result = await transport.send({
      messages: [{ role: `user`, content: `hello` }],
    })

    expect(result.status).toBe(200)
    expect(result.stream).toBeDefined()
  })
})
