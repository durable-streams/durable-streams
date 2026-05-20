import { describe, expect, it, vi } from "vitest"

import { toDurableStreamResponse } from "../src/server"

const {
  appendMock,
  closeMock,
  createMock,
  MockDurableStream,
  MockDurableStreamError,
} = vi.hoisted(() => {
  const appendMock = vi.fn()
  const closeMock = vi.fn()
  const createMock = vi.fn()

  class MockDurableStream {
    constructor(_opts: any) {}
    create(...args: Array<any>) {
      return createMock(...args)
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

  return {
    appendMock,
    closeMock,
    createMock,
    MockDurableStream,
    MockDurableStreamError,
  }
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

describe(`aisdk-transport writeSourceToStream batching`, () => {
  it(`does not block source iteration on append() resolution`, async () => {
    appendMock.mockReset()
    createMock.mockReset().mockResolvedValue(undefined)
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
        yield { type: `text-delta`, text: `chunk-${i}` }
      }
    })()

    const responsePromise = toDurableStreamResponse({
      source,
      stream: {
        writeUrl: `https://example.com/s`,
        readUrl: `https://example.com/s`,
      },
      mode: `await`,
    })

    await new Promise((r) => setTimeout(r, 0))
    expect(produced).toBe(5)
    expect(appendMock).toHaveBeenCalledTimes(5)

    for (const d of pendings) d.resolve()
    const response = await responsePromise
    expect(response.status).toBe(200)
  })

  it(`awaits pending appends before close()`, async () => {
    appendMock.mockReset()
    createMock.mockReset().mockResolvedValue(undefined)
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
      yield { type: `text-delta`, text: `a` }
      yield { type: `text-delta`, text: `b` }
    })()

    const responsePromise = toDurableStreamResponse({
      source,
      stream: { writeUrl: `https://example.com/s` },
      mode: `await`,
    })

    await new Promise((r) => setTimeout(r, 0))
    queueMicrotask(() => {
      for (const d of pendings) d.resolve()
    })

    await responsePromise
    expect(appendsResolvedAt).toBeGreaterThanOrEqual(0)
    expect(closeCalledAt).toBeGreaterThan(appendsResolvedAt)
  })

  it(`surfaces append errors`, async () => {
    appendMock.mockReset()
    createMock.mockReset().mockResolvedValue(undefined)
    closeMock.mockReset().mockResolvedValue({ finalOffset: `0` })

    appendMock.mockImplementationOnce(() => Promise.resolve())
    appendMock.mockImplementationOnce(() => Promise.reject(new Error(`boom`)))

    const source = (async function* () {
      yield { type: `text-delta`, text: `a` }
      yield { type: `text-delta`, text: `b` }
    })()

    await expect(
      toDurableStreamResponse({
        source,
        stream: { writeUrl: `https://example.com/s` },
        mode: `await`,
      })
    ).rejects.toThrow(/boom/)

    expect(closeMock).toHaveBeenCalledTimes(1)
  })
})
