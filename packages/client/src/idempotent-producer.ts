/**
 * IdempotentProducer - Provides exactly-once append semantics for durable streams.
 *
 * Implements Kafka-style idempotent producer semantics:
 * - Server-assigned producer IDs for tracking write sessions
 * - Producer epochs for zombie fencing
 * - Sequence number tracking with duplicate detection
 * - Client-side ordering - batches are sent and acknowledged in strict sequence order
 * - Safe retries - duplicates are detected and ignored
 * - Low-latency default - messages send immediately when no requests are in-flight
 * - Opportunistic batching - groups messages only when requests are already pending
 * - Automatic retry with exponential backoff
 */

import fastq from "fastq"

import {
  STREAM_ACKED_SEQ_HEADER,
  STREAM_PRODUCER_EPOCH_HEADER,
  STREAM_PRODUCER_ID_HEADER,
} from "./constants"
import { FetchError, IdempotentProducerError } from "./error"
import {
  BackoffDefaults,
  createFetchWithBackoff,
  createFetchWithConsumedBody,
} from "./fetch"
import type { DurableStream } from "./stream"
import type { IdempotentAppendResult, IdempotentProducerState } from "./types"
import type { BackoffOptions } from "./fetch"
import type { queueAsPromised } from "fastq"

/**
 * Callback for batch acknowledgment.
 */
export type BatchAckCallback = (
  result: IdempotentAppendResult,
  itemCount: number
) => void

/**
 * Callback for batch errors (after retries exhausted).
 */
export type BatchErrorCallback = (error: Error, itemCount: number) => void

/**
 * Options for creating an IdempotentProducer.
 */
export interface IdempotentProducerOptions {
  /**
   * The DurableStream to produce to.
   */
  stream: DurableStream

  /**
   * Content type for appends.
   * If not specified, uses the stream's content type.
   */
  contentType?: string

  /**
   * AbortSignal for operations.
   */
  signal?: AbortSignal

  /**
   * Backoff options for retry behavior.
   * Defaults to exponential backoff with jitter.
   */
  backoffOptions?: Partial<BackoffOptions>

  /**
   * Maximum batch size in bytes before triggering a flush.
   * Only relevant for high-throughput scenarios where messages accumulate faster
   * than the network can send them. For typical small/infrequent messages,
   * batches send immediately when the queue is idle.
   * Defaults to 1MB (1048576 bytes).
   */
  maxBatchBytes?: number

  /**
   * Maximum number of batches that can be in-flight concurrently.
   * Only relevant for high-throughput bulk loading scenarios where you're
   * sending data faster than network RTT allows. For typical usage, messages
   * send immediately and this limit is never reached.
   * Defaults to 5.
   */
  maxInFlight?: number

  /**
   * Called when a batch is successfully acknowledged.
   * Useful for metrics and monitoring without blocking.
   */
  onBatchAck?: BatchAckCallback

  /**
   * Called when a batch fails (after retries exhausted).
   * Useful for error logging and dead-letter handling.
   */
  onError?: BatchErrorCallback
}

/**
 * Options for individual append operations.
 */
export interface IdempotentAppendOptions {
  /**
   * AbortSignal for this specific append.
   */
  signal?: AbortSignal
}

/**
 * Default max batch size in bytes (1MB).
 */
const DEFAULT_MAX_BATCH_BYTES = 1024 * 1024

/**
 * Default maximum number of in-flight batches.
 * Only relevant for high-throughput bulk loading. For typical usage,
 * messages send immediately and only one batch is ever in-flight.
 */
const DEFAULT_MAX_IN_FLIGHT = 5

/**
 * Maximum retries for OUT_OF_ORDER_SEQUENCE errors.
 * These occur during pipelining when batches arrive out of order.
 */
const OUT_OF_ORDER_MAX_RETRIES = 100

/**
 * Base delay for OUT_OF_ORDER_SEQUENCE retries (ms).
 * We use a shorter delay than normal backoff since we expect earlier batches
 * to complete soon.
 */
const OUT_OF_ORDER_BASE_DELAY = 50

/**
 * Queued message for batching.
 */
interface QueuedMessage {
  data: unknown
  dataBytes: number // Pre-computed size for byte tracking
  signal?: AbortSignal
  resolve: (result: IdempotentAppendResult) => void
  reject: (error: Error) => void
}

/**
 * A batch ready to send with its assigned sequence number.
 */
interface PreparedBatch {
  messages: Array<QueuedMessage>
  sequence: number
}

/**
 * Normalize content-type by extracting the media type (before any semicolon).
 */
function normalizeContentType(contentType: string | undefined): string {
  if (!contentType) return ``
  return contentType.split(`;`)[0]!.trim().toLowerCase()
}

/**
 * Check if an error is fatal (should not retry).
 */
function isFatalError(status: number): boolean {
  // 4xx errors (except 429) are fatal - bad request, fenced, etc.
  // Note: 409 OUT_OF_ORDER_SEQUENCE is handled specially in #sendBatch
  // for Kafka-style pipelining, but other 409s are fatal.
  return status >= 400 && status < 500 && status !== 429
}

/**
 * IdempotentProducer provides exactly-once append semantics with low-latency delivery.
 *
 * Messages send immediately when no requests are in-flight (the common case for
 * small/infrequent messages). Batching only occurs opportunistically when requests
 * are already pending, providing both low latency and high throughput when needed.
 *
 * Failed requests are automatically retried with exponential backoff.
 * Duplicate detection on the server ensures exactly-once delivery even with retries.
 *
 * @example
 * ```typescript
 * const stream = await DurableStream.create({
 *   url: "https://streams.example.com/my-stream",
 *   contentType: "application/json"
 * });
 *
 * const producer = new IdempotentProducer({
 *   stream,
 *   onBatchAck: (result, count) => {
 *     console.log(`Batch of ${count} items acked`);
 *   },
 *   onError: (error, count) => {
 *     console.error(`Batch of ${count} items failed:`, error);
 *   }
 * });
 *
 * // Fire-and-forget - sends immediately when idle, batches when busy
 * producer.append({ event: "click", button: "submit" });
 * producer.append({ event: "click", button: "cancel" });
 * producer.append({ event: "page_view", page: "/home" });
 *
 * // Wait for all pending to complete before shutdown
 * await producer.flush();
 * ```
 */
export class IdempotentProducer {
  readonly #stream: DurableStream
  readonly #contentType?: string
  readonly #signal?: AbortSignal
  readonly #fetchClient: typeof fetch
  readonly #onBatchAck?: BatchAckCallback
  readonly #onError?: BatchErrorCallback
  readonly #maxBatchBytes: number
  readonly #maxInFlight: number

  #producerId?: string
  #epoch?: number
  #nextSequence = 0
  #lastAckedSequence = -1
  #initialized = false
  #fenced = false

  // Batching infrastructure
  #queue: queueAsPromised<PreparedBatch>
  #buffer: Array<QueuedMessage> = []
  #bufferBytes = 0

  // Flush support
  #flushResolvers: Array<() => void> = []

  constructor(options: IdempotentProducerOptions) {
    this.#stream = options.stream
    this.#contentType = options.contentType
    this.#signal = options.signal
    this.#onBatchAck = options.onBatchAck
    this.#onError = options.onError
    this.#maxBatchBytes = options.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES
    this.#maxInFlight = options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT

    // Create fetch client with backoff
    const backoffOptions = {
      ...BackoffDefaults,
      ...options.backoffOptions,
    }
    const baseFetch = globalThis.fetch.bind(globalThis)
    const fetchWithBackoff = createFetchWithBackoff(baseFetch, backoffOptions)
    this.#fetchClient = createFetchWithConsumedBody(fetchWithBackoff)

    // Queue with concurrency for pipelining multiple in-flight batches
    // Batches that arrive out-of-order at the server will retry (409) until
    // earlier batches complete - this is Kafka-style client-side ordering
    this.#queue = fastq.promise(this.#batchWorker.bind(this), this.#maxInFlight)
  }

  /**
   * Get the current producer state.
   */
  get state(): IdempotentProducerState {
    return {
      producerId: this.#producerId,
      epoch: this.#epoch,
      nextSequence: this.#nextSequence,
      lastAckedSequence: this.#lastAckedSequence,
      initialized: this.#initialized,
      fenced: this.#fenced,
    }
  }

  /**
   * Get the producer ID (undefined until first append).
   */
  get producerId(): string | undefined {
    return this.#producerId
  }

  /**
   * Get the current epoch (undefined until first append).
   */
  get epoch(): number | undefined {
    return this.#epoch
  }

  /**
   * Check if the producer has been fenced (stale epoch).
   */
  get isFenced(): boolean {
    return this.#fenced
  }

  /**
   * Check if the producer has been initialized.
   */
  get isInitialized(): boolean {
    return this.#initialized
  }

  /**
   * Append data with exactly-once semantics.
   *
   * Multiple append() calls are automatically batched together for efficiency.
   * Batches are sent when:
   * - Buffer size exceeds maxBatchBytes threshold
   * - The queue has capacity for more in-flight batches
   *
   * Failed batches are automatically retried with exponential backoff.
   * Safe to retry on network errors - the server detects and ignores duplicates.
   *
   * @param body - The data to append (Uint8Array, string, or JSON-serializable value)
   * @param options - Optional append options
   * @returns Promise that resolves with result when the batch containing this item is sent
   * @throws {IdempotentProducerError} On fatal errors (fenced, bad request, etc.)
   */
  append(
    body: unknown,
    options?: IdempotentAppendOptions
  ): Promise<IdempotentAppendResult> {
    if (this.#fenced) {
      return Promise.reject(
        new IdempotentProducerError(
          `Producer has been fenced (stale epoch)`,
          `PRODUCER_FENCED`,
          403,
          { currentEpoch: this.#epoch }
        )
      )
    }

    // Calculate byte size of data
    const dataBytes = this.#estimateBytes(body)

    return new Promise<IdempotentAppendResult>((resolve, reject) => {
      this.#buffer.push({
        data: body,
        dataBytes,
        signal: options?.signal,
        resolve,
        reject,
      })
      this.#bufferBytes += dataBytes

      // Flush if buffer exceeds byte threshold
      if (this.#bufferBytes >= this.#maxBatchBytes) {
        this.#flushBuffer()
      } else if (this.#queue.idle()) {
        // Queue is idle - flush immediately to avoid latency
        this.#flushBuffer()
      }
    })
  }

  /**
   * Estimate byte size of data.
   */
  #estimateBytes(data: unknown): number {
    if (data instanceof Uint8Array) {
      return data.length
    }
    if (typeof data === `string`) {
      // UTF-8 estimate: 1-4 bytes per char, use 2 as average
      return data.length * 2
    }
    // JSON: stringify to estimate
    return JSON.stringify(data).length
  }

  /**
   * Flush the current buffer as a prepared batch.
   */
  #flushBuffer(): void {
    if (this.#buffer.length === 0) return

    const messages = this.#buffer.splice(0)
    this.#bufferBytes = 0

    // Assign sequence number NOW (before sending)
    const sequence = this.#nextSequence++

    const preparedBatch: PreparedBatch = { messages, sequence }

    this.#queue.push(preparedBatch).catch((err) => {
      for (const msg of messages) msg.reject(err)
    })
  }

  /**
   * Wait for all pending appends to complete.
   *
   * Returns when:
   * - All buffered items have been sent
   * - All in-flight batches have been acknowledged (or failed)
   *
   * @example
   * ```typescript
   * // High-throughput writes
   * for (const event of events) {
   *   producer.append(event);
   * }
   *
   * // Wait before shutdown
   * await producer.flush();
   * console.log(`All events sent, last acked: ${producer.state.lastAckedSequence}`);
   * ```
   */
  async flush(): Promise<void> {
    // Flush any remaining buffer
    this.#flushBuffer()

    // If nothing in-flight, return immediately
    if (this.#queue.idle()) {
      return
    }

    // Wait for queue to drain
    return new Promise<void>((resolve) => {
      this.#flushResolvers.push(resolve)
    })
  }

  /**
   * Batch worker - processes prepared batches with assigned sequence numbers.
   */
  async #batchWorker(preparedBatch: PreparedBatch): Promise<void> {
    const { messages, sequence } = preparedBatch
    const itemCount = messages.length

    try {
      const result = await this.#sendBatch(messages, sequence)

      // Call onBatchAck callback
      this.#onBatchAck?.(result, itemCount)

      // Resolve all messages in the batch with the same result
      for (const msg of messages) {
        msg.resolve(result)
      }

      // Check if we should resolve flush waiters
      // (only when queue is idle AND buffer is empty)
      if (this.#queue.idle() && this.#buffer.length === 0) {
        this.#resolveFlushWaiters()
      }
    } catch (error) {
      // Call onError callback
      this.#onError?.(error as Error, itemCount)

      // Reject current batch
      for (const msg of messages) {
        msg.reject(error as Error)
      }

      // For fatal errors, reject all buffered messages too
      if (
        error instanceof IdempotentProducerError &&
        isFatalError(error.status)
      ) {
        for (const msg of this.#buffer) {
          msg.reject(error)
        }
        this.#buffer = []
        this.#bufferBytes = 0
      }

      // Resolve flush waiters (even on error) if queue is now idle
      if (this.#queue.idle() && this.#buffer.length === 0) {
        this.#resolveFlushWaiters()
      }

      throw error
    }
  }

  /**
   * Resolve all pending flush() calls.
   */
  #resolveFlushWaiters(): void {
    const resolvers = this.#flushResolvers.splice(0)
    for (const resolve of resolvers) {
      resolve()
    }
  }

  /**
   * Send a batch of messages as a single POST request.
   * @param batch - The messages to send
   * @param sequence - The pre-assigned sequence number for this batch
   */
  async #sendBatch(
    batch: Array<QueuedMessage>,
    sequence: number
  ): Promise<IdempotentAppendResult> {
    if (batch.length === 0) {
      return { success: true, duplicate: false, statusCode: 200 }
    }

    const contentType =
      this.#contentType ?? this.#stream.contentType ?? `application/json`
    const isJson = normalizeContentType(contentType) === `application/json`

    // Build body based on content type
    let body: BodyInit
    if (isJson) {
      // JSON mode: send array of items (server flattens one level)
      const items = batch.map((m) => m.data)
      body = JSON.stringify(items)
    } else {
      // Byte mode: concatenate all data
      const encoder = new TextEncoder()
      const chunks: Array<Uint8Array> = batch.map((m) => {
        if (m.data instanceof Uint8Array) return m.data
        if (typeof m.data === `string`) return encoder.encode(m.data)
        return encoder.encode(JSON.stringify(m.data))
      })
      const totalSize = chunks.reduce((sum, c) => sum + c.length, 0)
      const concatenated = new Uint8Array(totalSize)
      let offset = 0
      for (const chunk of chunks) {
        concatenated.set(chunk, offset)
        offset += chunk.length
      }
      body = concatenated as unknown as BodyInit
    }

    // Build headers for idempotent append
    // Sequence is pre-assigned when batch is created, enabling pipelining
    const headers: Record<string, string> = {
      "content-type": contentType,
      [STREAM_PRODUCER_ID_HEADER]: this.#producerId ?? `?`,
      "Stream-Seq": String(sequence),
    }

    // Include epoch header
    if (this.#epoch !== undefined) {
      headers[STREAM_PRODUCER_EPOCH_HEADER] = String(this.#epoch)
    } else {
      headers[STREAM_PRODUCER_EPOCH_HEADER] = `?`
    }

    // Combine signals
    const signals: Array<AbortSignal> = []
    if (this.#signal) signals.push(this.#signal)
    for (const msg of batch) {
      if (msg.signal) signals.push(msg.signal)
    }
    const combinedSignal =
      signals.length > 0 ? AbortSignal.any(signals) : undefined

    // Make the request with retry logic for OUT_OF_ORDER_SEQUENCE
    // This handles Kafka-style pipelining where batches may arrive out of order
    let retryCount = 0

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    while (true) {
      try {
        const response = await this.#fetchClient(this.#stream.url, {
          method: `POST`,
          headers,
          body,
          signal: combinedSignal,
        })

        // Parse response
        return this.#handleResponse(response, sequence)
      } catch (error) {
        // Check if this is an OUT_OF_ORDER_SEQUENCE error (retriable for pipelining)
        if (
          error instanceof FetchError &&
          error.status === 409 &&
          error.json &&
          typeof error.json === `object` &&
          `error` in error.json &&
          error.json.error === `OUT_OF_ORDER_SEQUENCE`
        ) {
          retryCount++
          if (retryCount > OUT_OF_ORDER_MAX_RETRIES) {
            throw new IdempotentProducerError(
              `Max retries exceeded waiting for earlier batches`,
              `OUT_OF_ORDER_SEQUENCE`,
              409,
              error.json as Record<string, unknown>
            )
          }

          // Wait with exponential backoff before retrying
          const delay = Math.min(
            OUT_OF_ORDER_BASE_DELAY * Math.pow(1.5, retryCount - 1),
            5000
          )
          await new Promise((resolve) => setTimeout(resolve, delay))
          continue
        }

        // For PRODUCER_FENCED, set the fenced flag and throw
        if (
          error instanceof FetchError &&
          error.status === 409 &&
          error.json &&
          typeof error.json === `object` &&
          `error` in error.json &&
          error.json.error === `PRODUCER_FENCED`
        ) {
          this.#fenced = true
          throw new IdempotentProducerError(
            `Producer fenced: stale epoch`,
            `PRODUCER_FENCED`,
            409,
            error.json as Record<string, unknown>
          )
        }

        // For other 409 errors (UNKNOWN_PRODUCER, etc.), wrap in IdempotentProducerError
        if (
          error instanceof FetchError &&
          error.status === 409 &&
          error.json &&
          typeof error.json === `object` &&
          `error` in error.json
        ) {
          throw new IdempotentProducerError(
            `Idempotent producer error: ${String(error.json.error)}`,
            error.json.error as `UNKNOWN_PRODUCER` | `OUT_OF_ORDER_SEQUENCE`,
            409,
            error.json as Record<string, unknown>
          )
        }

        // Re-throw other errors
        throw error
      }
    }
  }

  /**
   * Bump the producer epoch (for zombie fencing after recovery).
   *
   * Call this to re-initialize a producer after detecting it may have been
   * superseded by another instance. This invalidates any previous instances
   * with the same producer ID.
   *
   * @throws {IdempotentProducerError} If the producer is not initialized
   */
  async bumpEpoch(): Promise<void> {
    if (!this.#producerId) {
      throw new IdempotentProducerError(
        `Cannot bump epoch: producer not initialized`,
        `UNKNOWN_PRODUCER`,
        400
      )
    }

    const headers: Record<string, string> = {
      [STREAM_PRODUCER_ID_HEADER]: this.#producerId,
      [STREAM_PRODUCER_EPOCH_HEADER]: `?`,
    }

    const response = await this.#fetchClient(this.#stream.url, {
      method: `POST`,
      headers,
      signal: this.#signal,
    })

    if (!response.ok) {
      const text = await response.text()
      throw new IdempotentProducerError(
        `Failed to bump epoch: ${text}`,
        `UNKNOWN_PRODUCER`,
        response.status
      )
    }

    // Update epoch from response
    const newEpoch = response.headers.get(STREAM_PRODUCER_EPOCH_HEADER)
    if (newEpoch) {
      this.#epoch = parseInt(newEpoch, 10)
    }

    // Reset sequence after epoch bump
    this.#nextSequence = 0
    this.#lastAckedSequence = -1
    this.#fenced = false
  }

  /**
   * Handle the response from an idempotent append.
   * @param response - The HTTP response
   * @param _sequence - The sequence number that was sent (unused, for future debugging)
   */
  #handleResponse(
    response: Response,
    _sequence: number
  ): IdempotentAppendResult {
    const status = response.status

    // Extract headers
    const producerId = response.headers.get(STREAM_PRODUCER_ID_HEADER)
    const epochStr = response.headers.get(STREAM_PRODUCER_EPOCH_HEADER)
    const ackedSeqStr = response.headers.get(STREAM_ACKED_SEQ_HEADER)

    // Update producer state from response
    if (producerId && producerId !== `?`) {
      this.#producerId = producerId
      this.#initialized = true
    }

    if (epochStr) {
      this.#epoch = parseInt(epochStr, 10)
    }

    const ackedSeq = ackedSeqStr ? parseInt(ackedSeqStr, 10) : undefined
    if (ackedSeq !== undefined && ackedSeq > this.#lastAckedSequence) {
      this.#lastAckedSequence = ackedSeq
    }

    // Handle different response codes
    // Note: sequence is pre-assigned when batch is created, not incremented here
    switch (status) {
      case 200: {
        // Success - committed
        return {
          success: true,
          duplicate: false,
          ackedSeq,
          statusCode: status,
        }
      }

      case 204: {
        // Duplicate - already committed, idempotent success
        return {
          success: true,
          duplicate: true,
          ackedSeq,
          statusCode: status,
        }
      }

      case 403: {
        // Fenced - stale epoch
        this.#fenced = true
        throw new IdempotentProducerError(
          `Producer fenced: stale epoch`,
          `PRODUCER_FENCED`,
          status,
          { currentEpoch: this.#epoch }
        )
      }

      case 400: {
        // Could be various errors - parse response body
        // For now, treat as unknown producer or bad request
        throw new IdempotentProducerError(
          `Bad request: invalid producer state`,
          `UNKNOWN_PRODUCER`,
          status
        )
      }

      case 409: {
        // Sequence conflict - out of order
        throw new IdempotentProducerError(
          `Sequence conflict: out of order`,
          `OUT_OF_ORDER_SEQUENCE`,
          status,
          { lastSequence: this.#lastAckedSequence }
        )
      }

      default: {
        throw new IdempotentProducerError(
          `Unexpected response: ${status}`,
          `UNKNOWN_PRODUCER`,
          status
        )
      }
    }
  }

  /**
   * Reset the producer state (for testing or recovery).
   * This does NOT communicate with the server.
   */
  reset(): void {
    this.#producerId = undefined
    this.#epoch = undefined
    this.#nextSequence = 0
    this.#lastAckedSequence = -1
    this.#initialized = false
    this.#fenced = false
    this.#buffer = []
    this.#bufferBytes = 0
  }
}
