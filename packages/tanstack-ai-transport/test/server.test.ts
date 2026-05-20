import { describe, expect, it, vi } from "vitest"

import {
  appendSanitizedChunksToStream,
  pipeSanitizedChunksToStream,
  toDurableStreamResponse,
} from "../src/server"

const { appendMock, closeMock, MockDurableStream, MockDurableStreamError } =
  vi.hoisted(() => {
    const appendMock = vi.fn()
    const closeMock = vi.fn()

    class MockDurableStream {
      constructor(_opts: any) {}
      create() {
        return Promise.resolve()
      }
      append(...args: Array<any>) {
        return appendMock(...args)
      }
      close(...args: Array<any>) {
        return closeMock(...args)
      }
    }

    class MockDurableStreamError extends Error {
      status?: number
      code?: string
      constructor(message: string, opts?: { status?: number; code?: string }) {
        super(message)
        this.status = opts?.status
        this.code = opts?.code
      }
    }

    return { appendMock, closeMock, MockDurableStream, MockDurableStreamError }
  })

vi.mock(`@durable-streams/client`, () => ({
  DurableStream: MockDurableStream,
  DurableStreamError: MockDurableStreamError,
}))

type Deferred = {
  promise: Promise<void>
  resolve: () => void
  reject: (e: unknown) => void
}

function deferred(): Deferred {
  let resolve!: () => void
  let reject!: (e: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = () => res()
    reject = rej
  })
  return { promise, resolve, reject }
}

describe(`tanstack-ai-transport writeSourceToStream batching`, () => {
  it(`does not block source iteration on append() resolution`, async () => {
    appendMock.mockReset()
    closeMock.mockReset().mockResolvedValue({ finalOffset: `0` })

    const pendings: Array<Deferred> = []
    appendMock.mockImplementation(() => {
      const d = deferred()
      pendings.push(d)
      return d.promise
    })

    let produced = 0
    const source = (async function* () {
      for (let i = 0; i < 5; i++) {
        produced++
        yield { type: `TEXT_MESSAGE_CONTENT`, delta: `chunk-${i}` }
      }
    })()

    const responsePromise = toDurableStreamResponse(source, {
      stream: {
        writeUrl: `https://example.com/s`,
        readUrl: `https://example.com/s`,
        createIfMissing: false,
      },
      mode: `await`,
    })

    // Yield to let the iterator run. With per-chunk await, only 1 append
    // is pending. With the new non-blocking loop, all 5 should be pending.
    await new Promise((r) => setTimeout(r, 0))

    expect(produced).toBe(5)
    expect(appendMock).toHaveBeenCalledTimes(5)

    for (const d of pendings) d.resolve()
    const response = await responsePromise
    expect(response.status).toBe(200)
  })

  it(`awaits all pending appends before close()`, async () => {
    appendMock.mockReset()
    closeMock.mockReset().mockResolvedValue({ finalOffset: `0` })

    let closeCalledAt = -1
    let appendsResolvedAt = -1
    let tick = 0

    const pendings: Array<Deferred> = []
    appendMock.mockImplementation(() => {
      const d = deferred()
      pendings.push(d)
      return d.promise.then(() => {
        appendsResolvedAt = tick++
      })
    })
    closeMock.mockImplementation(() => {
      closeCalledAt = tick++
      return Promise.resolve({ finalOffset: `0` })
    })

    const source = (async function* () {
      yield { type: `TEXT_MESSAGE_CONTENT`, delta: `a` }
      yield { type: `TEXT_MESSAGE_CONTENT`, delta: `b` }
    })()

    const responsePromise = toDurableStreamResponse(source, {
      stream: { writeUrl: `https://example.com/s`, createIfMissing: false },
      mode: `await`,
    })

    await new Promise((r) => setTimeout(r, 0))
    // Resolve appends only after a delay; close must wait.
    queueMicrotask(() => {
      for (const d of pendings) d.resolve()
    })

    await responsePromise
    expect(appendsResolvedAt).toBeGreaterThanOrEqual(0)
    expect(closeCalledAt).toBeGreaterThan(appendsResolvedAt)
  })

  it(`surfaces append errors from the latest pending promise`, async () => {
    appendMock.mockReset()
    closeMock.mockReset().mockResolvedValue({ finalOffset: `0` })

    appendMock.mockImplementationOnce(() => Promise.resolve())
    appendMock.mockImplementationOnce(() => Promise.reject(new Error(`boom`)))

    const source = (async function* () {
      yield { type: `TEXT_MESSAGE_CONTENT`, delta: `a` }
      yield { type: `TEXT_MESSAGE_CONTENT`, delta: `b` }
    })()

    await expect(
      toDurableStreamResponse(source, {
        stream: { writeUrl: `https://example.com/s`, createIfMissing: false },
        mode: `await`,
      })
    ).rejects.toThrow(/boom/)

    expect(closeMock).toHaveBeenCalledTimes(1)
  })
})

describe(`tanstack-ai-transport pipeSanitizedChunksToStream batching`, () => {
  it(`does not block on append()`, async () => {
    appendMock.mockReset()
    const pendings: Array<Deferred> = []
    appendMock.mockImplementation(() => {
      const d = deferred()
      pendings.push(d)
      return d.promise
    })

    const source = (async function* () {
      yield { type: `TEXT_MESSAGE_CONTENT`, delta: `a` }
      yield { type: `TEXT_MESSAGE_CONTENT`, delta: `b` }
      yield { type: `TEXT_MESSAGE_CONTENT`, delta: `c` }
    })()

    const stream = new MockDurableStream({ url: `x` }) as any
    const done = pipeSanitizedChunksToStream(source, stream)

    await new Promise((r) => setTimeout(r, 0))
    expect(appendMock).toHaveBeenCalledTimes(3)

    for (const d of pendings) d.resolve()
    await done
  })
})

describe(`tanstack-ai-transport appendSanitizedChunksToStream batching`, () => {
  it(`fires all appends without per-item blocking`, async () => {
    appendMock.mockReset()
    const pendings: Array<Deferred> = []
    appendMock.mockImplementation(() => {
      const d = deferred()
      pendings.push(d)
      return d.promise
    })

    const stream = new MockDurableStream({ url: `x` }) as any
    const chunks = [
      { type: `TEXT_MESSAGE_START`, messageId: `m1`, role: `user` as const },
      { type: `TEXT_MESSAGE_END`, messageId: `m1` },
    ]
    const done = appendSanitizedChunksToStream(stream, chunks as any)
    await new Promise((r) => setTimeout(r, 0))
    expect(appendMock).toHaveBeenCalledTimes(2)
    for (const d of pendings) d.resolve()
    await done
  })
})
