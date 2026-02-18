/**
 * In-memory stream storage.
 */

import {
  formatJsonResponse,
  isExpired,
  normalizeContentType,
  processJsonAppend,
} from "../protocol"

import { advanceOffset, initialOffset } from "../offsets"

import {
  ContentTypeMismatchError,
  SequenceConflictError,
  StreamConflictError,
  StreamNotFoundError,
} from "../errors"
import type {
  AppendOptions,
  AppendResult,
  PendingLongPoll,
  ProducerValidationResult,
  Stream,
  StreamMessage,
} from "../types"

/**
 * TTL for in-memory producer state cleanup (7 days).
 */
const PRODUCER_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000

export class MemoryStore {
  private streams = new Map<string, Stream>()
  private pendingLongPolls: Array<PendingLongPoll> = []
  /**
   * Per-producer locks for serializing validation+append operations.
   * Key: "{streamPath}:{producerId}"
   */
  private producerLocks = new Map<string, Promise<unknown>>()

  /**
   * Get a stream, deleting it if expired.
   * Returns undefined if stream doesn't exist or is expired.
   */
  private getIfNotExpired(path: string): Stream | undefined {
    const stream = this.streams.get(path)
    if (!stream) {
      return undefined
    }
    if (isExpired(stream)) {
      this.delete(path)
      return undefined
    }
    return stream
  }

  /**
   * Create a new stream.
   * @throws StreamConflictError if stream already exists with different config
   * @returns existing stream if config matches (idempotent)
   */
  create(
    path: string,
    options: {
      contentType?: string
      ttlSeconds?: number
      expiresAt?: string
      initialData?: Uint8Array
      closed?: boolean
    } = {}
  ): Stream {
    // Use getIfNotExpired to treat expired streams as non-existent
    const existing = this.getIfNotExpired(path)
    if (existing) {
      // Check if config matches (idempotent create)
      const contentTypeMatches =
        (normalizeContentType(options.contentType) ||
          `application/octet-stream`) ===
        (normalizeContentType(existing.contentType) ||
          `application/octet-stream`)
      const ttlMatches = options.ttlSeconds === existing.ttlSeconds
      const expiresMatches = options.expiresAt === existing.expiresAt
      const closedMatches =
        (options.closed ?? false) === (existing.closed ?? false)

      if (contentTypeMatches && ttlMatches && expiresMatches && closedMatches) {
        // Idempotent success - return existing stream
        return existing
      } else {
        // Config mismatch - conflict
        throw new StreamConflictError(
          `Stream already exists with different configuration: ${path}`
        )
      }
    }

    const stream: Stream = {
      path,
      contentType: options.contentType,
      messages: [],
      currentOffset: initialOffset(),
      ttlSeconds: options.ttlSeconds,
      expiresAt: options.expiresAt,
      createdAt: Date.now(),
      closed: options.closed ?? false,
    }

    // If initial data is provided, append it
    if (options.initialData && options.initialData.length > 0) {
      this.appendToStream(stream, options.initialData, true) // isInitialCreate = true
    }

    this.streams.set(path, stream)
    return stream
  }

  /**
   * Get a stream by path.
   * Returns undefined if stream doesn't exist or is expired.
   */
  get(path: string): Stream | undefined {
    return this.getIfNotExpired(path)
  }

  /**
   * Check if a stream exists (and is not expired).
   */
  has(path: string): boolean {
    return this.getIfNotExpired(path) !== undefined
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
   * Validate producer state WITHOUT mutating.
   * Returns proposed state to commit after successful append.
   * Implements Kafka-style idempotent producer validation.
   *
   * IMPORTANT: This function does NOT mutate producer state. The caller must
   * call commitProducerState() after successful append to apply the mutation.
   * This ensures atomicity: if append fails (e.g., JSON validation), producer
   * state is not incorrectly advanced.
   */
  private validateProducer(
    stream: Stream,
    producerId: string,
    epoch: number,
    seq: number
  ): ProducerValidationResult {
    // Initialize producers map if needed (safe - just ensures map exists)
    if (!stream.producers) {
      stream.producers = new Map()
    }

    // Clean up expired producer states on access
    this.cleanupExpiredProducers(stream)

    const state = stream.producers.get(producerId)
    const now = Date.now()

    // New producer - accept if seq is 0
    if (!state) {
      if (seq !== 0) {
        return {
          status: `sequence_gap`,
          expectedSeq: 0,
          receivedSeq: seq,
        }
      }
      // Return proposed state, don't mutate yet
      return {
        status: `accepted`,
        isNew: true,
        producerId,
        proposedState: { epoch, lastSeq: 0, lastUpdated: now },
      }
    }

    // Epoch validation (client-declared, server-validated)
    if (epoch < state.epoch) {
      return { status: `stale_epoch`, currentEpoch: state.epoch }
    }

    if (epoch > state.epoch) {
      // New epoch must start at seq=0
      if (seq !== 0) {
        return { status: `invalid_epoch_seq` }
      }
      // Return proposed state for new epoch, don't mutate yet
      return {
        status: `accepted`,
        isNew: true,
        producerId,
        proposedState: { epoch, lastSeq: 0, lastUpdated: now },
      }
    }

    // Same epoch: sequence validation
    if (seq <= state.lastSeq) {
      return { status: `duplicate`, lastSeq: state.lastSeq }
    }

    if (seq === state.lastSeq + 1) {
      // Return proposed state, don't mutate yet
      return {
        status: `accepted`,
        isNew: false,
        producerId,
        proposedState: { epoch, lastSeq: seq, lastUpdated: now },
      }
    }

    // Sequence gap
    return {
      status: `sequence_gap`,
      expectedSeq: state.lastSeq + 1,
      receivedSeq: seq,
    }
  }

  /**
   * Commit producer state after successful append.
   * This is the only place where producer state is mutated.
   */
  private commitProducerState(
    stream: Stream,
    result: ProducerValidationResult
  ): void {
    if (result.status !== `accepted`) return
    stream.producers!.set(result.producerId, result.proposedState)
  }

  /**
   * Clean up expired producer states from a stream.
   */
  private cleanupExpiredProducers(stream: Stream): void {
    if (!stream.producers) return

    const now = Date.now()
    for (const [id, state] of stream.producers) {
      if (now - state.lastUpdated > PRODUCER_STATE_TTL_MS) {
        stream.producers.delete(id)
      }
    }
  }

  /**
   * Acquire a lock for serialized producer operations.
   * Returns a release function.
   */
  private async acquireProducerLock(
    path: string,
    producerId: string
  ): Promise<() => void> {
    const lockKey = `${path}:${producerId}`

    // Wait for any existing lock
    while (this.producerLocks.has(lockKey)) {
      await this.producerLocks.get(lockKey)
    }

    // Create our lock
    let releaseLock: () => void
    const lockPromise = new Promise<void>((resolve) => {
      releaseLock = resolve
    })
    this.producerLocks.set(lockKey, lockPromise)

    return () => {
      this.producerLocks.delete(lockKey)
      releaseLock!()
    }
  }

  /**
   * Append data to a stream.
   * @throws StreamNotFoundError if stream doesn't exist or is expired
   * @throws SequenceConflictError if seq is lower than lastSeq
   * @throws ContentTypeMismatchError if content types don't match
   */
  append(
    path: string,
    data: Uint8Array,
    options: AppendOptions = {}
  ): StreamMessage | AppendResult {
    const stream = this.getIfNotExpired(path)
    if (!stream) {
      throw new StreamNotFoundError(path)
    }

    // Check if stream is closed
    if (stream.closed) {
      // Check if this is a duplicate of the closing request (idempotent producer)
      if (
        options.producerId &&
        stream.closedBy &&
        stream.closedBy.producerId === options.producerId &&
        stream.closedBy.epoch === options.producerEpoch &&
        stream.closedBy.seq === options.producerSeq
      ) {
        // Idempotent success - return 204 with Stream-Closed
        return {
          message: null,
          streamClosed: true,
          producerResult: {
            status: `duplicate`,
            lastSeq: options.producerSeq,
          },
        }
      }

      // Stream is closed - reject append
      return {
        message: null,
        streamClosed: true,
      }
    }

    // Check content type match using normalization (handles charset parameters)
    if (options.contentType && stream.contentType) {
      const providedType = normalizeContentType(options.contentType)
      const streamType = normalizeContentType(stream.contentType)
      if (providedType !== streamType) {
        throw new ContentTypeMismatchError(
          stream.contentType,
          options.contentType
        )
      }
    }

    // Handle producer validation FIRST if producer headers are present
    // This must happen before Stream-Seq check so that retries with both
    // producer headers AND Stream-Seq can return 204 (duplicate) instead of
    // failing the Stream-Seq conflict check.
    // NOTE: validateProducer does NOT mutate state - it returns proposed state
    // that we commit AFTER successful append (for atomicity)
    let producerResult: ProducerValidationResult | undefined
    if (
      options.producerId !== undefined &&
      options.producerEpoch !== undefined &&
      options.producerSeq !== undefined
    ) {
      producerResult = this.validateProducer(
        stream,
        options.producerId,
        options.producerEpoch,
        options.producerSeq
      )

      // Return early for non-accepted results (duplicate, stale epoch, gap)
      // IMPORTANT: Return 204 for duplicate BEFORE Stream-Seq check
      if (producerResult.status !== `accepted`) {
        return { message: null, producerResult }
      }
    }

    // Check sequence for writer coordination (Stream-Seq, separate from Producer-Seq)
    // This happens AFTER producer validation so retries can be deduplicated
    if (options.seq !== undefined) {
      if (stream.lastSeq !== undefined && options.seq <= stream.lastSeq) {
        throw new SequenceConflictError(
          String(stream.lastSeq),
          String(options.seq)
        )
      }
    }

    // appendToStream can throw (e.g., for JSON validation errors)
    // This is done BEFORE committing any state changes for atomicity
    const message = this.appendToStream(stream, data)!

    // === STATE MUTATION HAPPENS HERE (only after successful append) ===

    // Commit producer state after successful append
    if (producerResult) {
      this.commitProducerState(stream, producerResult)
    }

    // Update Stream-Seq after append succeeds
    if (options.seq !== undefined) {
      stream.lastSeq = options.seq
    }

    // Close stream if requested
    if (options.close) {
      stream.closed = true
      // Track which producer tuple closed the stream for idempotent duplicate detection
      if (options.producerId !== undefined) {
        stream.closedBy = {
          producerId: options.producerId,
          epoch: options.producerEpoch!,
          seq: options.producerSeq!,
        }
      }
      // Notify pending long-polls that stream is closed
      this.notifyLongPollsClosed(path)
    }

    // Notify any pending long-polls of new messages
    this.notifyLongPolls(path)

    // Return AppendResult if producer headers were used or stream was closed
    if (producerResult || options.close) {
      return {
        message,
        producerResult,
        streamClosed: options.close,
      }
    }

    return message
  }

  /**
   * Append with producer serialization for concurrent request handling.
   * This ensures that validation+append is atomic per producer.
   */
  async appendWithProducer(
    path: string,
    data: Uint8Array,
    options: AppendOptions
  ): Promise<AppendResult> {
    if (!options.producerId) {
      // No producer - just do a normal append
      const result = this.append(path, data, options)
      if (`message` in result) {
        return result
      }
      return { message: result }
    }

    // Acquire lock for this producer
    const releaseLock = await this.acquireProducerLock(path, options.producerId)

    try {
      const result = this.append(path, data, options)
      if (`message` in result) {
        return result
      }
      return { message: result }
    } finally {
      releaseLock()
    }
  }

  /**
   * Close a stream without appending data.
   * @returns The final offset, or null if stream doesn't exist
   */
  closeStream(
    path: string
  ): { finalOffset: string; alreadyClosed: boolean } | null {
    const stream = this.getIfNotExpired(path)
    if (!stream) {
      return null
    }

    const alreadyClosed = stream.closed ?? false
    stream.closed = true

    // Notify any pending long-polls that the stream is closed
    this.notifyLongPollsClosed(path)

    return {
      finalOffset: stream.currentOffset,
      alreadyClosed,
    }
  }

  /**
   * Close a stream with producer headers for idempotent close-only operations.
   * Participates in producer sequencing for deduplication.
   * @returns The final offset and producer result, or null if stream doesn't exist
   */
  async closeStreamWithProducer(
    path: string,
    options: {
      producerId: string
      producerEpoch: number
      producerSeq: number
    }
  ): Promise<{
    finalOffset: string
    alreadyClosed: boolean
    producerResult?: ProducerValidationResult
  } | null> {
    // Acquire producer lock for serialization
    const releaseLock = await this.acquireProducerLock(path, options.producerId)

    try {
      const stream = this.getIfNotExpired(path)
      if (!stream) {
        return null
      }

      // Check if already closed
      if (stream.closed) {
        // Check if this is the same producer tuple (duplicate - idempotent success)
        if (
          stream.closedBy &&
          stream.closedBy.producerId === options.producerId &&
          stream.closedBy.epoch === options.producerEpoch &&
          stream.closedBy.seq === options.producerSeq
        ) {
          return {
            finalOffset: stream.currentOffset,
            alreadyClosed: true,
            producerResult: {
              status: `duplicate`,
              lastSeq: options.producerSeq,
            },
          }
        }

        // Different producer trying to close an already-closed stream - conflict
        return {
          finalOffset: stream.currentOffset,
          alreadyClosed: true,
          producerResult: { status: `stream_closed` },
        }
      }

      // Validate producer state
      const producerResult = this.validateProducer(
        stream,
        options.producerId,
        options.producerEpoch,
        options.producerSeq
      )

      // Return early for non-accepted results
      if (producerResult.status !== `accepted`) {
        return {
          finalOffset: stream.currentOffset,
          alreadyClosed: stream.closed ?? false,
          producerResult,
        }
      }

      // Commit producer state and close stream
      this.commitProducerState(stream, producerResult)
      stream.closed = true
      stream.closedBy = {
        producerId: options.producerId,
        epoch: options.producerEpoch,
        seq: options.producerSeq,
      }

      // Notify any pending long-polls
      this.notifyLongPollsClosed(path)

      return {
        finalOffset: stream.currentOffset,
        alreadyClosed: false,
        producerResult,
      }
    } finally {
      releaseLock()
    }
  }

  /**
   * Get the current epoch for a producer on a stream.
   * Returns undefined if the producer doesn't exist or stream not found.
   */
  getProducerEpoch(path: string, producerId: string): number | undefined {
    const stream = this.getIfNotExpired(path)
    if (!stream?.producers) {
      return undefined
    }
    return stream.producers.get(producerId)?.epoch
  }

  /**
   * Read messages from a stream starting at the given offset.
   * @throws StreamNotFoundError if stream doesn't exist or is expired
   */
  read(
    path: string,
    offset?: string
  ): { messages: Array<StreamMessage>; upToDate: boolean } {
    const stream = this.getIfNotExpired(path)
    if (!stream) {
      throw new StreamNotFoundError(path)
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
   * @throws StreamNotFoundError if stream doesn't exist or is expired
   */
  formatResponse(path: string, messages: Array<StreamMessage>): Uint8Array {
    const stream = this.getIfNotExpired(path)
    if (!stream) {
      throw new StreamNotFoundError(path)
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
   * @throws StreamNotFoundError if stream doesn't exist or is expired
   */
  async waitForMessages(
    path: string,
    offset: string,
    timeoutMs: number
  ): Promise<{
    messages: Array<StreamMessage>
    timedOut: boolean
    streamClosed?: boolean
  }> {
    const stream = this.getIfNotExpired(path)
    if (!stream) {
      throw new StreamNotFoundError(path)
    }

    // Check if there are already new messages
    const { messages } = this.read(path, offset)
    if (messages.length > 0) {
      return { messages, timedOut: false }
    }

    // If stream is closed and client is at tail, return immediately
    if (stream.closed && offset === stream.currentOffset) {
      return { messages: [], timedOut: false, streamClosed: true }
    }

    // Wait for new messages
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        // Remove from pending
        this.removePendingLongPoll(pending)
        // Check if stream was closed during the wait
        const currentStream = this.getIfNotExpired(path)
        const streamClosed = currentStream?.closed ?? false
        resolve({ messages: [], timedOut: true, streamClosed })
      }, timeoutMs)

      const pending: PendingLongPoll = {
        path,
        offset,
        resolve: (msgs) => {
          clearTimeout(timeoutId)
          this.removePendingLongPoll(pending)
          // Check if stream was closed (empty messages could mean closed)
          const currentStream = this.getIfNotExpired(path)
          const streamClosed =
            currentStream?.closed && msgs.length === 0 ? true : undefined
          resolve({ messages: msgs, timedOut: false, streamClosed })
        },
        timeoutId,
      }

      this.pendingLongPolls.push(pending)
    })
  }

  /**
   * Get the current offset for a stream.
   * Returns undefined if stream doesn't exist or is expired.
   */
  getCurrentOffset(path: string): string | undefined {
    return this.getIfNotExpired(path)?.currentOffset
  }

  /**
   * Clear all streams.
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

  private appendToStream(
    stream: Stream,
    data: Uint8Array,
    isInitialCreate = false
  ): StreamMessage | null {
    // Process JSON mode data (throws on invalid JSON or empty arrays for appends)
    let processedData = data
    if (normalizeContentType(stream.contentType) === `application/json`) {
      processedData = processJsonAppend(data, isInitialCreate)
      // If empty array in create mode, return null (empty stream created successfully)
      if (processedData.length === 0) {
        return null
      }
    }

    // Calculate new offset
    const newOffset = advanceOffset(stream.currentOffset, processedData.length)

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

  /**
   * Notify pending long-polls that a stream has been closed.
   * They should wake up immediately and return Stream-Closed: true.
   */
  private notifyLongPollsClosed(path: string): void {
    const toNotify = this.pendingLongPolls.filter((p) => p.path === path)
    for (const pending of toNotify) {
      // Resolve with empty messages - the caller will check stream.closed
      pending.resolve([])
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

export { MemoryStore as StreamStore }
