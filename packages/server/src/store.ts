/**
 * In-memory stream storage.
 */

import { randomUUID } from "node:crypto"
import type {
  IdempotentAppendOptions,
  IdempotentAppendResult,
  PendingBatch,
  PendingLongPoll,
  ProducerState,
  Stream,
  StreamMessage,
} from "./types"

/**
 * Normalize content-type by extracting the media type (before any semicolon).
 * Handles cases like "application/json; charset=utf-8".
 */
export function normalizeContentType(contentType: string | undefined): string {
  if (!contentType) return ``
  return contentType.split(`;`)[0]!.trim().toLowerCase()
}

/**
 * Process JSON data for append in JSON mode.
 * - Validates JSON
 * - Extracts array elements if data is an array
 * - Always appends trailing comma for easy concatenation
 * @throws Error if JSON is invalid or array is empty
 */
export function processJsonAppend(data: Uint8Array): Uint8Array {
  const text = new TextDecoder().decode(data)

  // Validate JSON
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`Invalid JSON`)
  }

  // If it's an array, extract elements and join with commas
  let result: string
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      throw new Error(`Empty arrays are not allowed`)
    }
    const elements = parsed.map((item) => JSON.stringify(item))
    result = elements.join(`,`) + `,`
  } else {
    // Single value - add trailing comma
    result = text.trim() + `,`
  }

  return new TextEncoder().encode(result)
}

/**
 * Format JSON mode response by wrapping in array brackets.
 * Strips trailing comma before wrapping.
 */
export function formatJsonResponse(data: Uint8Array): Uint8Array {
  if (data.length === 0) {
    return new TextEncoder().encode(`[]`)
  }

  let text = new TextDecoder().decode(data)
  // Strip trailing comma if present
  text = text.trimEnd()
  if (text.endsWith(`,`)) {
    text = text.slice(0, -1)
  }

  const wrapped = `[${text}]`
  return new TextEncoder().encode(wrapped)
}

/**
 * Maximum number of pending out-of-order batches per producer.
 */
const MAX_PENDING_BATCHES = 4

/**
 * In-memory store for durable streams.
 */
export class StreamStore {
  private streams = new Map<string, Stream>()
  private pendingLongPolls: Array<PendingLongPoll> = []
  private producers = new Map<string, ProducerState>()

  /**
   * Create a new stream.
   * @throws Error if stream already exists with different config
   * @returns existing stream if config matches (idempotent)
   */
  create(
    path: string,
    options: {
      contentType?: string
      ttlSeconds?: number
      expiresAt?: string
      initialData?: Uint8Array
    } = {}
  ): Stream {
    const existing = this.streams.get(path)
    if (existing) {
      // Check if config matches (idempotent create)
      const contentTypeMatches =
        (normalizeContentType(options.contentType) ||
          `application/octet-stream`) ===
        (normalizeContentType(existing.contentType) ||
          `application/octet-stream`)
      const ttlMatches = options.ttlSeconds === existing.ttlSeconds
      const expiresMatches = options.expiresAt === existing.expiresAt

      if (contentTypeMatches && ttlMatches && expiresMatches) {
        // Idempotent success - return existing stream
        return existing
      } else {
        // Config mismatch - conflict
        throw new Error(
          `Stream already exists with different configuration: ${path}`
        )
      }
    }

    const stream: Stream = {
      path,
      contentType: options.contentType,
      messages: [],
      currentOffset: `0000000000000000_0000000000000000`,
      ttlSeconds: options.ttlSeconds,
      expiresAt: options.expiresAt,
      createdAt: Date.now(),
    }

    // If initial data is provided, append it
    if (options.initialData && options.initialData.length > 0) {
      this.appendToStream(stream, options.initialData)
    }

    this.streams.set(path, stream)
    return stream
  }

  /**
   * Get a stream by path.
   */
  get(path: string): Stream | undefined {
    return this.streams.get(path)
  }

  /**
   * Check if a stream exists.
   */
  has(path: string): boolean {
    return this.streams.has(path)
  }

  /**
   * Delete a stream.
   */
  delete(path: string): boolean {
    // Cancel any pending long-polls for this stream
    this.cancelLongPollsForStream(path)
    return this.streams.delete(path)
  }

  /**
   * Append data to a stream.
   * @throws Error if stream doesn't exist
   * @throws Error if seq is lower than lastSeq
   * @throws Error if JSON mode and array is empty
   */
  append(
    path: string,
    data: Uint8Array,
    options: { seq?: string; contentType?: string } = {}
  ): StreamMessage {
    const stream = this.streams.get(path)
    if (!stream) {
      throw new Error(`Stream not found: ${path}`)
    }

    // Check content type match using normalization (handles charset parameters)
    if (options.contentType && stream.contentType) {
      const providedType = normalizeContentType(options.contentType)
      const streamType = normalizeContentType(stream.contentType)
      if (providedType !== streamType) {
        throw new Error(
          `Content-type mismatch: expected ${stream.contentType}, got ${options.contentType}`
        )
      }
    }

    // Check sequence for writer coordination
    if (options.seq !== undefined) {
      if (stream.lastSeq !== undefined && options.seq <= stream.lastSeq) {
        throw new Error(
          `Sequence conflict: ${options.seq} <= ${stream.lastSeq}`
        )
      }
      stream.lastSeq = options.seq
    }

    const message = this.appendToStream(stream, data)

    // Notify any pending long-polls
    this.notifyLongPolls(path)

    return message
  }

  /**
   * Idempotent append with producer ID and sequence number tracking.
   * Implements Kafka-style exactly-once semantics.
   */
  idempotentAppend(
    path: string,
    data: Uint8Array,
    options: IdempotentAppendOptions
  ): IdempotentAppendResult {
    const stream = this.streams.get(path)
    if (!stream) {
      throw new Error(`Stream not found: ${path}`)
    }

    // Check content type match
    if (options.contentType && stream.contentType) {
      const providedType = normalizeContentType(options.contentType)
      const streamType = normalizeContentType(stream.contentType)
      if (providedType !== streamType) {
        throw new Error(
          `Content-type mismatch: expected ${stream.contentType}, got ${options.contentType}`
        )
      }
    }

    // Handle new producer registration (producerId === '?')
    if (options.producerId === `?`) {
      return this.registerNewProducer(path, stream, data, options)
    }

    // Handle epoch bump request (producerEpoch === '?')
    if (options.producerEpoch === `?`) {
      return this.bumpProducerEpoch(path, options.producerId, data)
    }

    // Look up existing producer
    const producerKey = this.getProducerKey(options.producerId, path)
    const producer = this.producers.get(producerKey)

    if (!producer) {
      return {
        success: false,
        duplicate: false,
        producerState: {
          producerId: options.producerId,
          streamPath: path,
          epoch: 0,
          lastSequence: -1,
          pendingBatches: [],
          lastActivityAt: Date.now(),
        },
        error: {
          error: `UNKNOWN_PRODUCER`,
          message: `Producer ${options.producerId} not found`,
        },
        statusCode: 409,
      }
    }

    // Validate epoch (zombie fencing)
    const requestedEpoch =
      typeof options.producerEpoch === `string`
        ? parseInt(options.producerEpoch, 10)
        : options.producerEpoch

    if (requestedEpoch < producer.epoch) {
      return {
        success: false,
        duplicate: false,
        producerState: producer,
        error: {
          error: `PRODUCER_FENCED`,
          message: `Producer epoch ${requestedEpoch} is stale, current epoch is ${producer.epoch}`,
          currentEpoch: producer.epoch,
        },
        statusCode: 409,
      }
    }

    // Validate sequence number
    const sequence = options.sequence
    const expectedSequence = producer.lastSequence + 1

    // Duplicate detection
    if (sequence <= producer.lastSequence) {
      // This is a duplicate - return success without writing
      producer.lastActivityAt = Date.now()
      return {
        success: true,
        duplicate: true,
        producerState: producer,
        statusCode: 200,
      }
    }

    // Expected sequence - write immediately
    if (sequence === expectedSequence) {
      const message = this.appendToStream(stream, data)
      producer.lastSequence = sequence
      producer.lastActivityAt = Date.now()

      // Check if we can flush pending batches
      this.flushPendingBatches(producer, stream)

      // Notify long-polls
      this.notifyLongPolls(path)

      return {
        success: true,
        duplicate: false,
        message,
        producerState: producer,
        statusCode: 200,
      }
    }

    // Future sequence - buffer if we have room
    if (producer.pendingBatches.length < MAX_PENDING_BATCHES) {
      const pending: PendingBatch = {
        sequence,
        data,
        contentType: options.contentType,
        receivedAt: Date.now(),
      }

      // Insert in sorted order by sequence
      const insertIndex = producer.pendingBatches.findIndex(
        (b) => b.sequence > sequence
      )
      if (insertIndex === -1) {
        producer.pendingBatches.push(pending)
      } else {
        producer.pendingBatches.splice(insertIndex, 0, pending)
      }

      producer.lastActivityAt = Date.now()

      return {
        success: true,
        duplicate: false,
        producerState: producer,
        statusCode: 202,
        pending: true,
      }
    }

    // Too many pending batches - reject
    return {
      success: false,
      duplicate: false,
      producerState: producer,
      error: {
        error: `OUT_OF_ORDER_SEQUENCE`,
        message: `Expected sequence ${expectedSequence}, received ${sequence}`,
        expectedSequence,
        lastSequence: producer.lastSequence,
      },
      statusCode: 409,
    }
  }

  /**
   * Register a new producer and perform the first append.
   */
  private registerNewProducer(
    path: string,
    stream: Stream,
    data: Uint8Array,
    options: IdempotentAppendOptions
  ): IdempotentAppendResult {
    const producerId = randomUUID()
    const producerKey = this.getProducerKey(producerId, path)

    const producer: ProducerState = {
      producerId,
      streamPath: path,
      epoch: 0,
      lastSequence: -1,
      pendingBatches: [],
      lastActivityAt: Date.now(),
    }

    this.producers.set(producerKey, producer)

    // For new producers, sequence must be 0
    if (options.sequence !== 0) {
      return {
        success: false,
        duplicate: false,
        producerState: producer,
        error: {
          error: `OUT_OF_ORDER_SEQUENCE`,
          message: `New producer must start with sequence 0, received ${options.sequence}`,
          expectedSequence: 0,
          lastSequence: -1,
        },
        statusCode: 409,
      }
    }

    // Write the first message
    const message = this.appendToStream(stream, data)
    producer.lastSequence = 0

    // Notify long-polls
    this.notifyLongPolls(path)

    return {
      success: true,
      duplicate: false,
      message,
      producerState: producer,
      statusCode: 200,
    }
  }

  /**
   * Bump producer epoch (re-registration for zombie fencing).
   */
  private bumpProducerEpoch(
    path: string,
    producerId: string,
    data: Uint8Array
  ): IdempotentAppendResult {
    const producerKey = this.getProducerKey(producerId, path)
    let producer = this.producers.get(producerKey)

    if (!producer) {
      // Create a new producer with this ID
      producer = {
        producerId,
        streamPath: path,
        epoch: 0,
        lastSequence: -1,
        pendingBatches: [],
        lastActivityAt: Date.now(),
      }
      this.producers.set(producerKey, producer)
    } else {
      // Bump epoch and reset sequence
      producer.epoch++
      producer.lastSequence = -1
      producer.pendingBatches = []
      producer.lastActivityAt = Date.now()
    }

    // Empty body is allowed for epoch bump only
    // Check if data is effectively empty (just [] for JSON)
    const text = new TextDecoder().decode(data).trim()
    if (text === `[]` || data.length === 0) {
      return {
        success: true,
        duplicate: false,
        producerState: producer,
        statusCode: 200,
      }
    }

    // If data provided, this is an error for epoch bump
    return {
      success: false,
      duplicate: false,
      producerState: producer,
      error: {
        error: `OUT_OF_ORDER_SEQUENCE`,
        message: `Epoch bump request must have empty body`,
        expectedSequence: 0,
        lastSequence: -1,
      },
      statusCode: 400,
    }
  }

  /**
   * Flush pending batches that are now ready to write.
   */
  private flushPendingBatches(producer: ProducerState, stream: Stream): void {
    while (producer.pendingBatches.length > 0) {
      const nextPending = producer.pendingBatches[0]!
      if (nextPending.sequence === producer.lastSequence + 1) {
        // This batch is ready to write
        producer.pendingBatches.shift()
        this.appendToStream(stream, nextPending.data)
        producer.lastSequence = nextPending.sequence
      } else {
        // Gap still exists
        break
      }
    }
  }

  /**
   * Get a producer by ID and stream path.
   */
  getProducer(
    producerId: string,
    streamPath: string
  ): ProducerState | undefined {
    return this.producers.get(this.getProducerKey(producerId, streamPath))
  }

  /**
   * Generate producer key for the map.
   */
  private getProducerKey(producerId: string, streamPath: string): string {
    return `${producerId}:${streamPath}`
  }

  /**
   * Read messages from a stream starting at the given offset.
   */
  read(
    path: string,
    offset?: string
  ): { messages: Array<StreamMessage>; upToDate: boolean } {
    const stream = this.streams.get(path)
    if (!stream) {
      throw new Error(`Stream not found: ${path}`)
    }

    // No offset or -1 means start from beginning
    if (!offset || offset === `-1`) {
      return {
        messages: [...stream.messages],
        upToDate: true,
      }
    }

    // Find messages after the given offset
    const offsetIndex = this.findOffsetIndex(stream, offset)
    if (offsetIndex === -1) {
      // Offset is at or past the end
      return {
        messages: [],
        upToDate: true,
      }
    }

    return {
      messages: stream.messages.slice(offsetIndex),
      upToDate: true,
    }
  }

  /**
   * Format messages for response.
   * For JSON mode, wraps concatenated data in array brackets.
   */
  formatResponse(path: string, messages: Array<StreamMessage>): Uint8Array {
    const stream = this.streams.get(path)
    if (!stream) {
      throw new Error(`Stream not found: ${path}`)
    }

    // Concatenate all message data
    const totalSize = messages.reduce((sum, m) => sum + m.data.length, 0)
    const concatenated = new Uint8Array(totalSize)
    let offset = 0
    for (const msg of messages) {
      concatenated.set(msg.data, offset)
      offset += msg.data.length
    }

    // For JSON mode, wrap in array brackets
    if (normalizeContentType(stream.contentType) === `application/json`) {
      return formatJsonResponse(concatenated)
    }

    return concatenated
  }

  /**
   * Wait for new messages (long-poll).
   */
  async waitForMessages(
    path: string,
    offset: string,
    timeoutMs: number
  ): Promise<{ messages: Array<StreamMessage>; timedOut: boolean }> {
    const stream = this.streams.get(path)
    if (!stream) {
      throw new Error(`Stream not found: ${path}`)
    }

    // Check if there are already new messages
    const { messages } = this.read(path, offset)
    if (messages.length > 0) {
      return { messages, timedOut: false }
    }

    // Wait for new messages
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        // Remove from pending
        this.removePendingLongPoll(pending)
        resolve({ messages: [], timedOut: true })
      }, timeoutMs)

      const pending: PendingLongPoll = {
        path,
        offset,
        resolve: (msgs) => {
          clearTimeout(timeoutId)
          this.removePendingLongPoll(pending)
          resolve({ messages: msgs, timedOut: false })
        },
        timeoutId,
      }

      this.pendingLongPolls.push(pending)
    })
  }

  /**
   * Get the current offset for a stream.
   */
  getCurrentOffset(path: string): string | undefined {
    return this.streams.get(path)?.currentOffset
  }

  /**
   * Clear all streams and producer state.
   */
  clear(): void {
    // Cancel all pending long-polls and resolve them with timeout
    for (const pending of this.pendingLongPolls) {
      clearTimeout(pending.timeoutId)
      // Resolve with empty result to unblock waiting handlers
      pending.resolve([])
    }
    this.pendingLongPolls = []
    this.streams.clear()
    this.producers.clear()
  }

  /**
   * Cancel all pending long-polls (used during shutdown).
   */
  cancelAllWaits(): void {
    for (const pending of this.pendingLongPolls) {
      clearTimeout(pending.timeoutId)
      // Resolve with empty result to unblock waiting handlers
      pending.resolve([])
    }
    this.pendingLongPolls = []
  }

  /**
   * Get all stream paths.
   */
  list(): Array<string> {
    return Array.from(this.streams.keys())
  }

  // ============================================================================
  // Private helpers
  // ============================================================================

  private appendToStream(stream: Stream, data: Uint8Array): StreamMessage {
    // Process JSON mode data (throws on invalid JSON or empty arrays)
    let processedData = data
    if (normalizeContentType(stream.contentType) === `application/json`) {
      processedData = processJsonAppend(data)
    }

    // Parse current offset
    const parts = stream.currentOffset.split(`_`).map(Number)
    const readSeq = parts[0]!
    const byteOffset = parts[1]!

    // Calculate new offset with zero-padding for lexicographic sorting
    const newByteOffset = byteOffset + processedData.length
    const newOffset = `${String(readSeq).padStart(16, `0`)}_${String(newByteOffset).padStart(16, `0`)}`

    const message: StreamMessage = {
      data: processedData,
      offset: newOffset,
      timestamp: Date.now(),
    }

    stream.messages.push(message)
    stream.currentOffset = newOffset

    return message
  }

  private findOffsetIndex(stream: Stream, offset: string): number {
    // Find the first message with an offset greater than the given offset
    // Use lexicographic comparison as required by protocol
    for (let i = 0; i < stream.messages.length; i++) {
      if (stream.messages[i]!.offset > offset) {
        return i
      }
    }
    return -1 // No messages after the offset
  }

  private notifyLongPolls(path: string): void {
    const toNotify = this.pendingLongPolls.filter((p) => p.path === path)

    for (const pending of toNotify) {
      const { messages } = this.read(path, pending.offset)
      if (messages.length > 0) {
        pending.resolve(messages)
      }
    }
  }

  private cancelLongPollsForStream(path: string): void {
    const toCancel = this.pendingLongPolls.filter((p) => p.path === path)
    for (const pending of toCancel) {
      clearTimeout(pending.timeoutId)
      pending.resolve([])
    }
    this.pendingLongPolls = this.pendingLongPolls.filter((p) => p.path !== path)
  }

  private removePendingLongPoll(pending: PendingLongPoll): void {
    const index = this.pendingLongPolls.indexOf(pending)
    if (index !== -1) {
      this.pendingLongPolls.splice(index, 1)
    }
  }
}
