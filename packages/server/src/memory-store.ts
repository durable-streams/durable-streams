/**
 * In-memory Store implementation.
 * Stores bytes in memory with Map-based storage and Promise-based wait notification.
 * No protocol logic — just store, read, wait.
 */

import type {
  AppendMetadata,
  ClosedByInfo,
  SerializableProducerState,
  Store,
  StoreConfig,
  StoredMessage,
  StreamInfo,
} from "./store"

interface MemoryStream {
  contentType?: string
  messages: Array<StoredMessage>
  currentOffset: string
  createdAt: number
  ttlSeconds?: number
  expiresAt?: string
  closed: boolean
  lastSeq?: string
  producers?: Record<string, SerializableProducerState>
  closedBy?: ClosedByInfo
}

interface PendingWaiter {
  path: string
  offset: string
  resolve: (result: {
    messages: Array<StoredMessage>
    timedOut: boolean
  }) => void
  timeoutId: ReturnType<typeof setTimeout>
  abortHandler?: () => void
  signal?: AbortSignal
}

export class MemoryStore implements Store {
  private streams = new Map<string, MemoryStream>()
  private waiters: Array<PendingWaiter> = []

  /**
   * Check if a stream is expired based on TTL or Expires-At.
   */
  private isExpired(stream: MemoryStream): boolean {
    const now = Date.now()

    // Check absolute expiry time
    if (stream.expiresAt) {
      const expiryTime = new Date(stream.expiresAt).getTime()
      // Treat invalid dates (NaN) as expired (fail closed)
      if (!Number.isFinite(expiryTime) || now >= expiryTime) return true
    }

    // Check TTL (relative to creation time)
    if (stream.ttlSeconds !== undefined) {
      if (now >= stream.createdAt + stream.ttlSeconds * 1000) return true
    }

    return false
  }

  /**
   * Get a stream, deleting it if expired.
   * Returns undefined if stream doesn't exist or is expired.
   */
  private getIfNotExpired(path: string): MemoryStream | undefined {
    const stream = this.streams.get(path)
    if (!stream) return undefined
    if (this.isExpired(stream)) {
      // Delete expired stream
      this.deleteInternal(path)
      return undefined
    }
    return stream
  }

  async create(path: string, config: StoreConfig): Promise<boolean> {
    // Use getIfNotExpired to treat expired streams as non-existent
    if (this.getIfNotExpired(path)) return false

    this.streams.set(path, {
      contentType: config.contentType,
      messages: [],
      currentOffset: `0000000000000000_0000000000000000`,
      createdAt: Date.now(),
      ttlSeconds: config.ttlSeconds,
      expiresAt: config.expiresAt,
      closed: false,
    })
    return true
  }

  async head(path: string): Promise<StreamInfo | undefined> {
    const stream = this.getIfNotExpired(path)
    if (!stream) return undefined
    return {
      contentType: stream.contentType,
      currentOffset: stream.currentOffset,
      createdAt: stream.createdAt,
      ttlSeconds: stream.ttlSeconds,
      expiresAt: stream.expiresAt,
      closed: stream.closed,
      lastSeq: stream.lastSeq,
      producers: stream.producers,
      closedBy: stream.closedBy,
    }
  }

  async delete(path: string): Promise<boolean> {
    return this.deleteInternal(path)
  }

  private deleteInternal(path: string): boolean {
    const existed = this.streams.has(path)
    if (existed) {
      // Cancel any pending long-polls for this stream
      this.cancelWaitersForStream(path)
      this.streams.delete(path)
    }
    return existed
  }

  async append(
    path: string,
    data: Uint8Array,
    metadata?: AppendMetadata
  ): Promise<string> {
    const stream = this.getIfNotExpired(path)
    if (!stream) throw new Error(`Stream not found: ${path}`)

    // Parse current offset
    const parts = stream.currentOffset.split(`_`).map(Number)
    const readSeq = parts[0]!
    const byteOffset = parts[1]!

    // Calculate new offset with zero-padding for lexicographic sorting
    const newByteOffset = byteOffset + data.length
    const newOffset = `${String(readSeq).padStart(16, `0`)}_${String(newByteOffset).padStart(16, `0`)}`

    stream.messages.push({ data, offset: newOffset })
    stream.currentOffset = newOffset
    if (metadata?.lastSeq !== undefined) stream.lastSeq = metadata.lastSeq
    if (metadata?.closed !== undefined) stream.closed = metadata.closed
    if (metadata?.producers !== undefined) stream.producers = metadata.producers
    if (metadata?.closedBy !== undefined) stream.closedBy = metadata.closedBy

    // Notify any pending long-polls of new messages
    this.notifyWaiters(path)
    // Notify pending long-polls that stream is closed
    if (metadata?.closed) {
      this.notifyWaitersClosed(path)
    }
    return newOffset
  }

  /**
   * Read messages from a stream starting at the given offset.
   */
  async read(
    path: string,
    offset?: string
  ): Promise<{ messages: Array<StoredMessage>; currentOffset: string }> {
    const stream = this.getIfNotExpired(path)
    if (!stream) throw new Error(`Stream not found: ${path}`)

    // No offset or -1 means start from beginning
    if (!offset || offset === `-1`) {
      return {
        messages: [...stream.messages],
        currentOffset: stream.currentOffset,
      }
    }

    // Find messages after the given offset
    // Uses lexicographic comparison as required by protocol
    const messages: Array<StoredMessage> = []
    for (const msg of stream.messages) {
      if (msg.offset > offset) messages.push(msg)
    }
    return { messages, currentOffset: stream.currentOffset }
  }

  /**
   * Wait for new messages (long-poll).
   */
  async waitForData(
    path: string,
    offset: string,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<{ messages: Array<StoredMessage>; timedOut: boolean }> {
    const stream = this.getIfNotExpired(path)
    if (!stream) throw new Error(`Stream not found: ${path}`)

    // Check if there are already new messages
    const { messages } = await this.read(path, offset)
    if (messages.length > 0) return { messages, timedOut: false }

    // If stream is closed and client is at tail, return immediately
    if (stream.closed && offset === stream.currentOffset) {
      return { messages: [], timedOut: false }
    }

    // Wait for new messages
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        // Remove from pending
        this.removeWaiter(waiter)
        resolve({ messages: [], timedOut: true })
      }, timeoutMs)

      const waiter: PendingWaiter = {
        path,
        offset,
        resolve: (result) => {
          clearTimeout(timeoutId)
          this.removeWaiter(waiter)
          resolve(result)
        },
        timeoutId,
        signal,
      }

      if (signal) {
        const abortHandler = () => {
          clearTimeout(timeoutId)
          this.removeWaiter(waiter)
          resolve({ messages: [], timedOut: true })
        }
        waiter.abortHandler = abortHandler
        signal.addEventListener(`abort`, abortHandler, { once: true })
      }

      this.waiters.push(waiter)
    })
  }

  async update(
    path: string,
    updates: {
      closed?: boolean
      lastSeq?: string
      producers?: Record<string, SerializableProducerState>
      closedBy?: ClosedByInfo
    }
  ): Promise<void> {
    const stream = this.getIfNotExpired(path)
    if (!stream) throw new Error(`Stream not found: ${path}`)

    if (updates.closed !== undefined) stream.closed = updates.closed
    if (updates.lastSeq !== undefined) stream.lastSeq = updates.lastSeq
    if (updates.producers !== undefined) stream.producers = updates.producers
    if (updates.closedBy !== undefined) stream.closedBy = updates.closedBy

    // Notify pending long-polls that stream is closed
    if (updates.closed) {
      this.notifyWaitersClosed(path)
    }
  }

  // Cancel all pending long-polls and resolve them with timeout
  clear(): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timeoutId)
      if (waiter.abortHandler && waiter.signal) {
        waiter.signal.removeEventListener(`abort`, waiter.abortHandler)
      }
      // Resolve with empty result to unblock waiting handlers
      waiter.resolve({ messages: [], timedOut: true })
    }
    this.waiters = []
    this.streams.clear()
  }

  async close(): Promise<void> {
    this.clear()
  }

  private notifyWaiters(path: string): void {
    const toNotify = this.waiters.filter((w) => w.path === path)
    for (const waiter of toNotify) {
      const stream = this.streams.get(path)
      if (!stream) continue
      const messages: Array<StoredMessage> = []
      for (const msg of stream.messages) {
        if (msg.offset > waiter.offset) messages.push(msg)
      }
      if (messages.length > 0) {
        waiter.resolve({ messages, timedOut: false })
      }
    }
  }

  // Notify pending long-polls that a stream has been closed.
  // They should wake up immediately and return Stream-Closed: true.
  private notifyWaitersClosed(path: string): void {
    const toNotify = this.waiters.filter((w) => w.path === path)
    for (const waiter of toNotify) {
      // Resolve with empty messages - the caller will check stream.closed
      waiter.resolve({ messages: [], timedOut: false })
    }
  }

  private cancelWaitersForStream(path: string): void {
    const toCancel = this.waiters.filter((w) => w.path === path)
    for (const waiter of toCancel) {
      clearTimeout(waiter.timeoutId)
      if (waiter.abortHandler && waiter.signal) {
        waiter.signal.removeEventListener(`abort`, waiter.abortHandler)
      }
      waiter.resolve({ messages: [], timedOut: true })
    }
    this.waiters = this.waiters.filter((w) => w.path !== path)
  }

  private removeWaiter(waiter: PendingWaiter): void {
    if (waiter.abortHandler && waiter.signal) {
      waiter.signal.removeEventListener(`abort`, waiter.abortHandler)
    }
    const index = this.waiters.indexOf(waiter)
    if (index !== -1) this.waiters.splice(index, 1)
  }
}
