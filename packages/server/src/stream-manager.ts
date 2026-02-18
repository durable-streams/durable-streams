/**
 * StreamManager wraps a Store implementation and provides all
 * protocol logic: producer validation, JSON mode, content-type
 * matching, expiry, Stream-Seq, closedBy tracking, formatResponse,
 * and long-poll coordination.
 */

import type { AppendMetadata, Store, StreamInfo } from "./store"
import type {
  PendingLongPoll,
  ProducerState,
  ProducerValidationResult,
  Stream,
  StreamMessage,
} from "./types"

// TTL for producer state cleanup (7 days).
const PRODUCER_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000

// Normalize content-type by extracting the media type (before any semicolon).
// Handles cases like "application/json; charset=utf-8".
export function normalizeContentType(contentType: string | undefined): string {
  if (!contentType) return ``
  return contentType.split(`;`)[0]!.trim().toLowerCase()
}

// Process JSON data for append in JSON mode.
// - Validates JSON
// - Extracts array elements if data is an array
// - Always appends trailing comma for easy concatenation
// @param isInitialCreate - If true, empty arrays are allowed (creates empty stream)
// @throws Error if JSON is invalid or array is empty (for non-create operations)
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
      if (isInitialCreate) return new Uint8Array(0)
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

// Format JSON mode response by wrapping in array brackets.
// Strips trailing comma before wrapping.
export function formatJsonResponse(data: Uint8Array): Uint8Array {
  if (data.length === 0) return new TextEncoder().encode(`[]`)

  let text = new TextDecoder().decode(data)
  // Strip trailing comma if present
  text = text.trimEnd()
  if (text.endsWith(`,`)) text = text.slice(0, -1)

  return new TextEncoder().encode(`[${text}]`)
}

export interface AppendOptions {
  seq?: string
  contentType?: string
  producerId?: string
  producerEpoch?: number
  producerSeq?: number
  close?: boolean
}

export interface AppendResult {
  message: StreamMessage | null
  producerResult?: ProducerValidationResult
  streamClosed?: boolean
}

interface ProducerStates {
  producers: Map<string, ProducerState>
  closedBy?: { producerId: string; epoch: number; seq: number }
}

export class StreamManager {
  readonly storage: Store
  // Per-producer locks for serializing validation+append operations.
  // Key: "{streamPath}:{producerId}"
  private producerLocks = new Map<string, Promise<unknown>>()
  private producerStates = new Map<string, ProducerStates>()
  private pendingLongPolls: Array<PendingLongPoll> = []

  constructor(storage: Store) {
    this.storage = storage
  }

  private getProducerStatesSync(path: string): ProducerStates {
    let states = this.producerStates.get(path)
    if (!states) {
      states = { producers: new Map() }
      this.producerStates.set(path, states)
    }
    return states
  }

  private async getProducerStates(path: string): Promise<ProducerStates> {
    let states = this.producerStates.get(path)
    if (!states) {
      states = { producers: new Map() }
      const info = await this.storage.head(path)
      if (info?.producers) {
        for (const [id, s] of Object.entries(info.producers)) {
          states.producers.set(id, { ...s })
        }
      }
      if (info?.closedBy) {
        states.closedBy = { ...info.closedBy }
      }
      this.producerStates.set(path, states)
    }
    return states
  }

  // Clean up expired producer states.
  private cleanupExpiredProducers(states: ProducerStates): void {
    const now = Date.now()
    for (const [id, state] of states.producers) {
      if (now - state.lastUpdated > PRODUCER_STATE_TTL_MS) {
        states.producers.delete(id)
      }
    }
  }

  // Validate producer state WITHOUT mutating.
  // Returns proposed state to commit after successful append.
  //
  // IMPORTANT: This function does NOT mutate producer state. The caller must
  // commit the proposedState after successful append for atomicity.
  private async validateProducer(
    path: string,
    producerId: string,
    epoch: number,
    seq: number
  ): Promise<ProducerValidationResult> {
    const states = await this.getProducerStates(path)
    this.cleanupExpiredProducers(states)

    const state = states.producers.get(producerId)
    const now = Date.now()

    // New producer - accept if seq is 0
    if (!state) {
      if (seq !== 0) {
        return { status: `sequence_gap`, expectedSeq: 0, receivedSeq: seq }
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
      if (seq !== 0) return { status: `invalid_epoch_seq` }
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

  // Acquire a lock for serialized producer operations.
  // Returns a release function.
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

  async create(
    path: string,
    options: {
      contentType?: string
      ttlSeconds?: number
      expiresAt?: string
      initialData?: Uint8Array
      closed?: boolean
    } = {}
  ): Promise<Stream> {
    const info = await this.storage.head(path)
    if (info) {
      // Check if config matches (idempotent create)
      const contentTypeMatches =
        (normalizeContentType(options.contentType) ||
          `application/octet-stream`) ===
        (normalizeContentType(info.contentType) || `application/octet-stream`)
      const ttlMatches = options.ttlSeconds === info.ttlSeconds
      const expiresMatches = options.expiresAt === info.expiresAt
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      const closedMatches = (options.closed ?? false) === (info.closed ?? false)

      if (contentTypeMatches && ttlMatches && expiresMatches && closedMatches) {
        // Idempotent success - return existing stream
        return this.streamInfoToStream(path, info)
      }
      // Config mismatch - conflict
      throw new Error(
        `Stream already exists with different configuration: ${path}`
      )
    }

    await this.storage.create(path, {
      contentType: options.contentType,
      ttlSeconds: options.ttlSeconds,
      expiresAt: options.expiresAt,
    })

    if (options.initialData && options.initialData.length > 0) {
      let processedData = options.initialData
      if (normalizeContentType(options.contentType) === `application/json`) {
        processedData = processJsonAppend(options.initialData, true)
      }
      if (processedData.length > 0) {
        await this.storage.append(path, processedData)
      }
    }

    if (options.closed) {
      await this.storage.update(path, { closed: true })
    }

    const updated = await this.storage.head(path)
    return this.streamInfoToStream(path, updated!)
  }

  async get(path: string): Promise<Stream | undefined> {
    const info = await this.storage.head(path)
    if (!info) return undefined
    return this.streamInfoToStream(path, info)
  }

  async has(path: string): Promise<boolean> {
    const info = await this.storage.head(path)
    return info !== undefined
  }

  async delete(path: string): Promise<boolean> {
    const result = await this.storage.delete(path)
    this.producerStates.delete(path)
    this.cancelLongPollsForStream(path)
    return result
  }

  async append(
    path: string,
    data: Uint8Array,
    options: AppendOptions = {}
  ): Promise<StreamMessage | AppendResult> {
    const info = await this.storage.head(path)
    if (!info) throw new Error(`Stream not found: ${path}`)

    // Check if stream is closed
    if (info.closed) {
      // Check if this is a duplicate of the closing request (idempotent producer)
      if (
        options.producerId &&
        (await this.isClosedByProducer(path, options))
      ) {
        // Idempotent success - return 204 with Stream-Closed
        return {
          message: null,
          streamClosed: true,
          producerResult: {
            status: `duplicate`,
            lastSeq: options.producerSeq!,
          },
        }
      }
      // Stream is closed - reject append
      return { message: null, streamClosed: true }
    }

    // Check content type match using normalization (handles charset parameters)
    if (options.contentType && info.contentType) {
      const providedType = normalizeContentType(options.contentType)
      const streamType = normalizeContentType(info.contentType)
      if (providedType !== streamType) {
        throw new Error(
          `Content-type mismatch: expected ${info.contentType}, got ${options.contentType}`
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
      producerResult = await this.validateProducer(
        path,
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
      if (info.lastSeq !== undefined && options.seq <= info.lastSeq) {
        throw new Error(`Sequence conflict: ${options.seq} <= ${info.lastSeq}`)
      }
    }

    // Process JSON mode data (throws on invalid JSON or empty arrays for appends)
    // This is done BEFORE committing any state changes for atomicity
    let processedData = data
    if (normalizeContentType(info.contentType) === `application/json`) {
      processedData = processJsonAppend(data)
      if (processedData.length === 0) {
        return { message: null }
      }
    }

    // === STATE MUTATION HAPPENS HERE (only after successful append) ===
    const appendMeta: AppendMetadata = {}
    // Update Stream-Seq after append succeeds
    if (options.seq !== undefined) appendMeta.lastSeq = options.seq
    if (options.close) appendMeta.closed = true

    // Commit producer state after successful append
    if (producerResult && producerResult.status === `accepted`) {
      const states = this.getProducerStatesSync(path)
      states.producers.set(
        producerResult.producerId,
        producerResult.proposedState
      )
      const producers: Record<
        string,
        { epoch: number; lastSeq: number; lastUpdated: number }
      > = {}
      for (const [id, s] of states.producers) {
        producers[id] = {
          epoch: s.epoch,
          lastSeq: s.lastSeq,
          lastUpdated: s.lastUpdated,
        }
      }
      appendMeta.producers = producers

      // Close stream if requested, track which producer tuple closed the stream for idempotent duplicate detection
      if (options.close && options.producerId !== undefined) {
        states.closedBy = {
          producerId: options.producerId,
          epoch: options.producerEpoch!,
          seq: options.producerSeq!,
        }
        appendMeta.closedBy = states.closedBy
      }
    } else if (options.close && options.producerId !== undefined) {
      const states = this.getProducerStatesSync(path)
      states.closedBy = {
        producerId: options.producerId,
        epoch: options.producerEpoch!,
        seq: options.producerSeq!,
      }
      appendMeta.closedBy = states.closedBy
    }

    const hasMetadata = Object.keys(appendMeta).length > 0
    const newOffset = await this.storage.append(
      path,
      processedData,
      hasMetadata ? appendMeta : undefined
    )

    const message: StreamMessage = {
      data: processedData,
      offset: newOffset,
      timestamp: Date.now(),
    }

    // Notify pending long-polls that stream is closed
    if (options.close) {
      this.notifyLongPollsClosed(path)
    }

    // Notify any pending long-polls of new messages
    this.notifyLongPolls(path)

    // Return AppendResult if producer headers were used or stream was closed
    if (producerResult || options.close) {
      return { message, producerResult, streamClosed: options.close }
    }
    return message
  }

  // Append with producer serialization for concurrent request handling.
  // This ensures that validation+append is atomic per producer.
  async appendWithProducer(
    path: string,
    data: Uint8Array,
    options: AppendOptions
  ): Promise<AppendResult> {
    if (!options.producerId) {
      // No producer - just do a normal append
      const result = await this.append(path, data, options)
      if (`message` in result) return result
      return { message: result }
    }

    // Acquire lock for this producer
    const releaseLock = await this.acquireProducerLock(path, options.producerId)
    try {
      const result = await this.append(path, data, options)
      if (`message` in result) return result
      return { message: result }
    } finally {
      releaseLock()
    }
  }

  // Close a stream without appending data.
  // @returns The final offset, or null if stream doesn't exist
  async closeStream(
    path: string
  ): Promise<{ finalOffset: string; alreadyClosed: boolean } | null> {
    const info = await this.storage.head(path)
    if (!info) return null

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    const alreadyClosed = info.closed ?? false
    await this.storage.update(path, { closed: true })

    // Notify any pending long-polls that the stream is closed
    this.notifyLongPollsClosed(path)

    return { finalOffset: info.currentOffset, alreadyClosed }
  }

  // Close a stream with producer headers for idempotent close-only operations.
  // Participates in producer sequencing for deduplication.
  // @returns The final offset and producer result, or null if stream doesn't exist
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
      const info = await this.storage.head(path)
      if (!info) return null

      // Check if already closed
      if (info.closed) {
        const states = await this.getProducerStates(path)
        // Check if this is the same producer tuple (duplicate - idempotent success)
        if (
          states.closedBy &&
          states.closedBy.producerId === options.producerId &&
          states.closedBy.epoch === options.producerEpoch &&
          states.closedBy.seq === options.producerSeq
        ) {
          return {
            finalOffset: info.currentOffset,
            alreadyClosed: true,
            producerResult: {
              status: `duplicate`,
              lastSeq: options.producerSeq,
            },
          }
        }
        // Different producer trying to close an already-closed stream - conflict
        return {
          finalOffset: info.currentOffset,
          alreadyClosed: true,
          producerResult: { status: `stream_closed` },
        }
      }

      // Validate producer state
      const producerResult = await this.validateProducer(
        path,
        options.producerId,
        options.producerEpoch,
        options.producerSeq
      )

      // Return early for non-accepted results
      if (producerResult.status !== `accepted`) {
        return {
          finalOffset: info.currentOffset,
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          alreadyClosed: info.closed ?? false,
          producerResult,
        }
      }

      // Commit producer state and close stream
      const states = this.getProducerStatesSync(path)
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (producerResult.status === `accepted`) {
        states.producers.set(
          producerResult.producerId,
          producerResult.proposedState
        )
      }
      states.closedBy = {
        producerId: options.producerId,
        epoch: options.producerEpoch,
        seq: options.producerSeq,
      }
      const producers: Record<
        string,
        { epoch: number; lastSeq: number; lastUpdated: number }
      > = {}
      for (const [id, s] of states.producers) {
        producers[id] = {
          epoch: s.epoch,
          lastSeq: s.lastSeq,
          lastUpdated: s.lastUpdated,
        }
      }
      await this.storage.update(path, {
        closed: true,
        closedBy: states.closedBy,
        producers,
      })

      // Notify any pending long-polls
      this.notifyLongPollsClosed(path)

      return {
        finalOffset: info.currentOffset,
        alreadyClosed: false,
        producerResult,
      }
    } finally {
      releaseLock()
    }
  }

  // Get the current epoch for a producer on a stream.
  // Returns undefined if the producer doesn't exist or stream not found.
  getProducerEpoch(path: string, producerId: string): number | undefined {
    const states = this.producerStates.get(path)
    if (!states) return undefined
    return states.producers.get(producerId)?.epoch
  }

  async read(
    path: string,
    offset?: string
  ): Promise<{ messages: Array<StreamMessage>; upToDate: boolean }> {
    const { messages: stored } = await this.storage.read(path, offset)
    const messages: Array<StreamMessage> = stored.map((m) => ({
      data: m.data,
      offset: m.offset,
      timestamp: 0,
    }))
    return { messages, upToDate: true }
  }

  // Format messages for response.
  // For JSON mode, wraps concatenated data in array brackets.
  async formatResponse(
    path: string,
    messages: Array<StreamMessage>
  ): Promise<Uint8Array> {
    const info = await this.storage.head(path)
    if (!info) throw new Error(`Stream not found: ${path}`)

    // Concatenate all message data
    const totalSize = messages.reduce((sum, m) => sum + m.data.length, 0)
    const concatenated = new Uint8Array(totalSize)
    let offset = 0
    for (const msg of messages) {
      concatenated.set(msg.data, offset)
      offset += msg.data.length
    }

    // For JSON mode, wrap in array brackets
    if (normalizeContentType(info.contentType) === `application/json`) {
      return formatJsonResponse(concatenated)
    }
    return concatenated
  }

  // Wait for new messages (long-poll).
  async waitForMessages(
    path: string,
    offset: string,
    timeoutMs: number
  ): Promise<{
    messages: Array<StreamMessage>
    timedOut: boolean
    streamClosed?: boolean
  }> {
    const info = await this.storage.head(path)
    if (!info) throw new Error(`Stream not found: ${path}`)

    // Check if there are already new messages
    const { messages } = await this.read(path, offset)
    if (messages.length > 0) return { messages, timedOut: false }

    // If stream is closed and client is at tail, return immediately
    if (info.closed && offset === info.currentOffset) {
      return { messages: [], timedOut: false, streamClosed: true }
    }

    // Wait for new messages
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        // Remove from pending
        this.removePendingLongPoll(pending)
        // Check if stream was closed during the wait
        this.storage
          .head(path)
          .then((currentInfo) => {
            const streamClosed = currentInfo?.closed ?? false
            resolve({ messages: [], timedOut: true, streamClosed })
          })
          .catch(() => {
            resolve({ messages: [], timedOut: true })
          })
      }, timeoutMs)

      const pending: PendingLongPoll = {
        path,
        offset,
        resolve: (msgs) => {
          clearTimeout(timeoutId)
          this.removePendingLongPoll(pending)
          // Check if stream was closed (empty messages could mean closed)
          const streamMessages: Array<StreamMessage> = msgs.map((m) => ({
            data: m.data,
            offset: m.offset,
            timestamp: 0,
          }))
          this.storage
            .head(path)
            .then((currentInfo) => {
              const streamClosed =
                currentInfo?.closed && streamMessages.length === 0
                  ? true
                  : undefined
              resolve({
                messages: streamMessages,
                timedOut: false,
                streamClosed,
              })
            })
            .catch(() => {
              resolve({ messages: streamMessages, timedOut: false })
            })
        },
        timeoutId,
      }
      this.pendingLongPolls.push(pending)
    })
  }

  async getCurrentOffset(path: string): Promise<string | undefined> {
    const info = await this.storage.head(path)
    return info?.currentOffset
  }

  clear(): void {
    // Cancel all pending long-polls and resolve them with empty result
    for (const pending of this.pendingLongPolls) {
      clearTimeout(pending.timeoutId)
      // Resolve with empty result to unblock waiting handlers
      pending.resolve([])
    }
    this.pendingLongPolls = []
    this.producerStates.clear()
    this.storage.clear()
  }

  // Cancel all pending long-polls (used during shutdown).
  cancelAllWaits(): void {
    for (const pending of this.pendingLongPolls) {
      clearTimeout(pending.timeoutId)
      // Resolve with empty result to unblock waiting handlers
      pending.resolve([])
    }
    this.pendingLongPolls = []
  }

  async close(): Promise<void> {
    this.cancelAllWaits()
    this.producerStates.clear()
    await this.storage.close()
  }

  private async isClosedByProducer(
    path: string,
    options: AppendOptions
  ): Promise<boolean> {
    const states = await this.getProducerStates(path)
    if (!states.closedBy) return false
    return (
      states.closedBy.producerId === options.producerId &&
      states.closedBy.epoch === options.producerEpoch &&
      states.closedBy.seq === options.producerSeq
    )
  }

  private streamInfoToStream(path: string, info: StreamInfo): Stream {
    return {
      path,
      contentType: info.contentType,
      messages: [],
      currentOffset: info.currentOffset,
      lastSeq: info.lastSeq,
      ttlSeconds: info.ttlSeconds,
      expiresAt: info.expiresAt,
      createdAt: info.createdAt,
      closed: info.closed,
    }
  }

  private notifyLongPolls(path: string): void {
    const toNotify = this.pendingLongPolls.filter((p) => p.path === path)
    for (const pending of toNotify) {
      this.storage
        .read(path, pending.offset)
        .then(({ messages }) => {
          if (messages.length > 0) {
            pending.resolve(messages)
          }
        })
        .catch(() => {})
    }
  }

  // Notify pending long-polls that a stream has been closed.
  // They should wake up immediately and return Stream-Closed: true.
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
    if (index !== -1) this.pendingLongPolls.splice(index, 1)
  }
}
