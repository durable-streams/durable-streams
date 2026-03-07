/**
 * File-backed Store implementation using LMDB for metadata
 * and append-only log files for stream data.
 *
 * No protocol logic — just store, read, wait, and metadata CRUD.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { randomBytes } from "node:crypto"
import { open as openLMDB } from "lmdb"
import { SieveCache } from "@neophi/sieve-cache"
import { StreamFileManager } from "./file-manager"
import { encodeStreamPath } from "./path-encoding"
import type {
  AppendMetadata,
  Store,
  StoreConfig,
  StoredMessage,
  StreamInfo,
} from "./store"
import type { Database } from "lmdb"

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
  /**
   * Unique directory name for this stream instance.
   * Format: {encoded_path}~{timestamp}~{random_hex}
   * This allows safe async deletion and immediate reuse of stream paths.
   */
  directoryName: string
  /**
   * Whether the stream is closed (no further appends permitted).
   * Once set to true, this is permanent and durable.
   */
  closed?: boolean
  /**
   * Producer states for idempotent writes.
   * Stored as a plain object for LMDB serialization.
   */
  producers?: Record<
    string,
    { epoch: number; lastSeq: number; lastUpdated: number }
  >
  /**
   * The producer tuple that closed this stream (for idempotent close).
   * If set, duplicate close requests with this tuple return 204.
   * CRITICAL: Must be persisted for duplicate detection after restart.
   */
  closedBy?: { producerId: string; epoch: number; seq: number }
}

/**
 * File handle pool with SIEVE cache eviction.
 * Automatically closes least-recently-used handles when capacity is reached.
 */
interface PooledHandle {
  stream: fs.WriteStream
}

class FileHandlePool {
  private cache: SieveCache<string, PooledHandle>

  constructor(maxSize: number) {
    this.cache = new SieveCache<string, PooledHandle>(maxSize, {
      evictHook: (_key: string, handle: PooledHandle) => {
        // Close the handle when evicted (sync version - fire and forget)
        this.closeHandle(handle).catch((err: Error) => {
          console.error(`[FileHandlePool] Error closing evicted handle:`, err)
        })
      },
    })
  }

  getWriteStream(filePath: string): fs.WriteStream {
    let handle = this.cache.get(filePath)

    if (!handle) {
      const stream = fs.createWriteStream(filePath, { flags: `a` })
      handle = { stream }
      this.cache.set(filePath, handle)
    }

    return handle.stream
  }

  /**
   * Flush a specific file to disk immediately.
   * This is called after each append to ensure durability.
   */
  async fsyncFile(filePath: string): Promise<void> {
    const handle = this.cache.get(filePath)
    if (!handle) return

    return new Promise<void>((resolve, reject) => {
      // Use fdatasync (faster than fsync, skips metadata)
      // Cast to any to access fd property (exists at runtime but not in types)
      const fd = (handle.stream as any).fd

      // If fd is null, stream hasn't been opened yet - wait for open event
      if (typeof fd !== `number`) {
        const onOpen = (openedFd: number): void => {
          handle.stream.off(`error`, onError)
          fs.fdatasync(openedFd, (err) => {
            if (err) reject(err)
            else resolve()
          })
        }
        const onError = (err: Error): void => {
          handle.stream.off(`open`, onOpen)
          reject(err)
        }
        handle.stream.once(`open`, onOpen)
        handle.stream.once(`error`, onError)
        return
      }

      fs.fdatasync(fd, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  async closeAll(): Promise<void> {
    const promises: Array<Promise<void>> = []
    for (const [_key, handle] of this.cache.entries()) {
      promises.push(this.closeHandle(handle))
    }

    await Promise.all(promises)
    this.cache.clear()
  }

  /**
   * Close a specific file handle if it exists in the cache.
   * Useful for cleanup before deleting files.
   */
  async closeFileHandle(filePath: string): Promise<void> {
    const handle = this.cache.get(filePath)
    if (handle) {
      await this.closeHandle(handle)
      this.cache.delete(filePath)
    }
  }

  private async closeHandle(handle: PooledHandle): Promise<void> {
    // Close the stream (data is already fsynced on each append)
    return new Promise<void>((resolve) => {
      handle.stream.end(() => resolve())
    })
  }
}

export interface FileStoreOptions {
  dataDir: string
  maxFileHandles?: number
}

/**
 * Generate a unique directory name for a stream.
 * Format: {encoded_path}~{timestamp}~{random_hex}
 * This allows safe async deletion and immediate reuse of stream paths.
 */
function generateUniqueDirectoryName(streamPath: string): string {
  const encoded = encodeStreamPath(streamPath)
  const timestamp = Date.now().toString(36) // Base36 for shorter strings
  const random = randomBytes(4).toString(`hex`) // 8 chars hex
  return `${encoded}~${timestamp}~${random}`
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

export class FileStore implements Store {
  private db: Database
  private fileManager: StreamFileManager
  private fileHandlePool: FileHandlePool
  private dataDir: string
  private waiters: Array<PendingWaiter> = []

  constructor(options: FileStoreOptions) {
    this.dataDir = options.dataDir

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

    // Recover from disk
    this.recover()
  }

  /**
   * Recover streams from disk on startup.
   * Validates that LMDB metadata matches actual file contents and reconciles any mismatches.
   */
  private recover(): void {
    console.log(`[FileStore] Starting recovery...`)

    let recovered = 0
    let reconciled = 0
    let errors = 0

    // Scan LMDB for all streams
    const range = this.db.getRange({
      start: `stream:`,
      end: `stream:\xFF`,
    })

    // Convert to array to avoid iterator issues
    const entries = Array.from(range)

    for (const { key, value } of entries) {
      try {
        // Key should be a string in our schema
        if (typeof key !== `string`) continue

        const streamMeta = value as StreamMetadata

        // Get segment file path
        const segmentPath = path.join(
          this.dataDir,
          `streams`,
          streamMeta.directoryName,
          `segment_00000.log`
        )

        // Check if file exists
        if (!fs.existsSync(segmentPath)) {
          console.warn(
            `[FileStore] Recovery: Stream file missing for ${key.replace(`stream:`, ``)}, removing from LMDB`
          )
          this.db.removeSync(key)
          errors++
          continue
        }

        // Scan file to compute true offset
        const trueOffset = this.scanFileForTrueOffset(segmentPath)

        // Check if offset matches
        if (trueOffset !== streamMeta.currentOffset) {
          console.warn(
            `[FileStore] Recovery: Offset mismatch for ${key.replace(`stream:`, ``)}: ` +
              `LMDB says ${streamMeta.currentOffset}, file says ${trueOffset}. Reconciling to file.`
          )

          // Update LMDB to match file (source of truth)
          const fileStats = fs.statSync(segmentPath)
          const reconciledMeta: StreamMetadata = {
            ...streamMeta,
            currentOffset: trueOffset,
            totalBytes: fileStats.size,
          }
          this.db.putSync(key, reconciledMeta)
          reconciled++
        }

        recovered++
      } catch (err) {
        console.error(`[FileStore] Error recovering stream:`, err)
        errors++
      }
    }

    console.log(
      `[FileStore] Recovery complete: ${recovered} streams, ` +
        `${reconciled} reconciled, ${errors} errors`
    )
  }

  /**
   * Scan a segment file to compute the true last offset.
   * Handles partial/truncated messages at the end.
   */
  private scanFileForTrueOffset(segmentPath: string): string {
    try {
      const fileContent = fs.readFileSync(segmentPath)
      let filePos = 0
      let currentDataOffset = 0

      while (filePos < fileContent.length) {
        // Read message length (4 bytes)
        if (filePos + 4 > fileContent.length) {
          // Truncated length header - stop here
          break
        }

        const messageLength = fileContent.readUInt32BE(filePos)
        filePos += 4

        // Check if we have the full message
        if (filePos + messageLength > fileContent.length) {
          // Truncated message data - stop here
          break
        }

        filePos += messageLength

        // Skip newline
        if (filePos < fileContent.length) {
          filePos += 1
        }

        // Update offset with this complete message
        currentDataOffset += messageLength
      }

      // Return offset in format "readSeq_byteOffset" with zero-padding
      return `0000000000000000_${String(currentDataOffset).padStart(16, `0`)}`
    } catch (err) {
      console.error(`[FileStore] Error scanning file ${segmentPath}:`, err)
      // Return empty offset on error
      return `0000000000000000_0000000000000000`
    }
  }

  private isExpired(meta: StreamMetadata): boolean {
    const now = Date.now()
    // Check absolute expiry time
    if (meta.expiresAt) {
      const expiryTime = new Date(meta.expiresAt).getTime()
      // Treat invalid dates (NaN) as expired (fail closed)
      if (!Number.isFinite(expiryTime) || now >= expiryTime) return true
    }
    // Check TTL (relative to creation time)
    if (meta.ttlSeconds !== undefined) {
      if (now >= meta.createdAt + meta.ttlSeconds * 1000) return true
    }
    return false
  }

  /**
   * Get stream metadata, deleting it if expired.
   * Returns undefined if stream doesn't exist or is expired.
   */
  private getMetaIfNotExpired(streamPath: string): StreamMetadata | undefined {
    const key = `stream:${streamPath}`
    const meta = this.db.get(key) as StreamMetadata | undefined
    if (!meta) return undefined
    if (this.isExpired(meta)) {
      // Delete expired stream
      this.deleteInternal(streamPath)
      return undefined
    }
    return meta
  }

  async create(streamPath: string, config: StoreConfig): Promise<boolean> {
    if (this.getMetaIfNotExpired(streamPath)) return false

    // Define key for LMDB operations
    const key = `stream:${streamPath}`

    const streamMeta: StreamMetadata = {
      path: streamPath,
      contentType: config.contentType,
      currentOffset: `0000000000000000_0000000000000000`,
      ttlSeconds: config.ttlSeconds,
      expiresAt: config.expiresAt,
      createdAt: Date.now(),
      segmentCount: 1,
      totalBytes: 0,
      directoryName: generateUniqueDirectoryName(streamPath),
      closed: false,
    }

    // Create stream directory and empty segment file immediately
    // This ensures the stream is fully initialized and can be recovered
    const streamDir = path.join(
      this.dataDir,
      `streams`,
      streamMeta.directoryName
    )
    try {
      fs.mkdirSync(streamDir, { recursive: true })
      const segmentPath = path.join(streamDir, `segment_00000.log`)
      fs.writeFileSync(segmentPath, ``)
    } catch (err) {
      console.error(`[FileStore] Error creating stream directory:`, err)
      throw err
    }

    // Save to LMDB
    this.db.putSync(key, streamMeta)
    return true
  }

  async head(streamPath: string): Promise<StreamInfo | undefined> {
    const meta = this.getMetaIfNotExpired(streamPath)
    if (!meta) return undefined
    return {
      contentType: meta.contentType,
      currentOffset: meta.currentOffset,
      createdAt: meta.createdAt,
      ttlSeconds: meta.ttlSeconds,
      expiresAt: meta.expiresAt,
      closed: meta.closed ?? false,
      lastSeq: meta.lastSeq,
      producers: meta.producers,
      closedBy: meta.closedBy,
    }
  }

  async delete(streamPath: string): Promise<boolean> {
    return this.deleteInternal(streamPath)
  }

  private deleteInternal(streamPath: string): boolean {
    const key = `stream:${streamPath}`
    const streamMeta = this.db.get(key) as StreamMetadata | undefined

    if (!streamMeta) return false

    // Cancel any pending long-polls for this stream
    this.cancelWaitersForStream(streamPath)

    // Close any open file handle for this stream's segment file
    // This is important especially on Windows where open handles block deletion
    const segmentPath = path.join(
      this.dataDir,
      `streams`,
      streamMeta.directoryName,
      `segment_00000.log`
    )
    this.fileHandlePool.closeFileHandle(segmentPath).catch((err: Error) => {
      console.error(`[FileStore] Error closing file handle:`, err)
    })

    // Delete from LMDB
    this.db.removeSync(key)

    // Delete files using unique directory name (async, but don't wait)
    // Safe to reuse stream path immediately since new creation gets new directory
    this.fileManager
      .deleteDirectoryByName(streamMeta.directoryName)
      .catch((err: Error) => {
        console.error(`[FileStore] Error deleting stream directory:`, err)
      })

    return true
  }

  async append(
    streamPath: string,
    data: Uint8Array,
    metadata?: AppendMetadata
  ): Promise<string> {
    const streamMeta = this.getMetaIfNotExpired(streamPath)
    if (!streamMeta) throw new Error(`Stream not found: ${streamPath}`)

    // Parse current offset
    const parts = streamMeta.currentOffset.split(`_`).map(Number)
    const readSeq = parts[0]!
    const byteOffset = parts[1]!

    // Calculate new offset with zero-padding for lexicographic sorting (only data bytes, not framing)
    const newByteOffset = byteOffset + data.length
    const newOffset = `${String(readSeq).padStart(16, `0`)}_${String(newByteOffset).padStart(16, `0`)}`

    // Get segment file path (directory was created in create())
    const streamDir = path.join(
      this.dataDir,
      `streams`,
      streamMeta.directoryName
    )
    const segmentPath = path.join(streamDir, `segment_00000.log`)

    // Get write stream from pool
    const stream = this.fileHandlePool.getWriteStream(segmentPath)

    // 1. Write message with framing: [4 bytes length][data][\n]
    //    Combine into single buffer for single syscall, and wait for write
    //    to be flushed to kernel before calling fsync
    const lengthBuf = Buffer.allocUnsafe(4)
    lengthBuf.writeUInt32BE(data.length, 0)
    const frameBuf = Buffer.concat([lengthBuf, data, Buffer.from(`\n`)])
    await new Promise<void>((resolve, reject) => {
      stream.write(frameBuf, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })

    // 2. Flush to disk (blocks here until durable)
    await this.fileHandlePool.fsyncFile(segmentPath)

    // 3. Update LMDB metadata atomically (only after flush, so metadata reflects durability)
    const key = `stream:${streamPath}`
    const updatedMeta: StreamMetadata = {
      ...streamMeta,
      currentOffset: newOffset,
      totalBytes: streamMeta.totalBytes + data.length + 5, // +4 for length, +1 for newline
    }
    if (metadata?.lastSeq !== undefined) updatedMeta.lastSeq = metadata.lastSeq
    if (metadata?.closed !== undefined) updatedMeta.closed = metadata.closed
    if (metadata?.producers !== undefined)
      updatedMeta.producers = metadata.producers
    if (metadata?.closedBy !== undefined)
      updatedMeta.closedBy = metadata.closedBy
    this.db.putSync(key, updatedMeta)

    // 4. Notify long-polls (data is now readable from disk)
    this.notifyWaiters(streamPath)
    // 4a. If stream was closed, also notify long-polls of closure
    if (metadata?.closed) {
      this.notifyWaitersClosed(streamPath)
    }

    return newOffset
  }

  async read(
    streamPath: string,
    offset?: string
  ): Promise<{ messages: Array<StoredMessage>; currentOffset: string }> {
    const streamMeta = this.getMetaIfNotExpired(streamPath)
    if (!streamMeta) throw new Error(`Stream not found: ${streamPath}`)

    // Parse offsets
    const startOffset = offset ?? `0000000000000000_0000000000000000`
    const startParts = startOffset.split(`_`).map(Number)
    const startByte = startParts[1] ?? 0
    const currentParts = streamMeta.currentOffset.split(`_`).map(Number)
    const currentSeq = currentParts[0] ?? 0
    const currentByte = currentParts[1] ?? 0

    // Early return if no data available
    if (streamMeta.currentOffset === `0000000000000000_0000000000000000`) {
      return { messages: [], currentOffset: streamMeta.currentOffset }
    }

    // If start offset is at or past current offset, return empty
    if (startByte >= currentByte) {
      return { messages: [], currentOffset: streamMeta.currentOffset }
    }

    // Get segment file path using unique directory name
    const streamDir = path.join(
      this.dataDir,
      `streams`,
      streamMeta.directoryName
    )
    const segmentPath = path.join(streamDir, `segment_00000.log`)

    // Check if file exists
    if (!fs.existsSync(segmentPath)) {
      return { messages: [], currentOffset: streamMeta.currentOffset }
    }

    // Read and parse messages from file
    const messages: Array<StoredMessage> = []

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
            offset: `${String(currentSeq).padStart(16, `0`)}_${String(messageOffset).padStart(16, `0`)}`,
          })
        }

        currentDataOffset = messageOffset
      }
    } catch (err) {
      console.error(`[FileStore] Error reading file:`, err)
    }

    return { messages, currentOffset: streamMeta.currentOffset }
  }

  async waitForData(
    streamPath: string,
    offset: string,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<{ messages: Array<StoredMessage>; timedOut: boolean }> {
    const streamMeta = this.getMetaIfNotExpired(streamPath)
    if (!streamMeta) throw new Error(`Stream not found: ${streamPath}`)

    const { messages } = await this.read(streamPath, offset)
    if (messages.length > 0) return { messages, timedOut: false }

    // If stream is closed and client is at tail, return immediately
    if (streamMeta.closed && offset === streamMeta.currentOffset) {
      return { messages: [], timedOut: false }
    }

    // Wait for new messages
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        this.removeWaiter(waiter)
        resolve({ messages: [], timedOut: true })
      }, timeoutMs)

      const waiter: PendingWaiter = {
        path: streamPath,
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
    streamPath: string,
    updates: {
      closed?: boolean
      lastSeq?: string
      producers?: Record<
        string,
        { epoch: number; lastSeq: number; lastUpdated: number }
      >
      closedBy?: { producerId: string; epoch: number; seq: number }
    }
  ): Promise<void> {
    const key = `stream:${streamPath}`
    const meta = this.db.get(key) as StreamMetadata | undefined
    if (!meta) throw new Error(`Stream not found: ${streamPath}`)

    const updatedMeta: StreamMetadata = { ...meta }
    if (updates.closed !== undefined) updatedMeta.closed = updates.closed
    if (updates.lastSeq !== undefined) updatedMeta.lastSeq = updates.lastSeq
    if (updates.producers !== undefined)
      updatedMeta.producers = updates.producers
    if (updates.closedBy !== undefined) updatedMeta.closedBy = updates.closedBy

    this.db.putSync(key, updatedMeta)

    if (updates.closed) {
      this.notifyWaitersClosed(streamPath)
    }
  }

  clear(): void {
    // Cancel all pending long-polls and resolve them with empty result
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timeoutId)
      if (waiter.abortHandler && waiter.signal) {
        waiter.signal.removeEventListener(`abort`, waiter.abortHandler)
      }
      // Resolve with empty result to unblock waiting handlers
      waiter.resolve({ messages: [], timedOut: true })
    }
    this.waiters = []

    // Clear all streams from LMDB
    const range = this.db.getRange({ start: `stream:`, end: `stream:\xFF` })
    // Convert to array to avoid iterator issues
    const entries = Array.from(range)
    for (const { key } of entries) {
      this.db.removeSync(key as string)
    }

    // Clear file handle pool
    this.fileHandlePool.closeAll().catch((err: Error) => {
      console.error(`[FileStore] Error closing handles during clear:`, err)
    })

    // Note: Files are not deleted in clear() with unique directory names
    // New streams get fresh directories, so old files won't interfere
  }

  /**
   * Close the store, closing all file handles and database.
   * All data is already fsynced on each append, so no final flush needed.
   */
  async close(): Promise<void> {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timeoutId)
      if (waiter.abortHandler && waiter.signal) {
        waiter.signal.removeEventListener(`abort`, waiter.abortHandler)
      }
      waiter.resolve({ messages: [], timedOut: true })
    }
    this.waiters = []

    await this.fileHandlePool.closeAll()
    await this.db.close()
  }

  private notifyWaiters(streamPath: string): void {
    const toNotify = this.waiters.filter((w) => w.path === streamPath)
    for (const waiter of toNotify) {
      this.read(streamPath, waiter.offset)
        .then(({ messages }) => {
          if (messages.length > 0) {
            waiter.resolve({ messages, timedOut: false })
          }
        })
        .catch(() => {})
    }
  }

  private notifyWaitersClosed(streamPath: string): void {
    const toNotify = this.waiters.filter((w) => w.path === streamPath)
    for (const waiter of toNotify) {
      // Resolve with empty messages - the caller will check stream.closed
      waiter.resolve({ messages: [], timedOut: false })
    }
  }

  private cancelWaitersForStream(streamPath: string): void {
    const toCancel = this.waiters.filter((w) => w.path === streamPath)
    for (const waiter of toCancel) {
      clearTimeout(waiter.timeoutId)
      if (waiter.abortHandler && waiter.signal) {
        waiter.signal.removeEventListener(`abort`, waiter.abortHandler)
      }
      waiter.resolve({ messages: [], timedOut: true })
    }
    this.waiters = this.waiters.filter((w) => w.path !== streamPath)
  }

  private removeWaiter(waiter: PendingWaiter): void {
    if (waiter.abortHandler && waiter.signal) {
      waiter.signal.removeEventListener(`abort`, waiter.abortHandler)
    }
    const index = this.waiters.indexOf(waiter)
    if (index !== -1) this.waiters.splice(index, 1)
  }
}
