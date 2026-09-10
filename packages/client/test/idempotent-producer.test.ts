import { setImmediate as nextTurn } from "node:timers/promises"
import { describe, expect, it, vi } from "vitest"
import {
  PRODUCER_SEQ_HEADER,
  SSE_CLOSED_FIELD,
  SSE_CURSOR_FIELD,
  SSE_OFFSET_FIELD,
  STREAM_OFFSET_HEADER,
} from "../src"
import { IdempotentProducer } from "../src/idempotent-producer"
import { DurableStream } from "../src/stream"

describe(`IdempotentProducer`, () => {
  // NaN cannot be represented by the JSON conformance adapter protocol.
  it.each([NaN, 0.5])(`rejects maxInFlight=%s`, (maxInFlight) => {
    const stream = new DurableStream({ url: `https://example.com/stream` })

    expect(
      () => new IdempotentProducer(stream, `test-producer`, { maxInFlight })
    ).toThrow()
  })

  const offset = (chunk: number, byte: number): string =>
    `${String(chunk).padStart(16, `0`)}_${String(byte).padStart(16, `0`)}`

  it(`tracks the last successful append offset`, async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 200,
          headers: { [STREAM_OFFSET_HEADER]: `1_5` },
        })
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 200,
          headers: { [STREAM_OFFSET_HEADER]: `2_10` },
        })
      )
    const stream = new DurableStream({
      url: `https://example.com/stream`,
      contentType: `application/json`,
    })
    const producer = new IdempotentProducer(stream, `test-producer`, {
      fetch: mockFetch,
    })

    expect(producer.lastSuccessfulOffset).toBeUndefined()

    producer.append(JSON.stringify({ message: `first` }))
    await producer.flush()
    expect(producer.lastSuccessfulOffset).toBe(`1_5`)

    producer.append(JSON.stringify({ message: `second` }))
    await producer.flush()
    expect(producer.lastSuccessfulOffset).toBe(`2_10`)
  })

  it(`does not clear the last successful offset on duplicate writes`, async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 200,
          headers: { [STREAM_OFFSET_HEADER]: `1_5` },
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    const stream = new DurableStream({
      url: `https://example.com/stream`,
      contentType: `application/json`,
    })
    const producer = new IdempotentProducer(stream, `test-producer`, {
      fetch: mockFetch,
    })

    producer.append(JSON.stringify({ message: `first` }))
    await producer.flush()
    producer.append(JSON.stringify({ message: `duplicate` }))
    await producer.flush()

    expect(producer.lastSuccessfulOffset).toBe(`1_5`)
  })

  it(`does not move the last successful offset backward when writes complete out of order`, async () => {
    let resolveFirst: ((response: Response) => void) | undefined
    const first = new Promise<Response>((resolve) => {
      resolveFirst = resolve
    })
    const mockFetch = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(
        new Response(null, {
          status: 200,
          headers: { [STREAM_OFFSET_HEADER]: offset(0, 10) },
        })
      )
    const stream = new DurableStream({
      url: `https://example.com/stream`,
      contentType: `text/plain`,
    })
    const producer = new IdempotentProducer(stream, `test-producer`, {
      fetch: mockFetch,
      maxBatchBytes: 1,
    })

    producer.append(`a`)
    producer.append(`b`)
    const flushed = producer.flush()
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2))
    await vi.waitFor(() =>
      expect(producer.lastSuccessfulOffset).toBe(offset(0, 10))
    )

    resolveFirst!(
      new Response(null, {
        status: 200,
        headers: { [STREAM_OFFSET_HEADER]: offset(0, 5) },
      })
    )
    await flushed

    expect(producer.lastSuccessfulOffset).toBe(offset(0, 10))
  })

  it(`flushes deferred auto-claim batches without a process global`, async () => {
    const first = deferred<Response>()
    const second = deferred<Response>()
    const firstStarted = deferred<void>()
    const secondStarted = deferred<void>()
    const mockFetch = vi
      .fn()
      .mockImplementationOnce(() => {
        firstStarted.resolve()
        return first.promise
      })
      .mockImplementationOnce(() => {
        secondStarted.resolve()
        return second.promise
      })
    const stream = new DurableStream({
      url: `https://example.com/stream`,
      contentType: `text/plain`,
    })
    const producer = new IdempotentProducer(stream, `test-producer`, {
      autoClaim: true,
      fetch: mockFetch,
      maxBatchBytes: 1,
    })
    // Build Node's Response objects before removing process so this test
    // isolates the client's runtime requirements from Node's implementation.
    const firstResponse = new Response(null, {
      status: 200,
      headers: { [STREAM_OFFSET_HEADER]: offset(0, 5) },
    })
    const secondResponse = new Response(null, {
      status: 200,
      headers: { [STREAM_OFFSET_HEADER]: offset(0, 10) },
    })
    let flushResolved = false
    let flushed: Promise<void> | undefined
    let beforeFirst: { calls: number; flushed: boolean } | undefined
    let beforeSecond: { calls: number; flushed: boolean } | undefined
    // Finish Vitest's pending callbacks before hiding a global it also uses.
    await nextTurn()
    vi.stubGlobal(`process`, undefined)
    try {
      producer.append(`a`)
      await firstStarted.promise
      producer.append(`b`)
      flushed = producer.flush().then(() => {
        flushResolved = true
      })
      // Let queued promise continuations settle while the response stays held.
      await nextTurn()
      beforeFirst = {
        calls: mockFetch.mock.calls.length,
        flushed: flushResolved,
      }

      first.resolve(firstResponse)
      await secondStarted.promise
      await nextTurn()
      beforeSecond = {
        calls: mockFetch.mock.calls.length,
        flushed: flushResolved,
      }

      second.resolve(secondResponse)
      await flushed
    } finally {
      vi.unstubAllGlobals()
      first.resolve(firstResponse)
      second.resolve(secondResponse)
      await flushed
    }
    expect(beforeFirst).toEqual({ calls: 1, flushed: false })
    expect(beforeSecond).toEqual({ calls: 2, flushed: false })
    expect(flushResolved).toBe(true)
    expect(
      new Headers(mockFetch.mock.calls[0]![1]?.headers).get(PRODUCER_SEQ_HEADER)
    ).toBe(`0`)
    expect(
      new Headers(mockFetch.mock.calls[1]![1]?.headers).get(PRODUCER_SEQ_HEADER)
    ).toBe(`1`)
    expect(producer.lastSuccessfulOffset).toBe(offset(0, 10))
  })

  it(`tracks the final close offset`, async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: { [STREAM_OFFSET_HEADER]: `3_15` },
      })
    )
    const stream = new DurableStream({
      url: `https://example.com/stream`,
      contentType: `text/plain`,
    })
    const producer = new IdempotentProducer(stream, `test-producer`, {
      fetch: mockFetch,
    })

    const result = await producer.close(`final`)

    expect(result.finalOffset).toBe(`3_15`)
    expect(producer.lastSuccessfulOffset).toBe(`3_15`)
  })

  it(`exports SSE control event field constants from the public entrypoint`, () => {
    expect(SSE_OFFSET_FIELD).toBe(`streamNextOffset`)
    expect(SSE_CURSOR_FIELD).toBe(`streamCursor`)
    expect(SSE_CLOSED_FIELD).toBe(`streamClosed`)
  })
})

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}
