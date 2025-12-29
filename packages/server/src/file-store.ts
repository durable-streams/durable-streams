/**
 * File-backed stream storage implementation using LMDB for metadata
 * and append-only log files for stream data.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { randomBytes } from "node:crypto"
import { open as openLMDB } from "lmdb"
import { SieveCache } from "@neophi/sieve-cache"
import {
  ContentTypeMismatchError,
  SequenceConflictError,
  StreamAlreadyExistsError,
  StreamNotFoundError,
} from "./errors"
import { StreamFileManager } from "./file-manager"
import { encodeStreamPath } from "./path-encoding"
import { normalizeContentType, processJsonAppend } from "./store"
import type { Database } from "lmdb"
import type { Stream, StreamMessage } from "./types"
import type {
  AppendOptions,
  CreateStreamOptions,
  ReadResult,
  StreamStorage,
} from "./storage"

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

export interface FileBackedStreamStoreOptions {
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

/**
 * File-backed implementation of StreamStorage.
 * Maintains the same interface as the in-memory StreamStore for drop-in compatibility.
 * Uses append-only log files for stream data and LMDB for metadata.
 */
export class FileBackedStreamStore implements StreamStorage {
  private db: Database
  private fileManager: StreamFileManager
  private fileHandlePool: FileHandlePool
  private dataDir: string

  constructor(options: FileBackedStreamStoreOptions) {
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
    console.log(`[FileBackedStreamStore] Starting recovery...`)

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
        const streamPath = key.replace(`stream:`, ``)

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
            `[FileBackedStreamStore] Recovery: Stream file missing for ${streamPath}, removing from LMDB`
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
            `[FileBackedStreamStore] Recovery: Offset mismatch for ${streamPath}: ` +
              `LMDB says ${streamMeta.currentOffset}, file says ${trueOffset}. Reconciling to file.`
          )

          // Update LMDB to match file (source of truth)
          const reconciledMeta: StreamMetadata = {
            ...streamMeta,
            currentOffset: trueOffset,
          }
          this.db.putSync(key, reconciledMeta)
          reconciled++
        }

        recovered++
      } catch (err) {
        console.error(`[FileBackedStreamStore] Error recovering stream:`, err)
        errors++
      }
    }

    console.log(
      `[FileBackedStreamStore] Recovery complete: ${recovered} streams, ` +
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
      console.error(
        `[FileBackedStreamStore] Error scanning file ${segmentPath}:`,
        err
      )
      // Return empty offset on error
      return `0000000000000000_0000000000000000`
    }
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
   * Check if a stream is expired based on TTL or Expires-At.
   */
  private isExpired(meta: StreamMetadata): boolean {
    const now = Date.now()

    // Check absolute expiry time
    if (meta.expiresAt) {
      const expiryTime = new Date(meta.expiresAt).getTime()
      // Treat invalid dates (NaN) as expired (fail closed)
      if (!Number.isFinite(expiryTime) || now >= expiryTime) {
        return true
      }
    }

    // Check TTL (relative to creation time)
    if (meta.ttlSeconds !== undefined) {
      const expiryTime = meta.createdAt + meta.ttlSeconds * 1000
      if (now >= expiryTime) {
        return true
      }
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
    if (!meta) {
      return undefined
    }
    if (this.isExpired(meta)) {
      // Delete expired stream
      this.delete(streamPath)
      return undefined
    }
    return meta
  }

  /**
   * Close the store, closing all file handles and database.
   * All data is already fsynced on each append, so no final flush needed.
   */
  async close(): Promise<void> {
    await this.fileHandlePool.closeAll()
    await this.db.close()
  }

  // ============================================================================
  // StreamStore interface methods (to be implemented)
  // ============================================================================

  async create(
    streamPath: string,
    options: CreateStreamOptions = {}
  ): Promise<Stream> {
    // Use getMetaIfNotExpired to treat expired streams as non-existent
    const existing = this.getMetaIfNotExpired(streamPath)

    if (existing) {
      // Check if config matches (idempotent create)
      // MIME types are case-insensitive per RFC 2045
      const normalizeMimeType = (ct: string | undefined) =>
        (ct ?? `application/octet-stream`).toLowerCase()
      const contentTypeMatches =
        normalizeMimeType(options.contentType) ===
        normalizeMimeType(existing.contentType)
      const ttlMatches = options.ttlSeconds === existing.ttlSeconds
      const expiresMatches = options.expiresAt === existing.expiresAt

      if (contentTypeMatches && ttlMatches && expiresMatches) {
        // Idempotent success - return existing stream
        return this.streamMetaToStream(existing)
      } else {
        // Config mismatch - conflict
        throw new StreamAlreadyExistsError(streamPath)
      }
    }

    // Define key for LMDB operations
    const key = `stream:${streamPath}`

    // Initialize metadata
    const streamMeta: StreamMetadata = {
      path: streamPath,
      contentType: options.contentType,
      currentOffset: `0000000000000000_0000000000000000`,
      lastSeq: undefined,
      ttlSeconds: options.ttlSeconds,
      expiresAt: options.expiresAt,
      createdAt: Date.now(),
      segmentCount: 1,
      totalBytes: 0,
      directoryName: generateUniqueDirectoryName(streamPath),
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
      console.error(
        `[FileBackedStreamStore] Error creating stream directory:`,
        err
      )
      throw err
    }

    // Save to LMDB
    this.db.putSync(key, streamMeta)

    // Append initial data if provided
    if (options.initialData && options.initialData.length > 0) {
      await this.append(streamPath, options.initialData, {
        contentType: options.contentType,
        isInitialCreate: true,
      })
      // Re-fetch updated metadata
      const updated = this.db.get(key) as StreamMetadata
      return this.streamMetaToStream(updated)
    }

    return this.streamMetaToStream(streamMeta)
  }

  get(streamPath: string): Stream | undefined {
    const meta = this.getMetaIfNotExpired(streamPath)
    return meta ? this.streamMetaToStream(meta) : undefined
  }

  has(streamPath: string): boolean {
    return this.getMetaIfNotExpired(streamPath) !== undefined
  }

  delete(streamPath: string): boolean {
    const key = `stream:${streamPath}`
    const streamMeta = this.db.get(key) as StreamMetadata | undefined

    if (!streamMeta) {
      return false
    }

    // Close any open file handle for this stream's segment file
    // This is important especially on Windows where open handles block deletion
    const segmentPath = path.join(
      this.dataDir,
      `streams`,
      streamMeta.directoryName,
      `segment_00000.log`
    )
    this.fileHandlePool.closeFileHandle(segmentPath).catch((err: Error) => {
      console.error(`[FileBackedStreamStore] Error closing file handle:`, err)
    })

    // Delete from LMDB
    this.db.removeSync(key)

    // Delete files using unique directory name (async, but don't wait)
    // Safe to reuse stream path immediately since new creation gets new directory
    this.fileManager
      .deleteDirectoryByName(streamMeta.directoryName)
      .catch((err: Error) => {
        console.error(
          `[FileBackedStreamStore] Error deleting stream directory:`,
          err
        )
      })

    return true
  }

  async append(
    streamPath: string,
    data: Uint8Array,
    options: AppendOptions & { isInitialCreate?: boolean } = {}
  ): Promise<StreamMessage | null> {
    const streamMeta = this.getMetaIfNotExpired(streamPath)

    if (!streamMeta) {
      throw new StreamNotFoundError(streamPath)
    }

    // Check content type match using normalization (handles charset parameters)
    if (options.contentType && streamMeta.contentType) {
      const providedType = normalizeContentType(options.contentType)
      const streamType = normalizeContentType(streamMeta.contentType)
      if (providedType !== streamType) {
        throw new ContentTypeMismatchError(
          streamMeta.contentType,
          options.contentType
        )
      }
    }

    // Check sequence for writer coordination
    if (options.seq !== undefined) {
      if (
        streamMeta.lastSeq !== undefined &&
        options.seq <= streamMeta.lastSeq
      ) {
        throw new SequenceConflictError(options.seq, streamMeta.lastSeq)
      }
    }

    // Process JSON mode data (throws on invalid JSON or empty arrays for appends)
    let processedData = data
    if (normalizeContentType(streamMeta.contentType) === `application/json`) {
      processedData = processJsonAppend(data, options.isInitialCreate ?? false)
      // If empty array in create mode, return null (empty stream created successfully)
      if (processedData.length === 0) {
        return null
      }
    }

    // Parse current offset
    const parts = streamMeta.currentOffset.split(`_`).map(Number)
    const readSeq = parts[0]!
    const byteOffset = parts[1]!

    // Calculate new offset with zero-padding for lexicographic sorting (only data bytes, not framing)
    const newByteOffset = byteOffset + processedData.length
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
    lengthBuf.writeUInt32BE(processedData.length, 0)
    const frameBuf = Buffer.concat([
      lengthBuf,
      processedData,
      Buffer.from(`\n`),
    ])
    await new Promise<void>((resolve, reject) => {
      stream.write(frameBuf, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })

    // 2. Create message object for return value
    const message: StreamMessage = {
      data: processedData,
      offset: newOffset,
      timestamp: Date.now(),
    }

    // 3. Flush to disk (blocks here until durable)
    await this.fileHandlePool.fsyncFile(segmentPath)

    // 4. Update LMDB metadata (only after flush, so metadata reflects durability)
    const updatedMeta: StreamMetadata = {
      ...streamMeta,
      currentOffset: newOffset,
      lastSeq: options.seq ?? streamMeta.lastSeq,
      totalBytes: streamMeta.totalBytes + processedData.length + 5, // +4 for length, +1 for newline
    }
    const key = `stream:${streamPath}`
    this.db.putSync(key, updatedMeta)

    // 5. Return (client knows data is durable)
    return message
  }

  read(streamPath: string, offset?: string): ReadResult {
    const streamMeta = this.getMetaIfNotExpired(streamPath)

    if (!streamMeta) {
      throw new StreamNotFoundError(streamPath)
    }

    // Parse offsets
    const startOffset = offset ?? `0000000000000000_0000000000000000`
    const startParts = startOffset.split(`_`).map(Number)
    const startByte = startParts[1] ?? 0
    const currentParts = streamMeta.currentOffset.split(`_`).map(Number)
    const currentSeq = currentParts[0] ?? 0
    const currentByte = currentParts[1] ?? 0

    // Early return if no data available
    if (streamMeta.currentOffset === `0000000000000000_0000000000000000`) {
      return { messages: [], upToDate: true }
    }

    // If start offset is at or past current offset, return empty
    if (startByte >= currentByte) {
      return { messages: [], upToDate: true }
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
            offset: `${String(currentSeq).padStart(16, `0`)}_${String(messageOffset).padStart(16, `0`)}`,
            timestamp: 0, // Not stored in MVP
          })
        }

        currentDataOffset = messageOffset
      }
    } catch (err) {
      console.error(`[FileBackedStreamStore] Error reading file:`, err)
    }

    return { messages, upToDate: true }
  }

  clear(): void {
    // Clear all streams from LMDB
    const range = this.db.getRange({
      start: `stream:`,
      end: `stream:\xFF`,
    })

    // Convert to array to avoid iterator issues
    const entries = Array.from(range)

    for (const { key } of entries) {
      this.db.removeSync(key)
    }

    // Clear file handle pool
    this.fileHandlePool.closeAll().catch((err: Error) => {
      console.error(`[FileBackedStreamStore] Error closing handles:`, err)
    })

    // Note: Files are not deleted in clear() with unique directory names
    // New streams get fresh directories, so old files won't interfere
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
}
