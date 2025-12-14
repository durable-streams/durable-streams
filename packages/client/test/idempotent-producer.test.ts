import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  DurableStream,
  IdempotentProducer,
  STREAM_ACKED_SEQ_HEADER,
  STREAM_PRODUCER_EPOCH_HEADER,
  STREAM_PRODUCER_ID_HEADER,
} from "../src/index"
import type { Mock } from "vitest"

/**
 * Helper to create a mock response factory.
 * Each call returns a NEW Response object (important because Response bodies
 * can only be consumed once by createFetchWithConsumedBody).
 */
function createMockResponse(
  status: number,
  headers: Record<string, string> = {},
  body: BodyInit | null = null
): () => Response {
  return () =>
    new Response(body, {
      status,
      headers,
    })
}

// Store the original fetch once at module load time
const originalFetch = globalThis.fetch

describe(`IdempotentProducer`, () => {
  let mockFetch: Mock<typeof fetch>
  let stream: DurableStream

  beforeEach(() => {
    // Create mock and replace global fetch
    mockFetch = vi.fn()
    globalThis.fetch = mockFetch

    stream = new DurableStream({
      url: `https://example.com/stream`,
      contentType: `application/json`,
    })
  })

  afterEach(() => {
    // Restore original fetch
    globalThis.fetch = originalFetch
  })

  describe(`constructor`, () => {
    it(`should create producer with default options`, () => {
      const producer = new IdempotentProducer({
        stream,
        backoffOptions: { maxRetries: 0 },
      })

      expect(producer.producerId).toBeUndefined()
      expect(producer.epoch).toBeUndefined()
      expect(producer.isFenced).toBe(false)
      expect(producer.isInitialized).toBe(false)
    })

    it(`should expose state object with all fields`, () => {
      const producer = new IdempotentProducer({
        stream,
        backoffOptions: { maxRetries: 0 },
      })
      const state = producer.state

      expect(state).toEqual({
        producerId: undefined,
        epoch: undefined,
        nextSequence: 0,
        lastAckedSequence: -1,
        initialized: false,
        fenced: false,
      })
    })

    it(`should accept custom backoff options`, () => {
      const producer = new IdempotentProducer({
        stream,
        backoffOptions: {
          initialDelay: 50,
          maxDelay: 1000,
          multiplier: 2,
          maxRetries: 0,
        },
      })

      expect(producer).toBeDefined()
    })
  })

  describe(`append`, () => {
    it(`should send POST request with producer headers`, async () => {
      const makeResponse = createMockResponse(200, {
        [STREAM_PRODUCER_ID_HEADER]: `producer-123`,
        [STREAM_PRODUCER_EPOCH_HEADER]: `1`,
        [STREAM_ACKED_SEQ_HEADER]: `0`,
      })
      mockFetch.mockImplementation(() => Promise.resolve(makeResponse()))

      const producer = new IdempotentProducer({
        stream,
        backoffOptions: { maxRetries: 0 },
      })
      const result = await producer.append({ event: `test` })

      expect(mockFetch).toHaveBeenCalledTimes(1)
      expect(mockFetch).toHaveBeenCalledWith(
        `https://example.com/stream`,
        expect.objectContaining({
          method: `POST`,
          headers: expect.objectContaining({
            "content-type": `application/json`,
            [STREAM_PRODUCER_ID_HEADER]: `?`, // First request
            [STREAM_PRODUCER_EPOCH_HEADER]: `?`,
            "Stream-Seq": `0`,
          }),
        })
      )

      expect(result.success).toBe(true)
      expect(result.duplicate).toBe(false)
      expect(result.statusCode).toBe(200)
    })

    it(`should update producer state from response headers`, async () => {
      const makeResponse = createMockResponse(200, {
        [STREAM_PRODUCER_ID_HEADER]: `producer-456`,
        [STREAM_PRODUCER_EPOCH_HEADER]: `2`,
        [STREAM_ACKED_SEQ_HEADER]: `0`,
      })
      mockFetch.mockImplementation(() => Promise.resolve(makeResponse()))

      const producer = new IdempotentProducer({
        stream,
        backoffOptions: { maxRetries: 0 },
      })
      await producer.append({ event: `test` })

      expect(producer.producerId).toBe(`producer-456`)
      expect(producer.epoch).toBe(2)
      expect(producer.isInitialized).toBe(true)
      expect(producer.state.lastAckedSequence).toBe(0)
    })

    it(`should batch JSON items as array`, async () => {
      const makeResponse = createMockResponse(200, {
        [STREAM_PRODUCER_ID_HEADER]: `producer-123`,
        [STREAM_PRODUCER_EPOCH_HEADER]: `1`,
      })
      mockFetch.mockImplementation(() => Promise.resolve(makeResponse()))

      // Use small maxBatchBytes to trigger immediate flush
      const producer = new IdempotentProducer({
        stream,
        maxBatchBytes: 1, // Very small to force flush
        backoffOptions: { maxRetries: 0 },
      })

      await producer.append({ event: `test` })

      const callArgs = mockFetch.mock.calls[0]![1] as RequestInit
      const body = JSON.parse(callArgs.body as string)
      expect(body).toEqual([{ event: `test` }])
    })
  })

  describe(`response handling`, () => {
    it(`should handle 200 OK (committed)`, async () => {
      const makeResponse = createMockResponse(200, {
        [STREAM_PRODUCER_ID_HEADER]: `producer-123`,
        [STREAM_PRODUCER_EPOCH_HEADER]: `1`,
        [STREAM_ACKED_SEQ_HEADER]: `0`,
      })
      mockFetch.mockImplementation(() => Promise.resolve(makeResponse()))

      const producer = new IdempotentProducer({
        stream,
        backoffOptions: { maxRetries: 0 },
      })
      const result = await producer.append({ event: `test` })

      expect(result.success).toBe(true)
      expect(result.duplicate).toBe(false)
      expect(result.pending).toBeUndefined()
      expect(result.statusCode).toBe(200)
      expect(result.ackedSeq).toBe(0)
    })

    it(`should handle 204 No Content (duplicate)`, async () => {
      const makeResponse = createMockResponse(204, {
        [STREAM_PRODUCER_ID_HEADER]: `producer-123`,
        [STREAM_PRODUCER_EPOCH_HEADER]: `1`,
        [STREAM_ACKED_SEQ_HEADER]: `0`,
      })
      mockFetch.mockImplementation(() => Promise.resolve(makeResponse()))

      const producer = new IdempotentProducer({
        stream,
        backoffOptions: { maxRetries: 0 },
      })
      const result = await producer.append({ event: `test` })

      expect(result.success).toBe(true)
      expect(result.duplicate).toBe(true)
      expect(result.statusCode).toBe(204)
    })
  })

  describe(`callbacks`, () => {
    it(`should call onBatchAck on success`, async () => {
      const makeResponse = createMockResponse(200, {
        [STREAM_PRODUCER_ID_HEADER]: `producer-123`,
        [STREAM_PRODUCER_EPOCH_HEADER]: `1`,
      })
      mockFetch.mockImplementation(() => Promise.resolve(makeResponse()))

      const onBatchAck = vi.fn()
      const producer = new IdempotentProducer({
        stream,
        onBatchAck,
        backoffOptions: { maxRetries: 0 },
      })

      await producer.append({ event: `test` })

      expect(onBatchAck).toHaveBeenCalledTimes(1)
      expect(onBatchAck).toHaveBeenCalledWith(
        expect.objectContaining({ success: true }),
        1 // itemCount
      )
    })

    it(`should call onError on failure`, async () => {
      const makeResponse = createMockResponse(403, {})
      mockFetch.mockImplementation(() => Promise.resolve(makeResponse()))

      const onError = vi.fn()
      const producer = new IdempotentProducer({
        stream,
        onError,
        backoffOptions: { maxRetries: 0 },
      })

      await expect(producer.append({ event: `test` })).rejects.toThrow()

      expect(onError).toHaveBeenCalledTimes(1)
      expect(onError).toHaveBeenCalledWith(expect.any(Error), 1)
    })
  })

  describe(`flush`, () => {
    it(`should return immediately when nothing pending`, async () => {
      const producer = new IdempotentProducer({
        stream,
        backoffOptions: { maxRetries: 0 },
      })

      // Should complete immediately
      await producer.flush()
    })

    it(`should flush remaining buffer`, async () => {
      const makeResponse = createMockResponse(200, {
        [STREAM_PRODUCER_ID_HEADER]: `producer-123`,
        [STREAM_PRODUCER_EPOCH_HEADER]: `1`,
      })
      mockFetch.mockImplementation(() => Promise.resolve(makeResponse()))

      // Large batch size so appends don't auto-flush
      const producer = new IdempotentProducer({
        stream,
        maxBatchBytes: 100000,
        backoffOptions: { maxRetries: 0 },
      })

      // Just add to buffer (may not flush immediately due to queue idle check)
      producer.append({ event: `buffered` })

      // Wait for any immediate flush
      await new Promise((r) => setTimeout(r, 10))

      // Explicit flush to ensure sent
      await producer.flush()

      expect(mockFetch).toHaveBeenCalled()
    })
  })

  describe(`reset`, () => {
    it(`should clear producer state`, async () => {
      const makeResponse = createMockResponse(200, {
        [STREAM_PRODUCER_ID_HEADER]: `producer-123`,
        [STREAM_PRODUCER_EPOCH_HEADER]: `1`,
        [STREAM_ACKED_SEQ_HEADER]: `0`,
      })
      mockFetch.mockImplementation(() => Promise.resolve(makeResponse()))

      const producer = new IdempotentProducer({
        stream,
        backoffOptions: { maxRetries: 0 },
      })

      // Initialize producer
      await producer.append({ event: `test` })
      expect(producer.isInitialized).toBe(true)
      expect(producer.producerId).toBe(`producer-123`)

      // Reset
      producer.reset()

      expect(producer.producerId).toBeUndefined()
      expect(producer.epoch).toBeUndefined()
      expect(producer.isInitialized).toBe(false)
      expect(producer.isFenced).toBe(false)
      expect(producer.state.nextSequence).toBe(0)
      expect(producer.state.lastAckedSequence).toBe(-1)
    })
  })

  describe(`bumpEpoch`, () => {
    it(`should throw if producer not initialized`, async () => {
      const producer = new IdempotentProducer({
        stream,
        backoffOptions: { maxRetries: 0 },
      })

      await expect(producer.bumpEpoch()).rejects.toThrow(
        /producer not initialized/
      )
    })

    it(`should reset sequence after epoch bump`, async () => {
      // First request - initialize
      const makeInitResponse = createMockResponse(200, {
        [STREAM_PRODUCER_ID_HEADER]: `producer-123`,
        [STREAM_PRODUCER_EPOCH_HEADER]: `1`,
      })

      // Epoch bump response
      const makeBumpResponse = createMockResponse(200, {
        [STREAM_PRODUCER_ID_HEADER]: `producer-123`,
        [STREAM_PRODUCER_EPOCH_HEADER]: `2`,
      })

      let callCount = 0
      mockFetch.mockImplementation(async () => {
        callCount++
        if (callCount === 1) return makeInitResponse()
        return makeBumpResponse()
      })

      const producer = new IdempotentProducer({
        stream,
        backoffOptions: { maxRetries: 0 },
      })
      await producer.append({ event: `init` })

      await producer.bumpEpoch()

      expect(producer.epoch).toBe(2)
      expect(producer.state.nextSequence).toBe(0)
      expect(producer.state.lastAckedSequence).toBe(-1)
      expect(producer.isFenced).toBe(false)
    })
  })

  describe(`content type handling`, () => {
    it(`should use custom contentType when provided`, async () => {
      const makeResponse = createMockResponse(200, {
        [STREAM_PRODUCER_ID_HEADER]: `producer-123`,
        [STREAM_PRODUCER_EPOCH_HEADER]: `1`,
      })
      mockFetch.mockImplementation(() => Promise.resolve(makeResponse()))

      const producer = new IdempotentProducer({
        stream,
        contentType: `text/plain`,
        backoffOptions: { maxRetries: 0 },
      })

      await producer.append(`hello world`)

      expect(mockFetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          headers: expect.objectContaining({
            "content-type": `text/plain`,
          }),
        })
      )
    })

    it(`should concatenate bytes for non-JSON content`, async () => {
      const makeResponse = createMockResponse(200, {
        [STREAM_PRODUCER_ID_HEADER]: `producer-123`,
        [STREAM_PRODUCER_EPOCH_HEADER]: `1`,
      })
      mockFetch.mockImplementation(() => Promise.resolve(makeResponse()))

      const producer = new IdempotentProducer({
        stream,
        contentType: `application/octet-stream`,
        maxBatchBytes: 1, // Force immediate flush
        backoffOptions: { maxRetries: 0 },
      })

      const data = new Uint8Array([1, 2, 3])
      await producer.append(data)

      const callArgs = mockFetch.mock.calls[0]![1] as RequestInit
      // Should be Uint8Array, not JSON
      expect(callArgs.body).toBeInstanceOf(Uint8Array)
    })
  })

  describe(`byte-size batching`, () => {
    it(`should flush when buffer exceeds maxBatchBytes`, async () => {
      const makeResponse = createMockResponse(200, {
        [STREAM_PRODUCER_ID_HEADER]: `producer-123`,
        [STREAM_PRODUCER_EPOCH_HEADER]: `1`,
      })
      mockFetch.mockImplementation(() => Promise.resolve(makeResponse()))

      const producer = new IdempotentProducer({
        stream,
        maxBatchBytes: 50, // Small threshold
        backoffOptions: { maxRetries: 0 },
      })

      // Append large data that exceeds threshold
      const largeData = { data: `x`.repeat(100) }
      await producer.append(largeData)

      // Should have flushed immediately
      expect(mockFetch).toHaveBeenCalled()
    })
  })

  describe(`abort signal`, () => {
    it(`should support global abort signal`, async () => {
      const controller = new AbortController()

      mockFetch.mockImplementation(async () => {
        await new Promise((_, reject) => {
          controller.signal.addEventListener(`abort`, () => {
            reject(new DOMException(`Aborted`, `AbortError`))
          })
        })
        return new Response(null, { status: 200 })
      })

      const producer = new IdempotentProducer({
        stream,
        signal: controller.signal,
        backoffOptions: { maxRetries: 0 },
      })

      const appendPromise = producer.append({ event: `test` })

      // Abort after starting
      controller.abort()

      await expect(appendPromise).rejects.toThrow()
    })

    it(`should support per-append abort signal`, async () => {
      const controller = new AbortController()

      mockFetch.mockImplementation(async () => {
        await new Promise((_, reject) => {
          controller.signal.addEventListener(`abort`, () => {
            reject(new DOMException(`Aborted`, `AbortError`))
          })
        })
        return new Response(null, { status: 200 })
      })

      const producer = new IdempotentProducer({
        stream,
        backoffOptions: { maxRetries: 0 },
      })

      const appendPromise = producer.append(
        { event: `test` },
        { signal: controller.signal }
      )

      controller.abort()

      await expect(appendPromise).rejects.toThrow()
    })
  })

  describe(`data types`, () => {
    it(`should handle Uint8Array data`, async () => {
      const makeResponse = createMockResponse(200, {
        [STREAM_PRODUCER_ID_HEADER]: `producer-123`,
        [STREAM_PRODUCER_EPOCH_HEADER]: `1`,
      })
      mockFetch.mockImplementation(() => Promise.resolve(makeResponse()))

      const producer = new IdempotentProducer({
        stream,
        contentType: `application/octet-stream`,
        backoffOptions: { maxRetries: 0 },
      })

      const data = new Uint8Array([1, 2, 3, 4, 5])
      await producer.append(data)

      expect(mockFetch).toHaveBeenCalled()
    })

    it(`should handle string data`, async () => {
      const makeResponse = createMockResponse(200, {
        [STREAM_PRODUCER_ID_HEADER]: `producer-123`,
        [STREAM_PRODUCER_EPOCH_HEADER]: `1`,
      })
      mockFetch.mockImplementation(() => Promise.resolve(makeResponse()))

      const producer = new IdempotentProducer({
        stream,
        contentType: `text/plain`,
        backoffOptions: { maxRetries: 0 },
      })

      await producer.append(`hello world`)

      expect(mockFetch).toHaveBeenCalled()
    })

    it(`should handle JSON-serializable objects`, async () => {
      const makeResponse = createMockResponse(200, {
        [STREAM_PRODUCER_ID_HEADER]: `producer-123`,
        [STREAM_PRODUCER_EPOCH_HEADER]: `1`,
      })
      mockFetch.mockImplementation(() => Promise.resolve(makeResponse()))

      const producer = new IdempotentProducer({
        stream,
        backoffOptions: { maxRetries: 0 },
      })

      await producer.append({ nested: { data: [1, 2, 3] } })

      expect(mockFetch).toHaveBeenCalled()
      const callArgs = mockFetch.mock.calls[0]![1] as RequestInit
      const body = JSON.parse(callArgs.body as string)
      expect(body).toEqual([{ nested: { data: [1, 2, 3] } }])
    })
  })

  describe(`error handling`, () => {
    it(`should throw on 403 response`, async () => {
      const makeResponse = createMockResponse(403, {
        [STREAM_PRODUCER_EPOCH_HEADER]: `5`,
      })
      mockFetch.mockImplementation(() => Promise.resolve(makeResponse()))

      const producer = new IdempotentProducer({
        stream,
        backoffOptions: { maxRetries: 0 },
      })

      // 403 responses cause the backoff wrapper to throw FetchError
      // which propagates as an error from append
      await expect(producer.append({ event: `test` })).rejects.toThrow()
    })
  })
})
