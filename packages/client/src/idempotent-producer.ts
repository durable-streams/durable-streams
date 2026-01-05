/**
 * IdempotentProducer - Fire-and-forget producer with exactly-once write semantics.
 *
 * Implements Kafka-style idempotent producer pattern with:
 * - Client-provided producer IDs (zero RTT overhead)
 * - Client-declared epochs, server-validated fencing
 * - Per-batch sequence numbers for deduplication
 * - Automatic batching and pipelining for throughput
 */

import { DurableStreamError, FetchError } from "./error"
import {
  PRODUCER_EPOCH_HEADER,
  PRODUCER_EXPECTED_SEQ_HEADER,
  PRODUCER_ID_HEADER,
  PRODUCER_RECEIVED_SEQ_HEADER,
  PRODUCER_SEQ_HEADER,
  STREAM_OFFSET_HEADER,
} from "./constants"
import type { DurableStream } from "./stream"
import type { IdempotentProducerOptions, Offset } from "./types"

/**
 * Error thrown when a producer's epoch is stale (zombie fencing).
 */
export class StaleEpochError extends Error {
  /**
   * The current epoch on the server.
   */
  readonly currentEpoch: number

  constructor(currentEpoch: number) {
    super(
      `Producer epoch is stale. Current server epoch: ${currentEpoch}. ` +
        `Call restart() or create a new producer with a higher epoch.`
    )
    this.name = `StaleEpochError`
    this.currentEpoch = currentEpoch
  }
}

/**
 * Error thrown when a sequence gap is detected.
 * This should never happen with proper client implementation.
 */
export class SequenceGapError extends Error {
  readonly expectedSeq: number
  readonly receivedSeq: number

  constructor(expectedSeq: number, receivedSeq: number) {
    super(
      `Producer sequence gap: expected ${expectedSeq}, received ${receivedSeq}`
    )
    this.name = `SequenceGapError`
    this.expectedSeq = expectedSeq
    this.receivedSeq = receivedSeq
  }
}

/**
 * Normalize content-type by extracting the media type (before any semicolon).
 */
function normalizeContentType(contentType: string | undefined): string {
  if (!contentType) return ``
  return contentType.split(`;`)[0]!.trim().toLowerCase()
}

/**
 * Internal type for pending batch entries.
 * Stores original data for proper JSON batching.
 * resolve/reject are optional to support fire-and-forget (appendNoWait).
 */
interface PendingEntry {
  /** Original data - parsed for JSON mode batching */
  data: unknown
  /** Encoded bytes for byte-stream mode */
  body: Uint8Array
  resolve?: (result: { offset: Offset; duplicate: boolean }) => void
  reject?: (error: Error) => void
}

/**
 * An idempotent producer for exactly-once writes to a durable stream.
 *
 * Features:
 * - Fire-and-forget: append() returns immediately, batches in background
 * - Exactly-once: server deduplicates using (producerId, epoch, seq)
 * - Batching: multiple appends batched into single HTTP request
 * - Pipelining: up to maxInFlight concurrent batches
 * - Zombie fencing: stale producers rejected via epoch validation
 *
 * @example
 * ```typescript
 * const stream = new DurableStream({ url: "https://..." });
 * const producer = new IdempotentProducer(stream, "order-service-1", {
 *   epoch: 0,
 *   autoClaim: true,
 * });
 *
 * // Fire-and-forget writes
 * await producer.append("message 1");
 * await producer.append("message 2");
 *
 * // Ensure all messages are delivered before shutdown
 * await producer.flush();
 * await producer.close();
 * ```
 */
export class IdempotentProducer {
  readonly #stream: DurableStream
  readonly #producerId: string
  #epoch: number
  #nextSeq = 0
  readonly #autoClaim: boolean
  readonly #maxBatchBytes: number
  readonly #lingerMs: number
  readonly #maxInFlight: number
  readonly #fetchClient: typeof fetch
  readonly #signal?: AbortSignal
  readonly #onError?: (error: Error) => void

  // Batching state
  #pendingBatch: Array<PendingEntry> = []
  #batchBytes = 0
  #lingerTimeout: ReturnType<typeof setTimeout> | null = null

  // Pipelining state
  #inFlight = new Map<number, Promise<void>>() // seq -> pending request
  #closed = false

  /**
   * Create an idempotent producer for a stream.
   *
   * @param stream - The DurableStream to write to
   * @param producerId - Stable identifier for this producer (e.g., "order-service-1")
   * @param opts - Producer options
   */
  constructor(
    stream: DurableStream,
    producerId: string,
    opts?: IdempotentProducerOptions
  ) {
    this.#stream = stream
    this.#producerId = producerId
    this.#epoch = opts?.epoch ?? 0
    this.#autoClaim = opts?.autoClaim ?? false
    this.#maxBatchBytes = opts?.maxBatchBytes ?? 1024 * 1024 // 1MB
    this.#lingerMs = opts?.lingerMs ?? 5
    // Default to 1 for safety: HTTP request reordering with maxInFlight > 1
    // can cause 409 sequence gaps when seq=N arrives before seq=N-1
    this.#maxInFlight = opts?.maxInFlight ?? 1
    this.#signal = opts?.signal
    this.#onError = opts?.onError
    this.#fetchClient =
      opts?.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args))

    // Guardrail: autoClaim + maxInFlight > 1 is unsafe
    // Multiple concurrent batches hitting 403 would race to claim epochs
    if (this.#autoClaim && this.#maxInFlight > 1) {
      throw new Error(
        `autoClaim requires maxInFlight=1. With maxInFlight > 1, concurrent ` +
          `batches hitting 403 would race to claim epochs, causing split-brain.`
      )
    }

    // Handle signal abort (use { once: true } to auto-cleanup)
    if (this.#signal) {
      this.#signal.addEventListener(
        `abort`,
        () => {
          this.#rejectPendingBatch(
            new DurableStreamError(
              `Producer aborted`,
              `ALREADY_CLOSED`,
              undefined,
              undefined
            )
          )
        },
        { once: true }
      )
    }
  }

  /**
   * Append data to the stream.
   *
   * The message is added to the current batch and sent when:
   * - maxBatchBytes is reached
   * - lingerMs elapses
   * - flush() is called
   *
   * @param body - Data to append (string or Uint8Array)
   * @returns Promise that resolves when the batch containing this message is acknowledged
   */
  async append(
    body: Uint8Array | string
  ): Promise<{ offset: Offset; duplicate: boolean }> {
    if (this.#closed) {
      throw new DurableStreamError(
        `Producer is closed`,
        `ALREADY_CLOSED`,
        undefined,
        undefined
      )
    }

    const bytes =
      typeof body === `string` ? new TextEncoder().encode(body) : body

    // For JSON mode, parse the body to store as data for proper batching
    // For byte mode, data is just the bytes
    const isJson =
      normalizeContentType(this.#stream.contentType) === `application/json`
    let data: unknown = bytes
    if (isJson) {
      try {
        const text =
          typeof body === `string` ? body : new TextDecoder().decode(body)
        data = JSON.parse(text)
      } catch {
        throw new DurableStreamError(
          `Invalid JSON in append body`,
          `BAD_REQUEST`,
          400,
          undefined
        )
      }
    }

    return new Promise((resolve, reject) => {
      this.#pendingBatch.push({ data, body: bytes, resolve, reject })
      this.#batchBytes += bytes.length

      // Check if batch should be sent immediately
      if (this.#batchBytes >= this.#maxBatchBytes) {
        this.#sendCurrentBatch()
      } else if (!this.#lingerTimeout) {
        // Start linger timer
        this.#lingerTimeout = setTimeout(() => {
          this.#lingerTimeout = null
          if (this.#pendingBatch.length > 0) {
            this.#sendCurrentBatch()
          }
        }, this.#lingerMs)
      }
    })
  }

  /**
   * Append data without waiting for acknowledgment (fire-and-forget).
   *
   * Errors are reported via the onError callback (required when using this method).
   * Use flush() to wait for all pending messages to be delivered.
   *
   * @param body - Data to append (string or Uint8Array)
   * @throws Error if onError callback is not configured
   */
  appendNoWait(body: Uint8Array | string): void {
    if (this.#closed) {
      throw new DurableStreamError(
        `Producer is closed`,
        `ALREADY_CLOSED`,
        undefined,
        undefined
      )
    }

    if (!this.#onError) {
      throw new Error(
        `appendNoWait() requires an onError callback. ` +
          `Configure onError in producer options or use append() instead.`
      )
    }

    const bytes =
      typeof body === `string` ? new TextEncoder().encode(body) : body

    // For JSON mode, parse the body to store as data for proper batching
    const isJson =
      normalizeContentType(this.#stream.contentType) === `application/json`
    let data: unknown = bytes
    if (isJson) {
      try {
        const text =
          typeof body === `string` ? body : new TextDecoder().decode(body)
        data = JSON.parse(text)
      } catch {
        throw new DurableStreamError(
          `Invalid JSON in append body`,
          `BAD_REQUEST`,
          400,
          undefined
        )
      }
    }

    // Add to batch without resolve/reject - errors go to onError callback
    this.#pendingBatch.push({ data, body: bytes })
    this.#batchBytes += bytes.length

    // Check if batch should be sent immediately
    if (this.#batchBytes >= this.#maxBatchBytes) {
      this.#sendCurrentBatch()
    } else if (!this.#lingerTimeout) {
      // Start linger timer
      this.#lingerTimeout = setTimeout(() => {
        this.#lingerTimeout = null
        if (this.#pendingBatch.length > 0) {
          this.#sendCurrentBatch()
        }
      }, this.#lingerMs)
    }
  }

  /**
   * Send any pending batch immediately and wait for all in-flight batches.
   *
   * Call this before shutdown to ensure all messages are delivered.
   */
  async flush(): Promise<void> {
    // Clear linger timeout
    if (this.#lingerTimeout) {
      clearTimeout(this.#lingerTimeout)
      this.#lingerTimeout = null
    }

    // Loop until both pending and in-flight are drained
    // This handles the case where #sendCurrentBatch() bails due to maxInFlight,
    // and new in-flight promises are created after Promise.all() snapshot
    while (this.#pendingBatch.length > 0 || this.#inFlight.size > 0) {
      // Try to send pending batch
      if (this.#pendingBatch.length > 0) {
        this.#sendCurrentBatch()
      }

      // If still have pending but at capacity, wait for one to complete
      if (
        this.#pendingBatch.length > 0 &&
        this.#inFlight.size >= this.#maxInFlight
      ) {
        await Promise.race(this.#inFlight.values())
        continue
      }

      // Wait for all current in-flight to complete
      if (this.#inFlight.size > 0) {
        await Promise.all(this.#inFlight.values())
      }
    }
  }

  /**
   * Flush pending messages and close the producer.
   *
   * After calling close(), further append() calls will throw.
   */
  async close(): Promise<void> {
    if (this.#closed) return

    this.#closed = true

    try {
      await this.flush()
    } catch {
      // Ignore errors during close
    }
  }

  /**
   * Increment epoch and reset sequence.
   *
   * Call this when restarting the producer to establish a new session.
   * Flushes any pending messages first.
   */
  async restart(): Promise<void> {
    await this.flush()
    this.#epoch++
    this.#nextSeq = 0
  }

  /**
   * Current epoch for this producer.
   */
  get epoch(): number {
    return this.#epoch
  }

  /**
   * Next sequence number to be assigned.
   */
  get nextSeq(): number {
    return this.#nextSeq
  }

  /**
   * Number of messages in the current pending batch.
   */
  get pendingCount(): number {
    return this.#pendingBatch.length
  }

  /**
   * Number of batches currently in flight.
   */
  get inFlightCount(): number {
    return this.#inFlight.size
  }

  // ============================================================================
  // Private implementation
  // ============================================================================

  /**
   * Send the current batch and track it in flight.
   */
  #sendCurrentBatch(): void {
    if (this.#pendingBatch.length === 0) return

    // Wait if we've hit the in-flight limit
    if (this.#inFlight.size >= this.#maxInFlight) {
      // The batch will be sent when an in-flight request completes
      return
    }

    // Take the current batch
    const batch = this.#pendingBatch
    const seq = this.#nextSeq

    this.#pendingBatch = []
    this.#batchBytes = 0
    this.#nextSeq++

    // Track this batch in flight
    const promise = this.#sendBatch(batch, seq)
    this.#inFlight.set(seq, promise)

    // Clean up when done and maybe send pending batch
    promise
      .finally(() => {
        this.#inFlight.delete(seq)
        // Try to send pending batch if any
        if (
          this.#pendingBatch.length > 0 &&
          this.#inFlight.size < this.#maxInFlight
        ) {
          this.#sendCurrentBatch()
        }
      })
      .catch(() => {
        // Error handling is done in #sendBatch
      })
  }

  /**
   * Send a batch to the server.
   */
  async #sendBatch(batch: Array<PendingEntry>, seq: number): Promise<void> {
    try {
      const result = await this.#doSendBatch(batch, seq, this.#epoch)

      // Resolve all entries in the batch (if they have resolve callbacks)
      for (const entry of batch) {
        entry.resolve?.(result)
      }
    } catch (error) {
      // Reject all entries in the batch (if they have reject callbacks)
      // For fire-and-forget entries, call onError instead
      for (const entry of batch) {
        if (entry.reject) {
          entry.reject(error as Error)
        }
      }
      // Call onError for fire-and-forget batches
      if (this.#onError && batch.some((e) => !e.reject)) {
        this.#onError(error as Error)
      }
      throw error
    }
  }

  /**
   * Actually send the batch to the server.
   * Handles auto-claim retry on 403 (stale epoch) if autoClaim is enabled.
   * Does NOT implement general retry/backoff for network errors or 5xx responses.
   */
  async #doSendBatch(
    batch: Array<PendingEntry>,
    seq: number,
    epoch: number
  ): Promise<{ offset: Offset; duplicate: boolean }> {
    const contentType = this.#stream.contentType ?? `application/octet-stream`
    const isJson = normalizeContentType(contentType) === `application/json`

    // Build batch body based on content type
    let batchedBody: BodyInit
    if (isJson) {
      // For JSON mode: always send as array (server flattens one level)
      // Single append: [value] → server stores value
      // Multiple appends: [val1, val2] → server stores val1, val2
      const values = batch.map((e) => e.data)
      batchedBody = JSON.stringify(values)
    } else {
      // For byte mode: concatenate all chunks
      const totalSize = batch.reduce((sum, e) => sum + e.body.length, 0)
      const concatenated = new Uint8Array(totalSize)
      let offset = 0
      for (const entry of batch) {
        concatenated.set(entry.body, offset)
        offset += entry.body.length
      }
      batchedBody = concatenated
    }

    // Build URL
    const url = this.#stream.url

    // Build headers
    const headers: Record<string, string> = {
      "content-type": contentType,
      [PRODUCER_ID_HEADER]: this.#producerId,
      [PRODUCER_EPOCH_HEADER]: epoch.toString(),
      [PRODUCER_SEQ_HEADER]: seq.toString(),
    }

    // Send request
    const response = await this.#fetchClient(url, {
      method: `POST`,
      headers,
      body: batchedBody,
      signal: this.#signal,
    })

    // Handle response
    if (response.status === 204) {
      // Duplicate - idempotent success
      return { offset: ``, duplicate: true }
    }

    if (response.status === 200) {
      // Success
      const resultOffset = response.headers.get(STREAM_OFFSET_HEADER) ?? ``
      return { offset: resultOffset, duplicate: false }
    }

    if (response.status === 403) {
      // Stale epoch
      const currentEpochStr = response.headers.get(PRODUCER_EPOCH_HEADER)
      const currentEpoch = currentEpochStr
        ? parseInt(currentEpochStr, 10)
        : epoch

      if (this.#autoClaim) {
        // Auto-claim: retry with epoch+1
        const newEpoch = currentEpoch + 1
        this.#epoch = newEpoch
        this.#nextSeq = 1 // This batch will use seq 0

        // Retry with new epoch, starting at seq 0
        return this.#doSendBatch(batch, 0, newEpoch)
      }

      throw new StaleEpochError(currentEpoch)
    }

    if (response.status === 409) {
      // Sequence gap
      const expectedSeqStr = response.headers.get(PRODUCER_EXPECTED_SEQ_HEADER)
      const receivedSeqStr = response.headers.get(PRODUCER_RECEIVED_SEQ_HEADER)
      const expectedSeq = expectedSeqStr ? parseInt(expectedSeqStr, 10) : 0
      const receivedSeq = receivedSeqStr ? parseInt(receivedSeqStr, 10) : seq

      throw new SequenceGapError(expectedSeq, receivedSeq)
    }

    if (response.status === 400) {
      // Bad request (e.g., invalid epoch/seq)
      const error = await DurableStreamError.fromResponse(response, url)
      throw error
    }

    // Other errors - use FetchError for standard handling
    const error = await FetchError.fromResponse(response, url)
    throw error
  }

  /**
   * Reject all entries in the pending batch.
   */
  #rejectPendingBatch(error: Error): void {
    let hasFireAndForget = false
    for (const entry of this.#pendingBatch) {
      if (entry.reject) {
        entry.reject(error)
      } else {
        hasFireAndForget = true
      }
    }
    // Call onError for fire-and-forget entries
    if (hasFireAndForget && this.#onError) {
      this.#onError(error)
    }
    this.#pendingBatch = []
    this.#batchBytes = 0

    if (this.#lingerTimeout) {
      clearTimeout(this.#lingerTimeout)
      this.#lingerTimeout = null
    }
  }
}
