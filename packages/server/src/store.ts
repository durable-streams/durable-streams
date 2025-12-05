/**
 * In-memory stream storage.
 */

import type { PendingLongPoll, Stream, StreamMessage } from "./types"

/**
 * Process JSON data for append in JSON mode.
 * - Validates JSON
 * - Extracts array elements if data is an array
 * - Always appends trailing comma for easy concatenation
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
      return new Uint8Array(0)
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
 * In-memory store for durable streams.
 */
export class StreamStore {
  private streams = new Map<string, Stream>()
  private pendingLongPolls: Array<PendingLongPoll> = []

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
      // MIME types are case-insensitive per RFC 2045
      const normalizeContentType = (ct: string | undefined) =>
        (ct ?? `application/octet-stream`).toLowerCase()
      const contentTypeMatches =
        normalizeContentType(options.contentType) ===
        normalizeContentType(existing.contentType)
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
      currentOffset: `0_0`,
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

    // Check content type match (case-insensitive per RFC 2045)
    if (
      options.contentType &&
      stream.contentType &&
      options.contentType.toLowerCase() !== stream.contentType.toLowerCase()
    ) {
      throw new Error(
        `Content-type mismatch: expected ${stream.contentType}, got ${options.contentType}`
      )
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

    if (!offset || offset === `0_0`) {
      // Read from beginning
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
    if (stream.contentType?.toLowerCase() === `application/json`) {
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
   * Clear all streams.
   */
  clear(): void {
    // Cancel all pending long-polls
    for (const pending of this.pendingLongPolls) {
      clearTimeout(pending.timeoutId)
    }
    this.pendingLongPolls = []
    this.streams.clear()
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
    // Process JSON mode data
    let processedData = data
    if (stream.contentType?.toLowerCase() === `application/json`) {
      processedData = processJsonAppend(data)
    }

    // Parse current offset
    const parts = stream.currentOffset.split(`_`).map(Number)
    const readSeq = parts[0]!
    const byteOffset = parts[1]!

    // Calculate new offset
    const newByteOffset = byteOffset + processedData.length
    const newOffset = `${readSeq}_${newByteOffset}`

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
    for (let i = 0; i < stream.messages.length; i++) {
      if (this.compareOffsets(stream.messages[i]!.offset, offset) > 0) {
        return i
      }
    }
    return -1 // No messages after the offset
  }

  private compareOffsets(a: string, b: string): number {
    const aParts = a.split(`_`).map(Number)
    const bParts = b.split(`_`).map(Number)
    const aSeq = aParts[0]!
    const aOffset = aParts[1]!
    const bSeq = bParts[0]!
    const bOffset = bParts[1]!

    if (aSeq !== bSeq) {
      return aSeq - bSeq
    }
    return aOffset - bOffset
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
