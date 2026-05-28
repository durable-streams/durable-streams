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

  it(`waits for the first auto-claiming batch before sending later batches`, async () => {
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
      autoClaim: true,
      fetch: mockFetch,
      maxBatchBytes: 1,
    })

    producer.append(`a`)
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))
    producer.append(`b`)
    let flushResolved = false
    const flushed = producer.flush().then(() => {
      flushResolved = true
    })
    await Promise.resolve()

    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(flushResolved).toBe(false)

    resolveFirst!(
      new Response(null, {
        status: 200,
        headers: { [STREAM_OFFSET_HEADER]: offset(0, 5) },
      })
    )
    await flushed

    expect(mockFetch).toHaveBeenCalledTimes(2)
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
