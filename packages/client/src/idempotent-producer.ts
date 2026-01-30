/**
 * IdempotentProducer - Fire-and-forget producer with exactly-once write semantics.
 *
 * Implements Kafka-style idempotent producer pattern with:
 * - Client-provided producer IDs (zero RTT overhead)
 * - Client-declared epochs, server-validated fencing
 * - Per-batch sequence numbers for deduplication
 * - Automatic batching and pipelining for throughput
 */

import fastq from "fastq"

import { DurableStreamError, FetchError } from "./error"
import {
  PRODUCER_EPOCH_HEADER,
  PRODUCER_EXPECTED_SEQ_HEADER,
  PRODUCER_ID_HEADER,
  PRODUCER_RECEIVED_SEQ_HEADER,
  PRODUCER_SEQ_HEADER,
  STREAM_CLOSED_HEADER,
  STREAM_OFFSET_HEADER,
} from "./constants"
import type { queueAsPromised } from "fastq"
import type { DurableStream } from "./stream"
import type { CloseResult, IdempotentProducerOptions, Offset } from "./types"

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
 * Error thrown when an unrecoverable sequence gap is detected.
 *
 * With maxInFlight > 1, HTTP requests can arrive out of order at the server,
 * causing temporary 409 responses. The client automatically handles these
 * by waiting for earlier sequences to complete, then retrying.
 *
 * This error is only thrown when the gap cannot be resolved (e.g., the
 * expected sequence is >= our sequence, indicating a true protocol violation).
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
 */
interface PendingEntry {
  /** Encoded bytes */
  body: Uint8Array
}

/**
 * Internal type for batch tasks submitted to the queue.
 */
interface BatchTask {
  batch: Array<PendingEntry>
  seq: number
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
 * // Fire-and-forget writes (synchronous, returns immediately)
 * producer.append("message 1");
 * producer.append("message 2");
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
  readonly #fetchClient: typeof fetch
  readonly #signal?: AbortSignal
  readonly #onError?: (error: Error) => void

  // Batching state
  #pendingBatch: Array<PendingEntry> = []
  #batchBytes = 0
  #lingerTimeout: ReturnType<typeof setTimeout> | null = null

  // Pipelining via fastq
  readonly #queue: queueAsPromised<BatchTask>
  readonly #maxInFlight: number
  #closed = false
  #closeResult: CloseResult | null = null
  #pendingFinalMessage?: Uint8Array | string

  // When autoClaim is true, we must wait for the first batch to complete
  // before allowing pipelining (to know what epoch was claimed)
  #epochClaimed: boolean

  // Track sequence completions for 409 retry coordination
  // When HTTP requests arrive out of order, we get 409 errors.
  // Maps epoch -> (seq -> { resolved, error?, waiters })
  #seqState: Map<
    number,
    Map<
      number,
      {
        resolved: boolean
        error?: Error
        waiters: Array<(err?: Error) => void>
      }
    >
  > = new Map()

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
    // Validate inputs
    const epoch = opts?.epoch ?? 0
    const maxBatchBytes = opts?.maxBatchBytes ?? 1024 * 1024 // 1MB
    const maxInFlight = opts?.maxInFlight ?? 5
    const lingerMs = opts?.lingerMs ?? 5

    if (epoch < 0) {
      throw new Error(`epoch must be >= 0`)
    }
    if (maxBatchBytes <= 0) {
      throw new Error(`maxBatchBytes must be > 0`)
    }
    if (maxInFlight <= 0) {
      throw new Error(`maxInFlight must be > 0`)
    }
    if (lingerMs < 0) {
      throw new Error(`lingerMs must be >= 0`)
    }

    this.#stream = stream
    this.#producerId = producerId
    this.#epoch = epoch
    this.#autoClaim = opts?.autoClaim ?? false
    this.#maxBatchBytes = maxBatchBytes
    this.#lingerMs = lingerMs
    this.#signal = opts?.signal
    this.#onError = opts?.onError
    this.#fetchClient =
      opts?.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args))

    this.#maxInFlight = maxInFlight

    // When autoClaim is true, epoch is not yet known until first batch completes
    // We block pipelining until then to avoid racing with the claim
    this.#epochClaimed = !this.#autoClaim

    // Initialize fastq with maxInFlight concurrency
    this.#queue = fastq.promise(this.#batchWorker.bind(this), this.#maxInFlight)

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
   * This is fire-and-forget: returns immediately after adding to the batch.
   * The message is batched and sent when:
   * - maxBatchBytes is reached
   * - lingerMs elapses
   * - flush() is called
   *
   * Errors are reported via onError callback if configured. Use flush() to
   * wait for all pending messages to be sent.
   *
   * For JSON streams, pass pre-serialized JSON strings.
   * For byte streams, pass string or Uint8Array.
   *
   * @param body - Data to append (string or Uint8Array)
   *
   * @example
   * ```typescript
   * // JSON stream
   * producer.append(JSON.stringify({ message: "hello" }));
   *
   * // Byte stream
   * producer.append("raw text data");
   * producer.append(new Uint8Array([1, 2, 3]));
   * ```
   */
  append(body: Uint8Array | string): void {
    if (this.#closed) {
      throw new DurableStreamError(
        `Producer is closed`,
        `ALREADY_CLOSED`,
        undefined,
        undefined
      )
    }

    let bytes: Uint8Array
    if (typeof body === `string`) {
      bytes = new TextEncoder().encode(body)
    } else if (body instanceof Uint8Array) {
      bytes = body
    } else {
      throw new DurableStreamError(
        `append() requires string or Uint8Array. For objects, use JSON.stringify().`,
        `BAD_REQUEST`,
        400,
        undefined
      )
    }

    this.#pendingBatch.push({ body: bytes })
    this.#batchBytes += bytes.length

    // Check if batch should be sent immediately
    if (this.#batchBytes >= this.#maxBatchBytes) {
      this.#enqueuePendingBatch()
    } else if (!this.#lingerTimeout) {
      // Start linger timer
      this.#lingerTimeout = setTimeout(() => {
        this.#lingerTimeout = null
        if (this.#pendingBatch.length > 0) {
          this.#enqueuePendingBatch()
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

    // Enqueue any pending batch
    if (this.#pendingBatch.length > 0) {
      this.#enqueuePendingBatch()
    }

    // Wait for queue to drain
    await this.#queue.drained()
  }

  /**
   * Stop the producer without closing the underlying stream.
   *
   * Use this when you want to:
   * - Hand off writing to another producer
   * - Keep the stream open for future writes
   * - Stop this producer but not signal EOF to readers
   *
   * Flushes any pending messages before detaching.
   * After calling detach(), further append() calls will throw.
   */
  async detach(): Promise<void> {
    if (this.#closed) return

    this.#closed = true

    try {
      await this.flush()
    } catch {
      // Ignore errors during detach
    }
  }

  /**
   * Flush pending messages and close the underlying stream (EOF).
   *
   * This is the typical way to end a producer session. It:
   * 1. Flushes all pending messages
   * 2. Optionally appends a final message
   * 3. Closes the stream (no further appends permitted)
   *
   * **Idempotent**: Unlike `DurableStream.close({ body })`, this method is
   * idempotent even with a final message because it uses producer headers
   * for deduplication. Safe to retry on network failures.
   *
   * @param finalMessage - Optional final message to append atomically with close
   * @returns CloseResult with the final offset
   */
  async close(finalMessage?: Uint8Array | string): Promise<CloseResult> {
    if (this.#closed) {
      // Already closed - return cached result for idempotency
      if (this.#closeResult) {
        return this.#closeResult
      }
      // Retry path: flush() threw on a previous attempt, so we need to re-run
      // the entire close sequence with the stored finalMessage
      await this.flush()
      const result = await this.#doClose(this.#pendingFinalMessage)
      this.#closeResult = result
      return result
    }

    this.#closed = true

    // Store finalMessage for retry safety (if flush() throws, we can retry)
    this.#pendingFinalMessage = finalMessage

    // Flush pending messages first
    await this.flush()

    // Close the stream with optional final message
    const result = await this.#doClose(finalMessage)
    this.#closeResult = result
    return result
  }

  /**
   * Actually close the stream with optional final message.
   * Uses producer headers for idempotency.
   */
  async #doClose(finalMessage?: Uint8Array | string): Promise<CloseResult> {
    const contentType = this.#stream.contentType ?? `application/octet-stream`
    const isJson = normalizeContentType(contentType) === `application/json`

    // Build body if final message is provided
    let body: BodyInit | undefined
    if (finalMessage !== undefined) {
      const bodyBytes =
        typeof finalMessage === `string`
          ? new TextEncoder().encode(finalMessage)
          : finalMessage

      if (isJson) {
        // For JSON mode, wrap in array
        const jsonStr = new TextDecoder().decode(bodyBytes)
        body = `[${jsonStr}]`
      } else {
        body = bodyBytes as unknown as BodyInit
      }
    }

    // Capture the sequence number for this request (for retry safety)
    // We only increment #nextSeq after a successful response
    const seqForThisRequest = this.#nextSeq

    // Build headers with producer info and Stream-Closed
    const headers: Record<string, string> = {
      "content-type": contentType,
      [PRODUCER_ID_HEADER]: this.#producerId,
      [PRODUCER_EPOCH_HEADER]: this.#epoch.toString(),
      [PRODUCER_SEQ_HEADER]: seqForThisRequest.toString(),
      [STREAM_CLOSED_HEADER]: `true`,
    }

    const response = await this.#fetchClient(this.#stream.url, {
      method: `POST`,
      headers,
      body,
      signal: this.#signal,
    })

    // Handle 204 (duplicate close - idempotent success)
    if (response.status === 204) {
      // Only increment seq on success (retry-safe)
      this.#nextSeq = seqForThisRequest + 1
      const finalOffset = response.headers.get(STREAM_OFFSET_HEADER) ?? ``
      return { finalOffset }
    }

    // Handle success
    if (response.status === 200) {
      // Only increment seq on success (retry-safe)
      this.#nextSeq = seqForThisRequest + 1
      const finalOffset = response.headers.get(STREAM_OFFSET_HEADER) ?? ``
      return { finalOffset }
    }

    // Handle errors
    if (response.status === 403) {
      // Stale epoch
      const currentEpochStr = response.headers.get(PRODUCER_EPOCH_HEADER)
      const currentEpoch = currentEpochStr
        ? parseInt(currentEpochStr, 10)
        : this.#epoch

      if (this.#autoClaim) {
        // Auto-claim: retry with epoch+1
        const newEpoch = currentEpoch + 1
        this.#epoch = newEpoch
        // Reset sequence for new epoch - set to 0 so the recursive call uses seq 0
        // (the first operation in a new epoch should be seq 0)
        this.#nextSeq = 0
        return this.#doClose(finalMessage)
      }

      throw new StaleEpochError(currentEpoch)
    }

    // Other errors
    const error = await FetchError.fromResponse(response, this.#stream.url)
    throw error
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
    return this.#queue.length()
  }

  // ============================================================================
  // Private implementation
  // ============================================================================

  /**
   * Enqueue the current pending batch for processing.
   */
  #enqueuePendingBatch(): void {
    if (this.#pendingBatch.length === 0) return

    // Take the current batch
    const batch = this.#pendingBatch
    const seq = this.#nextSeq

    this.#pendingBatch = []
    this.#batchBytes = 0
    this.#nextSeq++

    // When autoClaim is enabled and epoch hasn't been claimed yet,
    // we must wait for any in-flight batch to complete before sending more.
    // This ensures the first batch claims the epoch before pipelining begins.
    if (this.#autoClaim && !this.#epochClaimed && this.#queue.length() > 0) {
      // Wait for queue to drain, then push
      this.#queue.drained().then(() => {
        this.#queue.push({ batch, seq }).catch(() => {
          // Error handling is done in #batchWorker
        })
      })
    } else {
      // Push to fastq - it handles concurrency automatically
      this.#queue.push({ batch, seq }).catch(() => {
        // Error handling is done in #batchWorker
      })
    }
  }

  /**
   * Batch worker - processes batches via fastq.
   */
  async #batchWorker(task: BatchTask): Promise<void> {
    const { batch, seq } = task
    const epoch = this.#epoch

    try {
      await this.#doSendBatch(batch, seq, epoch)

      // Mark epoch as claimed after first successful batch
      // This enables full pipelining for subsequent batches
      if (!this.#epochClaimed) {
        this.#epochClaimed = true
      }

      // Signal success for this sequence (for 409 retry coordination)
      this.#signalSeqComplete(epoch, seq, undefined)
    } catch (error) {
      // Signal failure so waiting batches can fail too
      this.#signalSeqComplete(epoch, seq, error as Error)

      // Call onError callback if configured
      if (this.#onError) {
        this.#onError(error as Error)
      }
      throw error
    }
  }

  /**
   * Signal that a sequence has completed (success or failure).
   */
  #signalSeqComplete(
    epoch: number,
    seq: number,
    error: Error | undefined
  ): void {
    let epochMap = this.#seqState.get(epoch)
    if (!epochMap) {
      epochMap = new Map()
      this.#seqState.set(epoch, epochMap)
    }

    const state = epochMap.get(seq)
    if (state) {
      // Mark resolved and notify all waiters
      state.resolved = true
      state.error = error
      for (const waiter of state.waiters) {
        waiter(error)
      }
      state.waiters = []
    } else {
      // No waiters yet, just mark as resolved
      epochMap.set(seq, { resolved: true, error, waiters: [] })
    }

    // Clean up old entries to prevent unbounded memory growth.
    // We keep entries for the last maxInFlight * 3 sequences to handle
    // potential late 409 retries from pipelining.
    const cleanupThreshold = seq - this.#maxInFlight * 3
    if (cleanupThreshold > 0) {
      for (const oldSeq of epochMap.keys()) {
        if (oldSeq < cleanupThreshold) {
          epochMap.delete(oldSeq)
        }
      }
    }
  }

  /**
   * Wait for a specific sequence to complete.
   * Returns immediately if already completed.
   * Throws if the sequence failed.
   */
  #waitForSeq(epoch: number, seq: number): Promise<void> {
    let epochMap = this.#seqState.get(epoch)
    if (!epochMap) {
      epochMap = new Map()
      this.#seqState.set(epoch, epochMap)
    }

    const state = epochMap.get(seq)
    if (state?.resolved) {
      // Already completed
      if (state.error) {
        return Promise.reject(state.error)
      }
      return Promise.resolve()
    }

    // Not yet completed, add a waiter
    return new Promise((resolve, reject) => {
      const waiter = (err?: Error) => {
        if (err) reject(err)
        else resolve()
      }
      if (state) {
        state.waiters.push(waiter)
      } else {
        epochMap.set(seq, { resolved: false, waiters: [waiter] })
      }
    })
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
      // Input is pre-serialized JSON strings, join them into an array
      const jsonStrings = batch.map((e) => new TextDecoder().decode(e.body))
      batchedBody = `[${jsonStrings.join(`,`)}]`
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
      // Sequence gap - our request arrived before an earlier sequence
      const expectedSeqStr = response.headers.get(PRODUCER_EXPECTED_SEQ_HEADER)
      const expectedSeq = expectedSeqStr ? parseInt(expectedSeqStr, 10) : 0

      // If our seq is ahead of expectedSeq, wait for earlier sequences to complete then retry
      // This handles HTTP request reordering with maxInFlight > 1
      if (expectedSeq < seq) {
        // Wait for all sequences from expectedSeq to seq-1
        const waitPromises: Array<Promise<void>> = []
        for (let s = expectedSeq; s < seq; s++) {
          waitPromises.push(this.#waitForSeq(epoch, s))
        }
        await Promise.all(waitPromises)
        // Retry now that earlier sequences have completed
        return this.#doSendBatch(batch, seq, epoch)
      }

      // If expectedSeq >= seq, something is wrong (shouldn't happen) - throw error
      const receivedSeqStr = response.headers.get(PRODUCER_RECEIVED_SEQ_HEADER)
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
   * Clear pending batch and report error.
   */
  #rejectPendingBatch(error: Error): void {
    // Call onError callback if configured
    if (this.#onError && this.#pendingBatch.length > 0) {
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
