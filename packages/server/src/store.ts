/**
 * In-memory stream storage.
 */

import type {
  PendingLongPoll,
  ProducerValidationResult,
  Stream,
  StreamMessage,
} from "./types"

/**
 * TTL for in-memory producer state cleanup (7 days).
 */
const PRODUCER_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000

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
 * @param isInitialCreate - If true, empty arrays are allowed (creates empty stream)
 * @throws Error if JSON is invalid or array is empty (for non-create operations)
 */
export function processJsonAppend(
  data: Uint8Array,
  isInitialCreate = false
): Uint8Array {
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
      // Empty arrays are valid for PUT (creates empty stream)
      // but invalid for POST (no-op append, likely a bug)
      if (isInitialCreate) {
        return new Uint8Array(0) // Return empty data for empty stream
      }
      throw new Error(`Empty arrays are not allowed`)
    }
    const elements = parsed.map((item) => JSON.stringify(item))
    result = elements.join(`,`) + `,`
  } else {
    // Single value - re-serialize to normalize whitespace (single-line JSON)
    result = JSON.stringify(parsed) + `,`
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
 * In-memory store for durable streams.
 */
/**
 * Options for append operations.
 */
export interface AppendOptions {
  seq?: string
  contentType?: string
  producerId?: string
  producerEpoch?: number
  producerSeq?: number
  close?: boolean // Close stream after append
}

/**
 * Result of an append operation.
 */
export interface AppendResult {
  message: StreamMessage | null
  producerResult?: ProducerValidationResult
  streamClosed?: boolean // Stream is now closed
}

export class StreamStore {
  private streams = new Map<string, Stream>()
  private pendingLongPolls: Array<PendingLongPoll> = []
  /**
   * Per-producer locks for serializing validation+append operations.
   * Key: "{streamPath}:{producerId}"
   */
  private producerLocks = new Map<string, Promise<unknown>>()

  /**
   * Check if a stream is expired based on TTL or Expires-At.
   */
  private isExpired(stream: Stream): boolean {
    const now = Date.now()

    // Check absolute expiry time
    if (stream.expiresAt) {
      const expiryTime = new Date(stream.expiresAt).getTime()
      // Treat invalid dates (NaN) as expired (fail closed)
      if (!Number.isFinite(expiryTime) || now >= expiryTime) {
        return true
      }
    }

    // Check TTL (sliding window from last access)
    if (stream.ttlSeconds !== undefined) {
      const expiryTime = stream.lastAccessedAt + stream.ttlSeconds * 1000
      if (now >= expiryTime) {
        return true
      }
    }

    return false
  }

  /**
   * Get a stream, handling expiry.
   * Returns undefined if stream doesn't exist or is expired (and has no refs).
   * Expired streams with refCount > 0 are soft-deleted instead of fully deleted.
   */
  private getIfNotExpired(path: string): Stream | undefined {
    const stream = this.streams.get(path)
    if (!stream) {
      return undefined
    }
    if (this.isExpired(stream)) {
      if (stream.refCount > 0) {
        // Expired with refs: soft-delete instead of full delete
        stream.softDeleted = true
        return stream
      }
      // Delete expired stream
      this.delete(path)
      return undefined
    }
    return stream
  }

  /**
   * Update lastAccessedAt to now. Called on reads and appends (not HEAD).
   */
  touchAccess(path: string): void {
    const stream = this.streams.get(path)
    if (stream) {
      stream.lastAccessedAt = Date.now()
    }
  }

  /**
   * Create a new stream.
   * @throws Error if stream already exists with different config
   * @throws Error if fork source not found, soft-deleted, or offset invalid
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
      forkedFrom?: string
      forkOffset?: string
      forkSubOffset?: number
    } = {}
  ): Stream {
    // Check if stream already exists
    const existingRaw = this.streams.get(path)
    if (existingRaw) {
      if (this.isExpired(existingRaw)) {
        // Expired: delete and proceed with creation
        this.streams.delete(path)
        this.cancelLongPollsForStream(path)
      } else if (existingRaw.softDeleted) {
        // Soft-deleted streams block new creation
        throw new Error(
          `Stream has active forks — path cannot be reused until all forks are removed: ${path}`
        )
      } else {
        // Check if config matches (idempotent create)
        const contentTypeMatches =
          (normalizeContentType(options.contentType) ||
            `application/octet-stream`) ===
          (normalizeContentType(existingRaw.contentType) ||
            `application/octet-stream`)
        const ttlMatches = options.ttlSeconds === existingRaw.ttlSeconds
        const expiresMatches = options.expiresAt === existingRaw.expiresAt
        const closedMatches =
          (options.closed ?? false) === (existingRaw.closed ?? false)
        const forkedFromMatches =
          (options.forkedFrom ?? undefined) === existingRaw.forkedFrom
        // Only compare forkOffset when explicitly provided; when omitted the
        // server resolves a default at creation time, so a second PUT that
        // also omits it should still be considered idempotent.
        const forkOffsetMatches =
          options.forkOffset === undefined ||
          options.forkOffset === existingRaw.forkOffset
        // Sub-offset: undefined and 0 are equivalent.
        const requestedSub = options.forkSubOffset ?? 0
        const existingSub = existingRaw.forkSubOffsetBytes ?? 0
        const forkSubOffsetMatches = requestedSub === existingSub

        if (
          contentTypeMatches &&
          ttlMatches &&
          expiresMatches &&
          closedMatches &&
          forkedFromMatches &&
          forkOffsetMatches &&
          forkSubOffsetMatches
        ) {
          // Idempotent success - return existing stream
          return existingRaw
        } else {
          // Config mismatch - conflict
          throw new Error(
            `Stream already exists with different configuration: ${path}`
          )
        }
      }
    }

    // Fork creation: validate source stream and resolve fork parameters
    const isFork = !!options.forkedFrom
    let forkOffset = `0000000000000000_0000000000000000`
    let sourceContentType: string | undefined
    let sourceStream: Stream | undefined
    let forkSubOffsetPrefix: Uint8Array | undefined

    if (isFork) {
      sourceStream = this.streams.get(options.forkedFrom!)
      if (!sourceStream) {
        throw new Error(`Source stream not found: ${options.forkedFrom}`)
      }
      if (sourceStream.softDeleted) {
        throw new Error(`Source stream is soft-deleted: ${options.forkedFrom}`)
      }
      if (this.isExpired(sourceStream)) {
        throw new Error(`Source stream not found: ${options.forkedFrom}`)
      }

      sourceContentType = sourceStream.contentType

      // Resolve fork offset: use provided or source's currentOffset
      if (options.forkOffset) {
        forkOffset = options.forkOffset
      } else {
        forkOffset = sourceStream.currentOffset
      }

      // Validate: zeroOffset <= forkOffset <= source.currentOffset
      const zeroOffset = `0000000000000000_0000000000000000`
      if (forkOffset < zeroOffset || sourceStream.currentOffset < forkOffset) {
        throw new Error(`Invalid fork offset: ${forkOffset}`)
      }

      // Resolve sub-offset against the source. Both binary and JSON return
      // a synthetic prefix to materialize as the fork's first own message,
      // because in this store one POST = one message regardless of mode.
      if (options.forkSubOffset && options.forkSubOffset > 0) {
        forkSubOffsetPrefix = this.resolveForkSubOffset(
          sourceStream,
          forkOffset,
          options.forkSubOffset,
          normalizeContentType(sourceContentType) === `application/json`
        )
      }

      // Increment source refcount
      sourceStream.refCount++
    }

    // Determine content type: use options, or inherit from source if fork
    let contentType = options.contentType
    if (!contentType || contentType.trim() === ``) {
      if (isFork) {
        contentType = sourceContentType
      }
    } else if (
      isFork &&
      normalizeContentType(contentType) !==
        normalizeContentType(sourceContentType)
    ) {
      throw new Error(`Content type mismatch with source stream`)
    }

    // Compute effective expiry for forks
    let effectiveExpiresAt = options.expiresAt
    let effectiveTtlSeconds = options.ttlSeconds
    if (isFork) {
      const resolved = this.resolveForkExpiry(options, sourceStream!)
      effectiveExpiresAt = resolved.expiresAt
      effectiveTtlSeconds = resolved.ttlSeconds
    }

    const stream: Stream = {
      path,
      contentType,
      messages: [],
      currentOffset: isFork ? forkOffset : `0000000000000000_0000000000000000`,
      ttlSeconds: effectiveTtlSeconds,
      expiresAt: effectiveExpiresAt,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      closed: options.closed ?? false,
      refCount: 0,
      forkedFrom: isFork ? options.forkedFrom : undefined,
      forkOffset: isFork ? forkOffset : undefined,
    }

    // Materialize sub-offset prefix as the fork's first own message.
    if (forkSubOffsetPrefix && forkSubOffsetPrefix.length > 0) {
      const parts = stream.currentOffset.split(`_`).map(Number)
      const readSeq = parts[0]!
      const byteOffset = parts[1]!
      const newByteOffset = byteOffset + forkSubOffsetPrefix.length
      const newOffset = `${String(readSeq).padStart(16, `0`)}_${String(newByteOffset).padStart(16, `0`)}`
      stream.messages.push({
        data: forkSubOffsetPrefix,
        offset: newOffset,
        timestamp: Date.now(),
      })
      stream.currentOffset = newOffset
      stream.forkSubOffsetBytes = forkSubOffsetPrefix.length
    }

    // If initial data is provided, append it
    if (options.initialData && options.initialData.length > 0) {
      try {
        this.appendToStream(stream, options.initialData, true) // isInitialCreate = true
      } catch (err) {
        // Rollback source refcount on failure
        if (isFork && sourceStream) {
          sourceStream.refCount--
        }
        throw err
      }
    }

    this.streams.set(path, stream)
    return stream
  }

  /**
   * Resolve fork expiry per the decision table.
   * Forks have independent lifetimes — no capping at source expiry.
   */
  private resolveForkExpiry(
    opts: { ttlSeconds?: number; expiresAt?: string },
    sourceMeta: Stream
  ): { ttlSeconds?: number; expiresAt?: string } {
    // Fork explicitly requests TTL — use it
    if (opts.ttlSeconds !== undefined) {
      return { ttlSeconds: opts.ttlSeconds }
    }

    // Fork explicitly requests Expires-At — use it
    if (opts.expiresAt) {
      return { expiresAt: opts.expiresAt }
    }

    // No expiry requested — inherit from source
    if (sourceMeta.ttlSeconds !== undefined) {
      return { ttlSeconds: sourceMeta.ttlSeconds }
    }
    if (sourceMeta.expiresAt) {
      return { expiresAt: sourceMeta.expiresAt }
    }

    // Source has no expiry either
    return {}
  }

  /**
   * Get a stream by path.
   * Returns undefined if stream doesn't exist or is expired.
   * Returns soft-deleted streams (caller should check stream.softDeleted).
   */
  get(path: string): Stream | undefined {
    const stream = this.streams.get(path)
    if (!stream) {
      return undefined
    }
    if (this.isExpired(stream)) {
      if (stream.refCount > 0) {
        // Expired with refs: soft-delete instead of full delete
        stream.softDeleted = true
        return stream
      }
      this.delete(path)
      return undefined
    }
    return stream
  }

  /**
   * Check if a stream exists, is not expired, and is not soft-deleted.
   */
  has(path: string): boolean {
    const stream = this.get(path)
    if (!stream) return false
    if (stream.softDeleted) return false
    return true
  }

  /**
   * Delete a stream.
   * If the stream has forks (refCount > 0), it is soft-deleted instead of fully removed.
   * Returns true if the stream was found and deleted (or soft-deleted).
   */
  delete(path: string): boolean {
    const stream = this.streams.get(path)
    if (!stream) {
      return false
    }

    // Already soft-deleted: idempotent success
    if (stream.softDeleted) {
      return true
    }

    // If there are forks referencing this stream, soft-delete
    if (stream.refCount > 0) {
      stream.softDeleted = true
      return true
    }

    // RefCount == 0: full delete with cascading GC
    this.deleteWithCascade(path)
    return true
  }

  /**
   * Fully delete a stream and cascade to soft-deleted parents
   * whose refcount drops to zero.
   */
  private deleteWithCascade(path: string): void {
    const stream = this.streams.get(path)
    if (!stream) return

    const forkedFrom = stream.forkedFrom

    // Delete this stream's data
    this.streams.delete(path)
    this.cancelLongPollsForStream(path)

    // If this stream is a fork, decrement the source's refcount
    if (forkedFrom) {
      const parent = this.streams.get(forkedFrom)
      if (parent) {
        parent.refCount--
        if (parent.refCount < 0) {
          parent.refCount = 0
        }

        // If parent refcount hit 0 and parent is soft-deleted, cascade
        if (parent.refCount === 0 && parent.softDeleted) {
          this.deleteWithCascade(forkedFrom)
        }
      }
    }
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
   * @throws Error if stream doesn't exist or is expired
   * @throws Error if seq is lower than lastSeq
   * @throws Error if JSON mode and array is empty
   */
  append(
    path: string,
    data: Uint8Array,
    options: AppendOptions = {}
  ): StreamMessage | AppendResult {
    const stream = this.getIfNotExpired(path)
    if (!stream) {
      throw new Error(`Stream not found: ${path}`)
    }

    // Guard against soft-deleted streams
    if (stream.softDeleted) {
      throw new Error(`Stream is soft-deleted: ${path}`)
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
        throw new Error(
          `Content-type mismatch: expected ${stream.contentType}, got ${options.contentType}`
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
        throw new Error(
          `Sequence conflict: ${options.seq} <= ${stream.lastSeq}`
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

    if (stream.softDeleted) {
      throw new Error(`Stream is soft-deleted: ${path}`)
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
   * For forked streams, stitches messages from the source chain and the fork's own messages.
   * @throws Error if stream doesn't exist or is expired
   */
  read(
    path: string,
    offset?: string
  ): { messages: Array<StreamMessage>; upToDate: boolean } {
    const stream = this.getIfNotExpired(path)
    if (!stream) {
      throw new Error(`Stream not found: ${path}`)
    }

    // No offset or -1 means start from beginning
    if (!offset || offset === `-1`) {
      if (stream.forkedFrom) {
        // Read all inherited messages from source chain, plus fork's own
        const inherited = this.readForkedMessages(
          stream.forkedFrom,
          undefined,
          stream.forkOffset!
        )
        return {
          messages: [...inherited, ...stream.messages],
          upToDate: true,
        }
      }
      return {
        messages: [...stream.messages],
        upToDate: true,
      }
    }

    if (stream.forkedFrom) {
      return this.readFromFork(stream, offset)
    }

    // Non-forked stream: find messages after the given offset
    const offsetIndex = this.findOffsetIndex(stream, offset)
    if (offsetIndex === -1) {
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
   * Read from a forked stream, stitching inherited and own messages.
   */
  private readFromFork(
    stream: Stream,
    offset: string
  ): { messages: Array<StreamMessage>; upToDate: boolean } {
    const messages: Array<StreamMessage> = []

    // If offset is before the forkOffset, read from source chain
    if (offset < stream.forkOffset!) {
      const inherited = this.readForkedMessages(
        stream.forkedFrom!,
        offset,
        stream.forkOffset!
      )
      messages.push(...inherited)
    }

    // Read fork's own messages (offset >= forkOffset)
    const ownMessages = this.readOwnMessages(stream, offset)
    messages.push(...ownMessages)

    return {
      messages,
      upToDate: true,
    }
  }

  /**
   * Read a stream's own messages starting after the given offset.
   */
  private readOwnMessages(
    stream: Stream,
    offset: string
  ): Array<StreamMessage> {
    const offsetIndex = this.findOffsetIndex(stream, offset)
    if (offsetIndex === -1) {
      return []
    }
    return stream.messages.slice(offsetIndex)
  }

  /**
   * Recursively read messages from a fork's source chain.
   * Reads from source (and its sources if also forked), capped at forkOffset.
   * Does NOT check softDeleted — forks must read through soft-deleted sources.
   */
  private readForkedMessages(
    sourcePath: string,
    offset: string | undefined,
    capOffset: string
  ): Array<StreamMessage> {
    const source = this.streams.get(sourcePath)
    if (!source) {
      return []
    }

    const messages: Array<StreamMessage> = []

    // If source is also a fork and offset is before source's forkOffset,
    // recursively read from source's source
    if (source.forkedFrom && (!offset || offset < source.forkOffset!)) {
      const inherited = this.readForkedMessages(
        source.forkedFrom,
        offset,
        // Cap at the minimum of source's forkOffset and our capOffset
        source.forkOffset! < capOffset ? source.forkOffset! : capOffset
      )
      messages.push(...inherited)
    }

    // Read source's own messages, capped at capOffset
    for (const msg of source.messages) {
      if (offset && msg.offset <= offset) continue
      if (msg.offset > capOffset) break
      messages.push(msg)
    }

    return messages
  }

  /**
   * Format messages for response.
   * For JSON mode, wraps concatenated data in array brackets.
   * @throws Error if stream doesn't exist or is expired
   */
  formatResponse(path: string, messages: Array<StreamMessage>): Uint8Array {
    const stream = this.getIfNotExpired(path)
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
   * @throws Error if stream doesn't exist or is expired
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
      throw new Error(`Stream not found: ${path}`)
    }

    // For forks: if offset is in the inherited range (< forkOffset),
    // read and return immediately instead of long-polling
    if (stream.forkedFrom && offset < stream.forkOffset!) {
      const { messages } = this.read(path, offset)
      return { messages, timedOut: false }
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

  /**
   * Resolve a sub-offset against a source stream and return the prefix bytes
   * to materialize as the fork's first own message. Reads from the source
   * (across its fork chain if any) starting at forkOffset; the first message
   * returned is the one that starts at forkOffset. Throws if the sub-offset
   * cannot be satisfied (no message past forkOffset, or overshoots its
   * content extent).
   */
  private resolveForkSubOffset(
    sourceStream: Stream,
    forkOffset: string,
    subOffset: number,
    isJSON: boolean
  ): Uint8Array {
    // Read source past forkOffset across its fork chain
    let sourceMessages: Array<StreamMessage>
    if (sourceStream.forkedFrom) {
      sourceMessages = [
        ...this.readForkedMessages(
          sourceStream.forkedFrom,
          forkOffset,
          sourceStream.forkOffset!
        ),
        ...this.readOwnMessages(sourceStream, forkOffset),
      ]
    } else {
      sourceMessages = this.readOwnMessages(sourceStream, forkOffset)
    }
    if (sourceMessages.length === 0) {
      throw new Error(`Invalid fork sub-offset: no data past forkOffset`)
    }
    const first = sourceMessages[0]!
    if (isJSON) {
      // The message data is comma-joined JSON values with a trailing comma
      // (e.g., `{"a":1},{"b":2},`). Wrap in [...] to parse, take first N
      // elements, re-encode in the same comma-joined format.
      const text = new TextDecoder().decode(first.data)
      const trimmed = text.endsWith(`,`) ? text.slice(0, -1) : text
      let values: Array<unknown>
      try {
        values = JSON.parse(`[${trimmed}]`)
      } catch {
        throw new Error(`Invalid fork sub-offset: source JSON is unparseable`)
      }
      if (subOffset > values.length) {
        throw new Error(
          `Invalid fork sub-offset: overshoots source message count`
        )
      }
      const prefix = values.slice(0, subOffset).map((v) => JSON.stringify(v))
      return new TextEncoder().encode(prefix.join(`,`) + `,`)
    }
    // Binary: take first subOffset bytes
    if (subOffset > first.data.length) {
      throw new Error(
        `Invalid fork sub-offset: overshoots source message length`
      )
    }
    return first.data.slice(0, subOffset)
  }

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
