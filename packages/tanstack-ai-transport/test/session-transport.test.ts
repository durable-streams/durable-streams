import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  durableStreamConnection,
  materializeSnapshotFromDurableStream,
} from "../src/client"
import { toDurableChatSessionResponse } from "../src/server"

type MockBatch = {
  items: ReadonlyArray<any>
  offset: string
  upToDate: boolean
}

type MockStreamResponse = {
  offset?: string
  subscribeJson: (subscriber: (batch: MockBatch) => void) => () => void
  closed: Promise<void>
  json: <T>() => Promise<Array<T>>
}

const {
  streamMock,
  createMock,
  appendMock,
  MockDurableStream,
  MockDurableStreamError,
} = vi.hoisted(() => {
  const streamMock = vi.fn()
  const createMock = vi.fn()
  const appendMock = vi.fn()

  class MockDurableStream {
    constructor(_options: any) {}

    create(...args: Array<any>) {
      return createMock(...args)
    }

    append(...args: Array<any>) {
      return appendMock(...args)
    }
  }

  class MockDurableStreamError extends Error {
    status?: number
    code?: string

    constructor(message: string, options?: { status?: number; code?: string }) {
      super(message)
      this.status = options?.status
      this.code = options?.code
    }
  }

  return {
    streamMock,
    createMock,
    appendMock,
    MockDurableStream,
    MockDurableStreamError,
  }
})

vi.mock(`@durable-streams/client`, () => ({
  stream: (...args: Array<any>) => streamMock(...args),
  DurableStream: MockDurableStream,
  DurableStreamError: MockDurableStreamError,
}))

function createStreamingResponse(
  batches: Array<MockBatch>
): MockStreamResponse {
  let resolveClosed: () => void = () => {}
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })

  let isCancelled = false
  const response: MockStreamResponse = {
    offset: batches[0]?.offset,
    subscribeJson(subscriber) {
      queueMicrotask(() => {
        for (const batch of batches) {
          if (isCancelled) break
          response.offset = batch.offset
          subscriber(batch)
        }
        resolveClosed()
      })
      return () => {
        isCancelled = true
        resolveClosed()
      }
    },
    closed,
    async json<T>() {
      return batches.flatMap((batch) => batch.items) as Array<T>
    },
  }

  return response
}

async function take(
  iterable: AsyncIterable<any>,
  count: number
): Promise<Array<any>> {
  const values: Array<any> = []
  for await (const value of iterable) {
    values.push(value)
    if (values.length >= count) break
  }
  return values
}

describe(`tanstack durable session transport`, () => {
  beforeEach(() => {
    streamMock.mockReset()
    createMock.mockReset().mockResolvedValue(undefined)
    appendMock.mockReset().mockResolvedValue(undefined)
  })

  it(`materializes snapshot text from incremental deltas`, async () => {
    streamMock.mockResolvedValue({
      json: async () => [
        { type: `TEXT_MESSAGE_START`, messageId: `u1`, role: `user` },
        { type: `TEXT_MESSAGE_CONTENT`, messageId: `u1`, delta: `Hi` },
        { type: `TEXT_MESSAGE_END`, messageId: `u1` },
        { type: `TEXT_MESSAGE_START`, messageId: `a1`, role: `assistant` },
        { type: `TEXT_MESSAGE_CONTENT`, messageId: `a1`, delta: `Hello` },
        { type: `TEXT_MESSAGE_CONTENT`, messageId: `a1`, delta: ` there` },
        { type: `TEXT_MESSAGE_END`, messageId: `a1` },
      ],
      offset: `24`,
    })

    const snapshot = await materializeSnapshotFromDurableStream({
      readUrl: `http://example.com/chat/abc`,
    })

    expect(snapshot.offset).toBe(`24`)
    expect(snapshot.messages).toHaveLength(2)
    expect(snapshot.messages[0]).toMatchObject({
      id: `u1`,
      role: `user`,
      parts: [{ type: `text`, content: `Hi` }],
    })
    expect(snapshot.messages[1]).toMatchObject({
      id: `a1`,
      role: `assistant`,
      parts: [{ type: `text`, content: `Hello there` }],
    })
  })

  it(`emits one snapshot with preserved user message id`, async () => {
    streamMock.mockResolvedValue(
      createStreamingResponse([
        {
          items: [
            {
              type: `TEXT_MESSAGE_START`,
              messageId: `user-msg-1`,
              role: `user`,
            },
            {
              type: `TEXT_MESSAGE_CONTENT`,
              messageId: `user-msg-1`,
              delta: `Hi`,
            },
            { type: `TEXT_MESSAGE_END`, messageId: `user-msg-1` },
          ],
          offset: `7`,
          upToDate: true,
        },
      ])
    )

    const connection = durableStreamConnection({
      sendUrl: `http://example.com/api/chat`,
      readUrl: `http://example.com/api/chat-stream?path=chat/abc`,
    })

    const [snapshot] = await take(connection.subscribe(), 1)
    expect(snapshot.type).toBe(`MESSAGES_SNAPSHOT`)
    expect(snapshot.messages).toHaveLength(1)
    expect(snapshot.messages[0].id).toBe(`user-msg-1`)
  })

  it(`resumes subscription from SSR offset without replay snapshot`, async () => {
    streamMock.mockResolvedValue(
      createStreamingResponse([
        {
          items: [{ type: `RUN_STARTED`, runId: `run-1` }],
          offset: `55`,
          upToDate: true,
        },
      ])
    )

    const connection = durableStreamConnection({
      sendUrl: `http://example.com/api/chat`,
      readUrl: `http://example.com/api/chat-stream?path=chat/abc`,
      initialOffset: `42`,
    })

    const events = await take(connection.subscribe(), 1)
    expect(events).toEqual([{ type: `RUN_STARTED`, runId: `run-1` }])
    expect(streamMock).toHaveBeenCalledWith(
      expect.objectContaining({
        offset: `42`,
      })
    )
  })

  it(`continues from latest offset after refresh during active generation`, async () => {
    streamMock
      .mockResolvedValueOnce(
        createStreamingResponse([
          {
            items: [{ type: `RUN_STARTED`, runId: `run-1` }],
            offset: `10`,
            upToDate: false,
          },
          {
            items: [
              { type: `TEXT_MESSAGE_CONTENT`, messageId: `a1`, delta: `Hi` },
            ],
            offset: `20`,
            upToDate: true,
          },
        ])
      )
      .mockResolvedValueOnce(
        createStreamingResponse([
          {
            items: [
              {
                type: `TEXT_MESSAGE_CONTENT`,
                messageId: `a1`,
                delta: ` again`,
              },
            ],
            offset: `30`,
            upToDate: false,
          },
        ])
      )

    const connection = durableStreamConnection({
      sendUrl: `http://example.com/api/chat`,
      readUrl: `http://example.com/api/chat-stream?path=chat/abc`,
      initialOffset: `5`,
    })

    await take(connection.subscribe(), 2)
    await take(connection.subscribe(), 1)

    expect(streamMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        offset: `20`,
      })
    )
  })

  it(`returns empty immediate chat-session response`, async () => {
    const response = await toDurableChatSessionResponse({
      stream: {
        writeUrl: `http://example.com/chat/abc`,
      },
      newMessages: [
        {
          id: `user-1`,
          role: `user`,
          parts: [{ type: `text`, content: `Hello` }],
        },
      ],
      responseStream: (async function* () {
        yield {
          type: `TEXT_MESSAGE_START`,
          messageId: `assistant-1`,
          role: `assistant`,
        }
        yield {
          type: `TEXT_MESSAGE_CONTENT`,
          messageId: `assistant-1`,
          delta: `Hi there`,
        }
      })(),
    })

    expect(response.status).toBe(202)
    expect(response.headers.get(`Location`)).toBeNull()
    expect(await response.text()).toBe(``)
  })

  it(`returns empty await chat-session response`, async () => {
    const response = await toDurableChatSessionResponse({
      stream: {
        writeUrl: `http://example.com/chat/abc`,
      },
      mode: `await`,
      newMessages: [],
      responseStream: (async function* () {})(),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get(`Location`)).toBeNull()
    expect(await response.text()).toBe(``)
  })
})
