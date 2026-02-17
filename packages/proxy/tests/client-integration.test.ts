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
      sessionId: `session-1`,
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
      sessionId: `session-abort`,
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
      sessionId: `session-concurrent`,
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
      sessionId: `session-shared-response`,
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
