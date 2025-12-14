/**
 * IdempotentProducer - Provides exactly-once append semantics for durable streams.
 *
 * Implements Kafka-style idempotent producer semantics:
 * - Server-assigned producer IDs for tracking write sessions
 * - Producer epochs for zombie fencing
 * - Sequence number tracking with duplicate detection
 * - Safe retries - duplicates are detected and ignored
 */

import {
  STREAM_ACKED_SEQ_HEADER,
  STREAM_PRODUCER_EPOCH_HEADER,
  STREAM_PRODUCER_ID_HEADER,
} from "./constants"
import { IdempotentProducerError } from "./error"
import type { DurableStream } from "./stream"
import type { IdempotentAppendResult, IdempotentProducerState } from "./types"

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
 * Normalize content-type by extracting the media type (before any semicolon).
 */
function normalizeContentType(contentType: string | undefined): string {
  if (!contentType) return ``
  return contentType.split(`;`)[0]!.trim().toLowerCase()
}

/**
 * Encode a body value to the appropriate format.
 */
function encodeBody(
  body: unknown,
  isJson: boolean
): { encoded: BodyInit; size: number } {
  if (body instanceof Uint8Array) {
    // Cast to ensure compatible BodyInit type
    return { encoded: body as unknown as BodyInit, size: body.length }
  }
  if (typeof body === `string`) {
    const bytes = new TextEncoder().encode(body)
    return { encoded: bytes as unknown as BodyInit, size: bytes.length }
  }
  if (isJson) {
    // For JSON mode, wrap in array (server flattens one level)
    const jsonStr = JSON.stringify([body])
    const bytes = new TextEncoder().encode(jsonStr)
    return { encoded: bytes as unknown as BodyInit, size: bytes.length }
  }
  // For non-JSON, serialize as JSON bytes
  const jsonStr = JSON.stringify(body)
  const bytes = new TextEncoder().encode(jsonStr)
  return { encoded: bytes as unknown as BodyInit, size: bytes.length }
}

/**
 * IdempotentProducer provides exactly-once append semantics.
 *
 * @example
 * ```typescript
 * const stream = await DurableStream.create({
 *   url: "https://streams.example.com/my-stream",
 *   contentType: "application/json"
 * });
 *
 * const producer = new IdempotentProducer({ stream });
 *
 * // Safe to retry - duplicates are detected
 * await producer.append({ event: "user_clicked", button: "submit" });
 * await producer.append({ event: "page_viewed", page: "/home" });
 *
 * // Check producer state
 * console.log(producer.state);
 * // { producerId: "abc123", epoch: 0, nextSequence: 2, lastAckedSequence: 1, initialized: true, fenced: false }
 * ```
 */
export class IdempotentProducer {
  readonly #stream: DurableStream
  readonly #contentType?: string
  readonly #signal?: AbortSignal

  #producerId?: string
  #epoch?: number
  #nextSequence = 0
  #lastAckedSequence = -1
  #initialized = false
  #fenced = false

  constructor(options: IdempotentProducerOptions) {
    this.#stream = options.stream
    this.#contentType = options.contentType
    this.#signal = options.signal
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
   * Safe to retry on network errors - the server detects and ignores duplicates.
   *
   * @param body - The data to append (Uint8Array, string, or JSON-serializable value)
   * @param options - Optional append options
   * @returns Result with success status and metadata
   * @throws {IdempotentProducerError} On producer errors (fenced, unknown producer, etc.)
   */
  async append(
    body: unknown,
    options?: IdempotentAppendOptions
  ): Promise<IdempotentAppendResult> {
    if (this.#fenced) {
      throw new IdempotentProducerError(
        `Producer has been fenced (stale epoch)`,
        `PRODUCER_FENCED`,
        403,
        { currentEpoch: this.#epoch }
      )
    }

    const contentType =
      this.#contentType ?? this.#stream.contentType ?? `application/json`
    const isJson = normalizeContentType(contentType) === `application/json`

    const { encoded } = encodeBody(body, isJson)

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
    if (options?.signal) signals.push(options.signal)
    const combinedSignal =
      signals.length > 0 ? AbortSignal.any(signals) : undefined

    // Make the request directly to the stream URL
    const response = await fetch(this.#stream.url, {
      method: `POST`,
      headers,
      body: encoded,
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

    const response = await fetch(this.#stream.url, {
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
