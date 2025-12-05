/**
 * File-backed stream storage implementation using LMDB for metadata
 * and append-only log files for stream data.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { open as openLMDB } from "lmdb"
import { SieveCache } from "@neophi/sieve-cache"
import { StreamFileManager } from "./file-manager"
import { encodeStreamPath } from "./path-encoding"
import type { Database } from "lmdb"
import type { PendingLongPoll, Stream, StreamMessage } from "./types"

/**
 * Stream metadata stored in LMDB.
 */
interface StreamMetadata {
  path: string
  contentType?: string
  currentOffset: string
  lastSeq?: string
  ttlSeconds?: number
  expiresAt?: string
  createdAt: number
  segmentCount: number
  totalBytes: number
}

/**
 * File handle pool with SIEVE cache eviction.
 * Automatically closes least-recently-used handles when capacity is reached.
 */
interface PooledHandle {
  stream: fs.WriteStream
  dirty: boolean
}

class FileHandlePool {
  private cache: SieveCache<string, PooledHandle>
  private dirty = new Set<string>()

  constructor(maxSize: number) {
    this.cache = new SieveCache<string, PooledHandle>(maxSize, {
      evictHook: (key: string, handle: PooledHandle) => {
        // Close the handle when evicted (sync version - fire and forget)
        this.closeHandle(key, handle).catch((err: Error) => {
          console.error(`[FileHandlePool] Error closing evicted handle:`, err)
        })
      },
    })
  }

  getWriteStream(filePath: string): fs.WriteStream {
    let handle = this.cache.get(filePath)

    if (!handle) {
      const stream = fs.createWriteStream(filePath, { flags: `a` })
      handle = { stream, dirty: false }
      this.cache.set(filePath, handle)
    }

    return handle.stream
  }

  markDirty(filePath: string): void {
    const handle = this.cache.get(filePath)
    if (handle) {
      handle.dirty = true
      this.dirty.add(filePath)
    }
  }

  async fsyncDirty(): Promise<void> {
    const promises = Array.from(this.dirty).map((filePath) => {
      const handle = this.cache.get(filePath)
      if (!handle) return Promise.resolve()

      return new Promise<void>((resolve, reject) => {
        // Use fdatasync (faster than fsync, skips metadata)
        // Cast to any to access fd property (exists at runtime but not in types)
        const fd = (handle.stream as any).fd as number
        fs.fdatasync(fd, (err) => {
          if (err) reject(err)
          else {
            handle.dirty = false
            this.dirty.delete(filePath)
            resolve()
          }
        })
      })
    })

    await Promise.all(promises)
  }

  async closeAll(): Promise<void> {
    await this.fsyncDirty()

    const promises: Array<Promise<void>> = []
    for (const [key, handle] of this.cache.entries()) {
      promises.push(this.closeHandle(key, handle))
    }

    await Promise.all(promises)
    this.cache.clear()
  }

  private async closeHandle(
    filePath: string,
    handle: PooledHandle
  ): Promise<void> {
    // Fsync if dirty before closing
    if (handle.dirty) {
      await new Promise<void>((resolve, reject) => {
        const fd = (handle.stream as any).fd as number
        fs.fdatasync(fd, (err) => {
          if (err) reject(err)
          else {
            this.dirty.delete(filePath)
            resolve()
          }
        })
      })
    }

    // Close the stream
    return new Promise<void>((resolve) => {
      handle.stream.end(() => resolve())
    })
  }
}

export interface FileBackedStreamStoreOptions {
  dataDir: string
  fsyncIntervalMs?: number
  maxFileHandles?: number
}

/**
 * File-backed implementation of StreamStore.
 * Maintains the same interface as the in-memory StreamStore for drop-in compatibility.
 */
export class FileBackedStreamStore {
  private db: Database
  private fileManager: StreamFileManager
  private fileHandlePool: FileHandlePool
  private pendingLongPolls: Array<PendingLongPoll> = []
  private fsyncTimer: NodeJS.Timeout | null = null
  private fsyncIntervalMs: number
  private dataDir: string

  constructor(options: FileBackedStreamStoreOptions) {
    this.dataDir = options.dataDir
    this.fsyncIntervalMs = options.fsyncIntervalMs ?? 1000

    // Initialize LMDB
    this.db = openLMDB({
      path: path.join(this.dataDir, `metadata.lmdb`),
      compression: true,
    })

    // Initialize file manager
    this.fileManager = new StreamFileManager(path.join(this.dataDir, `streams`))

    // Initialize file handle pool with SIEVE cache
    const maxFileHandles = options.maxFileHandles ?? 100
    this.fileHandlePool = new FileHandlePool(maxFileHandles)

    // Start periodic fsync
    this.startFsyncTimer()

    // Recover from disk
    this.recover()
  }

  /**
   * Start periodic fsync timer.
   */
  private startFsyncTimer(): void {
    this.fsyncTimer = setInterval(() => {
      this.fileHandlePool.fsyncDirty().catch((err: Error) => {
        console.error(`[FileBackedStreamStore] Fsync error:`, err)
      })
    }, this.fsyncIntervalMs)
  }

  /**
   * Recover streams from disk on startup.
   */
  private recover(): void {
    console.log(`[FileBackedStreamStore] Starting recovery...`)

    let recovered = 0
    let errors = 0

    // Scan LMDB for all streams
    const range = this.db.getRange({
      start: `stream:`,
      end: `stream:\xFF`,
    })

    // Convert to array to avoid iterator issues
    const entries = Array.from(range)

    for (const { key } of entries) {
      try {
        // Key should be a string in our schema
        if (typeof key !== `string`) continue

        recovered++
      } catch (err) {
        console.error(`[FileBackedStreamStore] Error recovering stream:`, err)
        errors++
      }
    }

    console.log(
      `[FileBackedStreamStore] Recovery complete: ${recovered} streams, ${errors} errors`
    )
  }

  /**
   * Convert LMDB metadata to Stream object.
   */
  private streamMetaToStream(meta: StreamMetadata): Stream {
    return {
      path: meta.path,
      contentType: meta.contentType,
      messages: [], // Messages not stored in memory
      currentOffset: meta.currentOffset,
      lastSeq: meta.lastSeq,
      ttlSeconds: meta.ttlSeconds,
      expiresAt: meta.expiresAt,
      createdAt: meta.createdAt,
    }
  }

  /**
   * Close the store, flushing all data and closing resources.
   */
  async close(): Promise<void> {
    if (this.fsyncTimer) {
      clearInterval(this.fsyncTimer)
      this.fsyncTimer = null
    }

    await this.fileHandlePool.fsyncDirty()
    await this.fileHandlePool.closeAll()
    await this.db.close()
  }

  // ============================================================================
  // StreamStore interface methods (to be implemented)
  // ============================================================================

  create(
    streamPath: string,
    options: {
      contentType?: string
      ttlSeconds?: number
      expiresAt?: string
      initialData?: Uint8Array
    } = {}
  ): Stream {
    const key = `stream:${streamPath}`
    const existing = this.db.get(key) as StreamMetadata | undefined

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
        return this.streamMetaToStream(existing)
      } else {
        // Config mismatch - conflict
        throw new Error(
          `Stream already exists with different configuration: ${streamPath}`
        )
      }
    }

    // Initialize metadata (directory created lazily on first append)
    const streamMeta: StreamMetadata = {
      path: streamPath,
      contentType: options.contentType,
      currentOffset: `0_0`,
      lastSeq: undefined,
      ttlSeconds: options.ttlSeconds,
      expiresAt: options.expiresAt,
      createdAt: Date.now(),
      segmentCount: 1,
      totalBytes: 0,
    }

    // Save to LMDB
    this.db.put(key, streamMeta)

    // Append initial data if provided
    if (options.initialData && options.initialData.length > 0) {
      this.append(streamPath, options.initialData)
      // Re-fetch updated metadata
      const updated = this.db.get(key) as StreamMetadata
      return this.streamMetaToStream(updated)
    }

    return this.streamMetaToStream(streamMeta)
  }

  get(streamPath: string): Stream | undefined {
    const key = `stream:${streamPath}`
    const meta = this.db.get(key) as StreamMetadata | undefined
    return meta ? this.streamMetaToStream(meta) : undefined
  }

  has(streamPath: string): boolean {
    const key = `stream:${streamPath}`
    return this.db.get(key) !== undefined
  }

  delete(streamPath: string): boolean {
    const key = `stream:${streamPath}`
    const exists = this.db.get(key) !== undefined

    if (!exists) {
      return false
    }

    // Cancel any pending long-polls for this stream
    this.cancelLongPollsForStream(streamPath)

    // Delete from LMDB
    this.db.remove(key)

    // Delete files (async, but don't wait)
    this.fileManager.deleteStreamDirectory(streamPath).catch((err) => {
      console.error(
        `[FileBackedStreamStore] Error deleting stream directory:`,
        err
      )
    })

    return true
  }

  append(
    streamPath: string,
    data: Uint8Array,
    options: { seq?: string; contentType?: string } = {}
  ): StreamMessage {
    const key = `stream:${streamPath}`
    const streamMeta = this.db.get(key) as StreamMetadata | undefined

    if (!streamMeta) {
      throw new Error(`Stream not found: ${streamPath}`)
    }

    // Check content type match (case-insensitive per RFC 2045)
    if (
      options.contentType &&
      streamMeta.contentType &&
      options.contentType.toLowerCase() !== streamMeta.contentType.toLowerCase()
    ) {
      throw new Error(
        `Content-type mismatch: expected ${streamMeta.contentType}, got ${options.contentType}`
      )
    }

    // Check sequence for writer coordination
    if (options.seq !== undefined) {
      if (
        streamMeta.lastSeq !== undefined &&
        options.seq <= streamMeta.lastSeq
      ) {
        throw new Error(
          `Sequence conflict: ${options.seq} <= ${streamMeta.lastSeq}`
        )
      }
    }

    // Parse current offset
    const parts = streamMeta.currentOffset.split(`_`).map(Number)
    const readSeq = parts[0]!
    const byteOffset = parts[1]!

    // Calculate new offset (only data bytes, not framing)
    const newByteOffset = byteOffset + data.length
    const newOffset = `${readSeq}_${newByteOffset}`

    // Ensure stream directory exists (lazy creation)
    const streamDir = path.join(
      this.dataDir,
      `streams`,
      encodeStreamPath(streamPath)
    )

    // Create directory synchronously if it doesn't exist
    try {
      fs.mkdirSync(streamDir, { recursive: true })
      const segmentPath = path.join(streamDir, `segment_00000.log`)
      if (!fs.existsSync(segmentPath)) {
        fs.writeFileSync(segmentPath, ``)
      }
    } catch {
      // Directory might already exist, that's OK
    }

    // Get segment file path
    const segmentPath = path.join(streamDir, `segment_00000.log`)

    // Get write stream from pool
    const stream = this.fileHandlePool.getWriteStream(segmentPath)

    // Write message with framing: [4 bytes length][data][\n]
    const lengthBuf = Buffer.allocUnsafe(4)
    lengthBuf.writeUInt32BE(data.length, 0)
    stream.write(lengthBuf)
    stream.write(data)
    stream.write(`\n`)

    // Mark as dirty (needs fsync)
    this.fileHandlePool.markDirty(segmentPath)

    // Update LMDB metadata
    const updatedMeta: StreamMetadata = {
      ...streamMeta,
      currentOffset: newOffset,
      lastSeq: options.seq ?? streamMeta.lastSeq,
      totalBytes: streamMeta.totalBytes + data.length + 5, // +4 for length, +1 for newline
    }
    this.db.put(key, updatedMeta)

    // Create message
    const message: StreamMessage = {
      data,
      offset: newOffset,
      timestamp: Date.now(),
    }

    // Notify long-polls
    this.notifyLongPolls(streamPath)

    return message
  }

  read(
    streamPath: string,
    offset?: string
  ): { messages: Array<StreamMessage>; upToDate: boolean } {
    const key = `stream:${streamPath}`
    const streamMeta = this.db.get(key) as StreamMetadata | undefined

    if (!streamMeta) {
      throw new Error(`Stream not found: ${streamPath}`)
    }

    // Early return for empty stream
    if (streamMeta.currentOffset === `0_0`) {
      return { messages: [], upToDate: true }
    }

    // Parse offsets
    const startOffset = offset ?? `0_0`
    const startParts = startOffset.split(`_`).map(Number)
    const startByte = startParts[1] ?? 0
    const currentParts = streamMeta.currentOffset.split(`_`).map(Number)
    const currentSeq = currentParts[0] ?? 0
    const currentByte = currentParts[1] ?? 0

    // If start offset is at or past current offset, return empty
    if (startByte >= currentByte) {
      return { messages: [], upToDate: true }
    }

    // Get segment file path
    const streamDir = path.join(
      this.dataDir,
      `streams`,
      encodeStreamPath(streamPath)
    )
    const segmentPath = path.join(streamDir, `segment_00000.log`)

    // Check if file exists
    if (!fs.existsSync(segmentPath)) {
      return { messages: [], upToDate: true }
    }

    // Read and parse messages from file
    const messages: Array<StreamMessage> = []

    try {
      // Calculate file position from offset
      // We need to read from the beginning and skip to the right position
      // because the file has framing overhead
      const fileContent = fs.readFileSync(segmentPath)
      let filePos = 0
      let currentDataOffset = 0

      while (filePos < fileContent.length) {
        // Read message length (4 bytes)
        if (filePos + 4 > fileContent.length) break

        const messageLength = fileContent.readUInt32BE(filePos)
        filePos += 4

        // Read message data
        if (filePos + messageLength > fileContent.length) break

        const messageData = fileContent.subarray(
          filePos,
          filePos + messageLength
        )
        filePos += messageLength

        // Skip newline
        filePos += 1

        // Calculate this message's offset (end position)
        const messageOffset = currentDataOffset + messageLength

        // Only include messages after start offset
        if (messageOffset > startByte) {
          messages.push({
            data: new Uint8Array(messageData),
            offset: `${currentSeq}_${messageOffset}`,
            timestamp: 0, // Not stored in MVP
          })
        }

        currentDataOffset = messageOffset
      }
    } catch (err) {
      console.error(`[FileBackedStreamStore] Error reading file:`, err)
      // Return empty messages on error
      return { messages: [], upToDate: true }
    }

    return { messages, upToDate: true }
  }

  async waitForMessages(
    streamPath: string,
    offset: string,
    timeoutMs: number
  ): Promise<{ messages: Array<StreamMessage>; timedOut: boolean }> {
    const key = `stream:${streamPath}`
    const streamMeta = this.db.get(key) as StreamMetadata | undefined

    if (!streamMeta) {
      throw new Error(`Stream not found: ${streamPath}`)
    }

    // Check if there are already new messages
    const { messages } = this.read(streamPath, offset)
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
        path: streamPath,
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

  getCurrentOffset(streamPath: string): string | undefined {
    const key = `stream:${streamPath}`
    const streamMeta = this.db.get(key) as StreamMetadata | undefined
    return streamMeta?.currentOffset
  }

  clear(): void {
    // Cancel all pending long-polls
    for (const pending of this.pendingLongPolls) {
      clearTimeout(pending.timeoutId)
    }
    this.pendingLongPolls = []

    // Clear all streams from LMDB
    const range = this.db.getRange({
      start: `stream:`,
      end: `stream:\xFF`,
    })

    // Convert to array to avoid iterator issues
    const entries = Array.from(range)

    for (const { key } of entries) {
      this.db.remove(key)
    }

    // Clear file handle pool
    this.fileHandlePool.closeAll().catch((err: Error) => {
      console.error(`[FileBackedStreamStore] Error closing handles:`, err)
    })

    // Note: Files are not deleted in clear() to match in-memory behavior
    // Use delete() for individual streams to remove files
  }

  list(): Array<string> {
    const paths: Array<string> = []

    const range = this.db.getRange({
      start: `stream:`,
      end: `stream:\xFF`,
    })

    // Convert to array to avoid iterator issues
    const entries = Array.from(range)

    for (const { key } of entries) {
      // Key should be a string in our schema
      if (typeof key === `string`) {
        paths.push(key.replace(`stream:`, ``))
      }
    }

    return paths
  }

  // ============================================================================
  // Private helper methods for long-poll support
  // ============================================================================

  private notifyLongPolls(streamPath: string): void {
    const toNotify = this.pendingLongPolls.filter((p) => p.path === streamPath)

    for (const pending of toNotify) {
      const { messages } = this.read(streamPath, pending.offset)
      if (messages.length > 0) {
        pending.resolve(messages)
      }
    }
  }

  private cancelLongPollsForStream(streamPath: string): void {
    const toCancel = this.pendingLongPolls.filter((p) => p.path === streamPath)
    for (const pending of toCancel) {
      clearTimeout(pending.timeoutId)
      pending.resolve([])
    }
    this.pendingLongPolls = this.pendingLongPolls.filter(
      (p) => p.path !== streamPath
    )
  }

  private removePendingLongPoll(pending: PendingLongPoll): void {
    const index = this.pendingLongPolls.indexOf(pending)
    if (index !== -1) {
      this.pendingLongPolls.splice(index, 1)
    }
  }
}
