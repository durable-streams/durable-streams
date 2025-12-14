/**
 * IdempotentProducer - Provides exactly-once append semantics for durable streams.
 *
 * Implements Kafka-style idempotent producer semantics:
 * - Server-assigned producer IDs for tracking write sessions
 * - Producer epochs for zombie fencing
 * - Sequence number tracking with duplicate detection
 * - Safe retries - duplicates are detected and ignored
 * - Automatic batching for high throughput
 * - Automatic retry with exponential backoff
 */

import fastq from "fastq"

import {
  STREAM_ACKED_SEQ_HEADER,
  STREAM_PRODUCER_EPOCH_HEADER,
  STREAM_PRODUCER_ID_HEADER,
} from "./constants"
import { IdempotentProducerError } from "./error"
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
 * Queued message for batching.
 */
interface QueuedMessage {
  data: unknown
  signal?: AbortSignal
  resolve: (result: IdempotentAppendResult) => void
  reject: (error: Error) => void
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
  return status >= 400 && status < 500 && status !== 429
}

/**
 * IdempotentProducer provides exactly-once append semantics with automatic batching.
 *
 * Multiple append() calls are automatically batched together for high throughput.
 * Each batch gets a single sequence number for idempotent delivery.
 * Failed batches are automatically retried with exponential backoff.
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
 * // Fire-and-forget - batched automatically
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

  #producerId?: string
  #epoch?: number
  #nextSequence = 0
  #lastAckedSequence = -1
  #initialized = false
  #fenced = false

  // Batching infrastructure
  #queue: queueAsPromised<Array<QueuedMessage>>
  #buffer: Array<QueuedMessage> = []

  // Flush support
  #flushResolvers: Array<() => void> = []

  constructor(options: IdempotentProducerOptions) {
    this.#stream = options.stream
    this.#contentType = options.contentType
    this.#signal = options.signal
    this.#onBatchAck = options.onBatchAck
    this.#onError = options.onError

    // Create fetch client with backoff
    const backoffOptions = {
      ...BackoffDefaults,
      ...options.backoffOptions,
    }
    const baseFetch = globalThis.fetch.bind(globalThis)
    const fetchWithBackoff = createFetchWithBackoff(baseFetch, backoffOptions)
    this.#fetchClient = createFetchWithConsumedBody(fetchWithBackoff)

    // Single-worker queue ensures sequential batch processing
    this.#queue = fastq.promise(this.#batchWorker.bind(this), 1)
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

    return new Promise<IdempotentAppendResult>((resolve, reject) => {
      this.#buffer.push({
        data: body,
        signal: options?.signal,
        resolve,
        reject,
      })

      // If queue is idle, send immediately
      if (this.#queue.idle()) {
        const batch = this.#buffer.splice(0)
        this.#queue.push(batch).catch((err) => {
          for (const msg of batch) msg.reject(err)
        })
      }
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
    // If nothing pending, return immediately
    if (this.#buffer.length === 0 && this.#queue.idle()) {
      return
    }

    // If there's a buffer but queue is idle, trigger send
    if (this.#buffer.length > 0 && this.#queue.idle()) {
      const batch = this.#buffer.splice(0)
      this.#queue.push(batch).catch((err) => {
        for (const msg of batch) msg.reject(err)
      })
    }

    // Wait for queue to drain
    return new Promise<void>((resolve) => {
      this.#flushResolvers.push(resolve)
    })
  }

  /**
   * Batch worker - processes batches of messages.
   */
  async #batchWorker(batch: Array<QueuedMessage>): Promise<void> {
    const itemCount = batch.length

    try {
      const result = await this.#sendBatch(batch)

      // Call onBatchAck callback
      this.#onBatchAck?.(result, itemCount)

      // Resolve all messages in the batch with the same result
      for (const msg of batch) {
        msg.resolve(result)
      }

      // Send accumulated batch if any
      if (this.#buffer.length > 0) {
        const nextBatch = this.#buffer.splice(0)
        this.#queue.push(nextBatch).catch((err) => {
          for (const msg of nextBatch) msg.reject(err)
        })
      } else {
        // No more pending - resolve flush waiters
        this.#resolveFlushWaiters()
      }
    } catch (error) {
      // Call onError callback
      this.#onError?.(error as Error, itemCount)

      // Reject current batch
      for (const msg of batch) {
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
      }

      // Resolve flush waiters (even on error)
      this.#resolveFlushWaiters()

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
   */
  async #sendBatch(
    batch: Array<QueuedMessage>
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
    const headers: Record<string, string> = {
      "content-type": contentType,
      [STREAM_PRODUCER_ID_HEADER]: this.#producerId ?? `?`,
      "Stream-Seq": String(this.#nextSequence),
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

    // Make the request (with automatic retry via fetchClient)
    const response = await this.#fetchClient(this.#stream.url, {
      method: `POST`,
      headers,
      body,
      signal: combinedSignal,
    })

    // Parse response
    return this.#handleResponse(response)
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
   */
  #handleResponse(response: Response): IdempotentAppendResult {
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
    switch (status) {
      case 200: {
        // Success - committed
        this.#nextSequence++
        return {
          success: true,
          duplicate: false,
          ackedSeq,
          statusCode: status,
        }
      }

      case 202: {
        // Accepted - buffered for out-of-order handling
        this.#nextSequence++
        return {
          success: true,
          duplicate: false,
          pending: true,
          ackedSeq,
          statusCode: status,
        }
      }

      case 204: {
        // Duplicate - already committed, idempotent success
        // Don't increment sequence - it was already counted
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
  }
}
