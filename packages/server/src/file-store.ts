/**
 * File-backed stream storage implementation using LMDB for metadata
 * and append-only log files for stream data.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { randomBytes } from "node:crypto"
import { open as openLMDB } from "lmdb"
import { SieveCache } from "@neophi/sieve-cache"
import { StreamFileManager } from "./file-manager"
import { encodeStreamPath } from "./path-encoding"
import {
  formatJsonResponse,
  normalizeContentType,
  processJsonAppend,
} from "./store"
import type { AppendOptions, AppendResult } from "./store"
import type { Database } from "lmdb"
import type {
  PendingLongPoll,
  ProducerState,
  ProducerValidationResult,
  Stream,
  StreamMessage,
} from "./types"

/**
 * Serializable producer state for LMDB storage.
 */
interface SerializableProducerState {
  epoch: number
  lastSeq: number
  lastUpdated: number
}

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
   * Producer states for idempotent writes.
   * Stored as a plain object for LMDB serialization.
   */
  producers?: Record<string, SerializableProducerState>
  /**
   * Whether the stream is closed (no further appends permitted).
   * Once set to true, this is permanent and durable.
   */
  closed?: boolean
  /**
   * The producer tuple that closed this stream (for idempotent close).
   * If set, duplicate close requests with this tuple return 204.
   * CRITICAL: Must be persisted for duplicate detection after restart.
   */
  closedBy?: {
    producerId: string
    epoch: number
    seq: number
  }
  /**
   * Source stream path (set when this stream is a fork).
   */
  forkedFrom?: string
  /**
   * Divergence offset from the source stream.
   */
  forkOffset?: string
  /**
   * Number of forks referencing this stream.
   * Defaults to 0. Optional for backward-compatible deserialization from LMDB.
   */
  refCount?: number
  /**
   * Whether this stream is logically deleted but retained for fork readers.
   */
  softDeleted?: boolean
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
 * File-backed implementation of StreamStore.
 * Maintains the same interface as the in-memory StreamStore for drop-in compatibility.
 */
export class FileBackedStreamStore {
  private db: Database
  private fileManager: StreamFileManager
  private fileHandlePool: FileHandlePool
  private pendingLongPolls: Array<PendingLongPoll> = []
  private dataDir: string
  /**
   * Per-producer locks for serializing validation+append operations.
   * Key: "{streamPath}:{producerId}"
   */
  private producerLocks = new Map<string, Promise<unknown>>()

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
        // For forks, physical file bytes need to be added to forkOffset base
        const physicalOffset = this.scanFileForTrueOffset(segmentPath)
        const physicalBytes = Number(physicalOffset.split(`_`)[1] ?? 0)

        let trueOffset: string
        if (streamMeta.forkOffset) {
          // Fork: logical offset = forkOffset base + physical bytes in own file
          const forkBaseByte = Number(streamMeta.forkOffset.split(`_`)[1] ?? 0)
          const logicalBytes = forkBaseByte + physicalBytes
          trueOffset = `${String(0).padStart(16, `0`)}_${String(logicalBytes).padStart(16, `0`)}`
        } else {
          trueOffset = physicalOffset
        }

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
    // Convert producers from object to Map if present
    let producers: Map<string, ProducerState> | undefined
    if (meta.producers) {
      producers = new Map()
      for (const [id, state] of Object.entries(meta.producers)) {
        producers.set(id, { ...state })
      }
    }

    return {
      path: meta.path,
      contentType: meta.contentType,
      messages: [], // Messages not stored in memory
      currentOffset: meta.currentOffset,
      lastSeq: meta.lastSeq,
      ttlSeconds: meta.ttlSeconds,
      expiresAt: meta.expiresAt,
      createdAt: meta.createdAt,
      producers,
      closed: meta.closed,
      closedBy: meta.closedBy,
      forkedFrom: meta.forkedFrom,
      forkOffset: meta.forkOffset,
      refCount: meta.refCount ?? 0,
      softDeleted: meta.softDeleted,
    }
  }

  /**
   * Validate producer state WITHOUT mutating.
   * Returns proposed state to commit after successful append.
   *
   * IMPORTANT: This function does NOT mutate producer state. The caller must
   * commit the proposedState after successful append (file write + fsync + LMDB).
   * This ensures atomicity: if any step fails, producer state is not advanced.
   */
  private validateProducer(
    meta: StreamMetadata,
    producerId: string,
    epoch: number,
    seq: number
  ): ProducerValidationResult {
    // Initialize producers map if needed (safe - just ensures map exists)
    if (!meta.producers) {
      meta.producers = {}
    }

    const state = meta.producers[producerId]
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
   * Acquire a lock for serialized producer operations.
   * Returns a release function.
   */
  private async acquireProducerLock(
    streamPath: string,
    producerId: string
  ): Promise<() => void> {
    const lockKey = `${streamPath}:${producerId}`

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
   * Get the current epoch for a producer on a stream.
   * Returns undefined if the producer doesn't exist or stream not found.
   */
  getProducerEpoch(streamPath: string, producerId: string): number | undefined {
    const meta = this.getMetaIfNotExpired(streamPath)
    if (!meta?.producers) {
      return undefined
    }
    return meta.producers[producerId]?.epoch
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
   * Returns undefined if stream doesn't exist or is expired (and has no refs).
   * Expired streams with refCount > 0 are soft-deleted instead of fully deleted.
   */
  private getMetaIfNotExpired(streamPath: string): StreamMetadata | undefined {
    const key = `stream:${streamPath}`
    const meta = this.db.get(key) as StreamMetadata | undefined
    if (!meta) {
      return undefined
    }
    if (this.isExpired(meta)) {
      if ((meta.refCount ?? 0) > 0) {
        // Expired with refs: soft-delete instead of full delete
        if (!meta.softDeleted) {
          const updatedMeta: StreamMetadata = { ...meta, softDeleted: true }
          this.db.putSync(key, updatedMeta)
          return updatedMeta
        }
        return meta
      }
      // Delete expired stream
      this.delete(streamPath)
      return undefined
    }
    return meta
  }

  /**
   * Compute the effective expiry for a fork stream, capped at the source's expiry.
   */
  private computeForkExpiry(
    opts: { ttlSeconds?: number; expiresAt?: string },
    sourceMeta: StreamMetadata
  ): string | undefined {
    // Resolve source's absolute expiry
    let sourceExpiryMs: number | undefined
    if (sourceMeta.expiresAt) {
      sourceExpiryMs = new Date(sourceMeta.expiresAt).getTime()
    } else if (sourceMeta.ttlSeconds !== undefined) {
      sourceExpiryMs = sourceMeta.createdAt + sourceMeta.ttlSeconds * 1000
    }

    // Resolve fork's requested expiry
    let forkExpiryMs: number | undefined
    if (opts.expiresAt) {
      forkExpiryMs = new Date(opts.expiresAt).getTime()
    } else if (opts.ttlSeconds !== undefined) {
      forkExpiryMs = Date.now() + opts.ttlSeconds * 1000
    } else {
      forkExpiryMs = sourceExpiryMs // Inherit source expiry
    }

    // Cap at source expiry
    if (
      sourceExpiryMs !== undefined &&
      forkExpiryMs !== undefined &&
      forkExpiryMs > sourceExpiryMs
    ) {
      forkExpiryMs = sourceExpiryMs
    }

    if (forkExpiryMs !== undefined) {
      return new Date(forkExpiryMs).toISOString()
    }
    return undefined
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
    options: {
      contentType?: string
      ttlSeconds?: number
      expiresAt?: string
      initialData?: Uint8Array
      closed?: boolean
      forkedFrom?: string
      forkOffset?: string
    } = {}
  ): Promise<Stream> {
    // Use getMetaIfNotExpired to treat expired streams as non-existent
    const existingRaw = this.db.get(`stream:${streamPath}`) as
      | StreamMetadata
      | undefined

    if (existingRaw) {
      if (this.isExpired(existingRaw)) {
        // Expired: delete and proceed with creation
        this.delete(streamPath)
      } else if (existingRaw.softDeleted) {
        // Soft-deleted streams block new creation
        throw new Error(
          `Stream has active forks — path cannot be reused until all forks are removed: ${streamPath}`
        )
      } else {
        // Check if config matches (idempotent create)
        // MIME types are case-insensitive per RFC 2045
        const normalizeMimeType = (ct: string | undefined) =>
          (ct ?? `application/octet-stream`).toLowerCase()
        const contentTypeMatches =
          normalizeMimeType(options.contentType) ===
          normalizeMimeType(existingRaw.contentType)
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

        if (
          contentTypeMatches &&
          ttlMatches &&
          expiresMatches &&
          closedMatches &&
          forkedFromMatches &&
          forkOffsetMatches
        ) {
          // Idempotent success - return existing stream
          return this.streamMetaToStream(existingRaw)
        } else {
          // Config mismatch - conflict
          throw new Error(
            `Stream already exists with different configuration: ${streamPath}`
          )
        }
      }
    }

    // Fork creation: validate source stream and resolve fork parameters
    const isFork = !!options.forkedFrom
    let forkOffset = `0000000000000000_0000000000000000`
    let sourceContentType: string | undefined
    let sourceMeta: StreamMetadata | undefined

    if (isFork) {
      const sourceKey = `stream:${options.forkedFrom!}`
      sourceMeta = this.db.get(sourceKey) as StreamMetadata | undefined
      if (!sourceMeta) {
        throw new Error(`Source stream not found: ${options.forkedFrom}`)
      }
      if (sourceMeta.softDeleted) {
        throw new Error(`Source stream is soft-deleted: ${options.forkedFrom}`)
      }
      if (this.isExpired(sourceMeta)) {
        throw new Error(`Source stream not found: ${options.forkedFrom}`)
      }

      sourceContentType = sourceMeta.contentType

      // Resolve fork offset: use provided or source's currentOffset
      if (options.forkOffset) {
        forkOffset = options.forkOffset
      } else {
        forkOffset = sourceMeta.currentOffset
      }

      // Validate: zeroOffset <= forkOffset <= source.currentOffset
      const zeroOffset = `0000000000000000_0000000000000000`
      if (forkOffset < zeroOffset || sourceMeta.currentOffset < forkOffset) {
        throw new Error(`Invalid fork offset: ${forkOffset}`)
      }

      // Atomically increment source refcount in LMDB
      const freshSource = this.db.get(sourceKey) as StreamMetadata
      const updatedSource: StreamMetadata = {
        ...freshSource,
        refCount: (freshSource.refCount ?? 0) + 1,
      }
      this.db.putSync(sourceKey, updatedSource)
    }

    // Determine content type: use options, or inherit from source if fork
    let contentType = options.contentType
    if (!contentType || contentType.trim() === ``) {
      if (isFork) {
        contentType = sourceContentType
      }
    }

    // Compute effective expiry for forks
    let effectiveExpiresAt = options.expiresAt
    let effectiveTtlSeconds = options.ttlSeconds
    if (isFork) {
      effectiveExpiresAt = this.computeForkExpiry(options, sourceMeta!)
      effectiveTtlSeconds = undefined // Forks store expiresAt, not TTL
    }

    // Define key for LMDB operations
    const key = `stream:${streamPath}`

    // Initialize metadata
    // Note: We set closed to false initially, then set it true after appending initial data
    // This prevents the closed check from rejecting the initial append
    const streamMeta: StreamMetadata = {
      path: streamPath,
      contentType,
      currentOffset: isFork ? forkOffset : `0000000000000000_0000000000000000`,
      lastSeq: undefined,
      ttlSeconds: effectiveTtlSeconds,
      expiresAt: effectiveExpiresAt,
      createdAt: Date.now(),
      segmentCount: 1,
      totalBytes: 0,
      directoryName: generateUniqueDirectoryName(streamPath),
      closed: false, // Set to false initially, will be updated after initial append if needed
      forkedFrom: isFork ? options.forkedFrom : undefined,
      forkOffset: isFork ? forkOffset : undefined,
      refCount: 0,
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
      // Rollback source refcount on failure
      if (isFork && sourceMeta) {
        const sourceKey = `stream:${options.forkedFrom!}`
        const freshSource = this.db.get(sourceKey) as StreamMetadata | undefined
        if (freshSource) {
          const updatedSource: StreamMetadata = {
            ...freshSource,
            refCount: Math.max(0, (freshSource.refCount ?? 0) - 1),
          }
          this.db.putSync(sourceKey, updatedSource)
        }
      }
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
      try {
        await this.append(streamPath, options.initialData, {
          contentType: options.contentType,
          isInitialCreate: true,
        })
      } catch (err) {
        // Rollback source refcount on failure
        if (isFork && sourceMeta) {
          const sourceKey = `stream:${options.forkedFrom!}`
          const freshSource = this.db.get(sourceKey) as
            | StreamMetadata
            | undefined
          if (freshSource) {
            const updatedSource: StreamMetadata = {
              ...freshSource,
              refCount: Math.max(0, (freshSource.refCount ?? 0) - 1),
            }
            this.db.putSync(sourceKey, updatedSource)
          }
        }
        throw err
      }
    }

    // Now set closed flag if requested (after initial append succeeded)
    if (options.closed) {
      const updatedMeta = this.db.get(key) as StreamMetadata
      updatedMeta.closed = true
      this.db.putSync(key, updatedMeta)
    }

    // Re-fetch updated metadata
    const updated = this.db.get(key) as StreamMetadata
    return this.streamMetaToStream(updated)
  }

  get(streamPath: string): Stream | undefined {
    const meta = this.getMetaIfNotExpired(streamPath)
    if (!meta) return undefined
    return this.streamMetaToStream(meta)
  }

  has(streamPath: string): boolean {
    const meta = this.getMetaIfNotExpired(streamPath)
    if (!meta) return false
    if (meta.softDeleted) return false
    return true
  }

  delete(streamPath: string): boolean {
    const key = `stream:${streamPath}`
    const streamMeta = this.db.get(key) as StreamMetadata | undefined

    if (!streamMeta) {
      return false
    }

    // Already soft-deleted: idempotent success
    if (streamMeta.softDeleted) {
      return true
    }

    // If there are forks referencing this stream, soft-delete
    if ((streamMeta.refCount ?? 0) > 0) {
      const updatedMeta: StreamMetadata = { ...streamMeta, softDeleted: true }
      this.db.putSync(key, updatedMeta)
      this.cancelLongPollsForStream(streamPath)
      return true
    }

    // RefCount == 0: full delete with cascade
    this.deleteWithCascade(streamPath)
    return true
  }

  /**
   * Fully delete a stream and cascade to soft-deleted parents
   * whose refcount drops to zero.
   */
  private deleteWithCascade(streamPath: string): void {
    const key = `stream:${streamPath}`
    const streamMeta = this.db.get(key) as StreamMetadata | undefined
    if (!streamMeta) return

    const forkedFrom = streamMeta.forkedFrom

    // Cancel any pending long-polls for this stream
    this.cancelLongPollsForStream(streamPath)

    // Close any open file handle for this stream's segment file
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
    this.fileManager
      .deleteDirectoryByName(streamMeta.directoryName)
      .catch((err: Error) => {
        console.error(
          `[FileBackedStreamStore] Error deleting stream directory:`,
          err
        )
      })

    // If this stream is a fork, decrement the source's refcount
    if (forkedFrom) {
      const parentKey = `stream:${forkedFrom}`
      const parentMeta = this.db.get(parentKey) as StreamMetadata | undefined
      if (parentMeta) {
        const newRefCount = Math.max(0, (parentMeta.refCount ?? 0) - 1)
        const updatedParent: StreamMetadata = {
          ...parentMeta,
          refCount: newRefCount,
        }
        this.db.putSync(parentKey, updatedParent)

        // If parent refcount hit 0 and parent is soft-deleted, cascade
        if (newRefCount === 0 && updatedParent.softDeleted) {
          this.deleteWithCascade(forkedFrom)
        }
      }
    }
  }

  async append(
    streamPath: string,
    data: Uint8Array,
    options: AppendOptions & { isInitialCreate?: boolean } = {}
  ): Promise<StreamMessage | AppendResult | null> {
    const streamMeta = this.getMetaIfNotExpired(streamPath)

    if (!streamMeta) {
      throw new Error(`Stream not found: ${streamPath}`)
    }

    // Guard against soft-deleted streams
    if (streamMeta.softDeleted) {
      throw new Error(`Stream is soft-deleted: ${streamPath}`)
    }

    // Check if stream is closed
    if (streamMeta.closed) {
      // Check if this is a duplicate of the closing request (idempotent retry)
      if (
        options.producerId &&
        streamMeta.closedBy &&
        streamMeta.closedBy.producerId === options.producerId &&
        streamMeta.closedBy.epoch === options.producerEpoch &&
        streamMeta.closedBy.seq === options.producerSeq
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

      // Different request - stream is closed, reject
      return {
        message: null,
        streamClosed: true,
      }
    }

    // Check content type match using normalization (handles charset parameters)
    if (options.contentType && streamMeta.contentType) {
      const providedType = normalizeContentType(options.contentType)
      const streamType = normalizeContentType(streamMeta.contentType)
      if (providedType !== streamType) {
        throw new Error(
          `Content-type mismatch: expected ${streamMeta.contentType}, got ${options.contentType}`
        )
      }
    }

    // Handle producer validation FIRST if producer headers are present
    // This must happen before Stream-Seq check so that retries with both
    // producer headers AND Stream-Seq can return 204 (duplicate) instead of
    // failing the Stream-Seq conflict check.
    let producerResult: ProducerValidationResult | undefined
    if (
      options.producerId !== undefined &&
      options.producerEpoch !== undefined &&
      options.producerSeq !== undefined
    ) {
      producerResult = this.validateProducer(
        streamMeta,
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
      if (
        streamMeta.lastSeq !== undefined &&
        options.seq <= streamMeta.lastSeq
      ) {
        throw new Error(
          `Sequence conflict: ${options.seq} <= ${streamMeta.lastSeq}`
        )
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

    // 4. Update LMDB metadata atomically (only after flush, so metadata reflects durability)
    //    This includes both the offset update and producer state update
    //    Producer state is committed HERE (not in validateProducer) for atomicity
    const updatedProducers = { ...streamMeta.producers }
    if (producerResult && producerResult.status === `accepted`) {
      updatedProducers[producerResult.producerId] = producerResult.proposedState
    }

    // Build closedBy if closing with producer headers
    let closedBy: StreamMetadata[`closedBy`] = undefined
    if (options.close && options.producerId) {
      closedBy = {
        producerId: options.producerId,
        epoch: options.producerEpoch!,
        seq: options.producerSeq!,
      }
    }

    const updatedMeta: StreamMetadata = {
      ...streamMeta,
      currentOffset: newOffset,
      lastSeq: options.seq ?? streamMeta.lastSeq,
      totalBytes: streamMeta.totalBytes + processedData.length + 5, // +4 for length, +1 for newline
      producers: updatedProducers,
      closed: options.close ? true : streamMeta.closed,
      closedBy: closedBy ?? streamMeta.closedBy,
    }
    const key = `stream:${streamPath}`
    this.db.putSync(key, updatedMeta)

    // 5. Notify long-polls (data is now readable from disk)
    this.notifyLongPolls(streamPath)

    // 5a. If stream was closed, also notify long-polls of closure
    if (options.close) {
      this.notifyLongPollsClosed(streamPath)
    }

    // 6. Return AppendResult if producer headers were used or stream was closed
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
    streamPath: string,
    data: Uint8Array,
    options: AppendOptions
  ): Promise<AppendResult> {
    if (!options.producerId) {
      // No producer - just do a normal append
      const result = await this.append(streamPath, data, options)
      if (result && `message` in result) {
        return result
      }
      return { message: result }
    }

    // Acquire lock for this producer
    const releaseLock = await this.acquireProducerLock(
      streamPath,
      options.producerId
    )

    try {
      const result = await this.append(streamPath, data, options)
      if (result && `message` in result) {
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
    streamPath: string
  ): { finalOffset: string; alreadyClosed: boolean } | null {
    const streamMeta = this.getMetaIfNotExpired(streamPath)
    if (!streamMeta) {
      return null
    }

    const alreadyClosed = streamMeta.closed ?? false

    // Update LMDB to mark stream as closed
    const key = `stream:${streamPath}`
    const updatedMeta: StreamMetadata = {
      ...streamMeta,
      closed: true,
    }
    this.db.putSync(key, updatedMeta)

    // Notify any pending long-polls that the stream is closed
    this.notifyLongPollsClosed(streamPath)

    return {
      finalOffset: streamMeta.currentOffset,
      alreadyClosed,
    }
  }

  /**
   * Close a stream with producer headers for idempotent close-only operations.
   * Participates in producer sequencing for deduplication.
   * @returns The final offset and producer result, or null if stream doesn't exist
   */
  async closeStreamWithProducer(
    streamPath: string,
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
    const releaseLock = await this.acquireProducerLock(
      streamPath,
      options.producerId
    )

    try {
      const streamMeta = this.getMetaIfNotExpired(streamPath)
      if (!streamMeta) {
        return null
      }

      // Check if already closed
      if (streamMeta.closed) {
        // Check if this is the same producer tuple (duplicate - idempotent success)
        if (
          streamMeta.closedBy &&
          streamMeta.closedBy.producerId === options.producerId &&
          streamMeta.closedBy.epoch === options.producerEpoch &&
          streamMeta.closedBy.seq === options.producerSeq
        ) {
          return {
            finalOffset: streamMeta.currentOffset,
            alreadyClosed: true,
            producerResult: {
              status: `duplicate`,
              lastSeq: options.producerSeq,
            },
          }
        }

        // Different producer trying to close an already-closed stream - conflict
        return {
          finalOffset: streamMeta.currentOffset,
          alreadyClosed: true,
          producerResult: { status: `stream_closed` },
        }
      }

      // Validate producer state
      const producerResult = this.validateProducer(
        streamMeta,
        options.producerId,
        options.producerEpoch,
        options.producerSeq
      )

      // Return early for non-accepted results
      if (producerResult.status !== `accepted`) {
        return {
          finalOffset: streamMeta.currentOffset,
          alreadyClosed: streamMeta.closed ?? false,
          producerResult,
        }
      }

      // Commit producer state and close stream atomically in LMDB
      const key = `stream:${streamPath}`
      const updatedProducers = { ...streamMeta.producers }
      updatedProducers[producerResult.producerId] = producerResult.proposedState

      const updatedMeta: StreamMetadata = {
        ...streamMeta,
        closed: true,
        closedBy: {
          producerId: options.producerId,
          epoch: options.producerEpoch,
          seq: options.producerSeq,
        },
        producers: updatedProducers,
      }
      this.db.putSync(key, updatedMeta)

      // Notify any pending long-polls
      this.notifyLongPollsClosed(streamPath)

      return {
        finalOffset: streamMeta.currentOffset,
        alreadyClosed: false,
        producerResult,
      }
    } finally {
      releaseLock()
    }
  }

  /**
   * Read messages from a specific segment file.
   * @param segmentPath - Path to the segment file
   * @param startByte - Start byte offset (skip messages at or before this offset)
   * @param baseByteOffset - Base byte offset to add to physical offsets (for fork stitching)
   * @param capByte - Optional cap: stop reading when logical offset exceeds this value
   * @returns Array of messages with properly computed offsets
   */
  private readMessagesFromSegmentFile(
    segmentPath: string,
    startByte: number,
    baseByteOffset: number,
    capByte?: number
  ): Array<StreamMessage> {
    const messages: Array<StreamMessage> = []

    if (!fs.existsSync(segmentPath)) {
      return messages
    }

    try {
      const fileContent = fs.readFileSync(segmentPath)
      let filePos = 0
      let physicalDataOffset = 0

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

        // Calculate this message's logical offset (end position)
        physicalDataOffset += messageLength
        const logicalOffset = baseByteOffset + physicalDataOffset

        // Stop if we've exceeded the cap
        if (capByte !== undefined && logicalOffset > capByte) {
          break
        }

        // Only include messages after start byte
        if (logicalOffset > startByte) {
          messages.push({
            data: new Uint8Array(messageData),
            offset: `${String(0).padStart(16, `0`)}_${String(logicalOffset).padStart(16, `0`)}`,
            timestamp: 0, // Not stored in MVP
          })
        }
      }
    } catch (err) {
      console.error(`[FileBackedStreamStore] Error reading segment file:`, err)
    }

    return messages
  }

  /**
   * Recursively read messages from a fork's source chain.
   * Reads from source (and its sources if also forked), capped at capByte.
   * Does NOT check softDeleted -- forks must read through soft-deleted sources.
   */
  private readForkedMessages(
    sourcePath: string,
    startByte: number,
    capByte: number
  ): Array<StreamMessage> {
    const sourceKey = `stream:${sourcePath}`
    const sourceMeta = this.db.get(sourceKey) as StreamMetadata | undefined
    if (!sourceMeta) {
      return []
    }

    const messages: Array<StreamMessage> = []

    // If source is also a fork and we need messages before source's forkOffset,
    // recursively read from source's source
    if (sourceMeta.forkedFrom && sourceMeta.forkOffset) {
      const sourceForkByte = Number(sourceMeta.forkOffset.split(`_`)[1] ?? 0)

      if (startByte < sourceForkByte) {
        // Cap at the minimum of source's forkByte and our capByte
        const inheritedCap = Math.min(sourceForkByte, capByte)
        const inherited = this.readForkedMessages(
          sourceMeta.forkedFrom,
          startByte,
          inheritedCap
        )
        messages.push(...inherited)
      }
    }

    // Read source's own segment file
    // For a fork source, its own data starts at physical byte 0 in its segment file,
    // but the logical offsets need to account for its own forkOffset base
    const segmentPath = path.join(
      this.dataDir,
      `streams`,
      sourceMeta.directoryName,
      `segment_00000.log`
    )

    // The base offset for this source's own data is its forkOffset (if it's a fork) or 0
    const sourceBaseByte = sourceMeta.forkOffset
      ? Number(sourceMeta.forkOffset.split(`_`)[1] ?? 0)
      : 0

    const ownMessages = this.readMessagesFromSegmentFile(
      segmentPath,
      startByte,
      sourceBaseByte,
      capByte
    )
    messages.push(...ownMessages)

    return messages
  }

  read(
    streamPath: string,
    offset?: string
  ): { messages: Array<StreamMessage>; upToDate: boolean } {
    const streamMeta = this.getMetaIfNotExpired(streamPath)

    if (!streamMeta) {
      throw new Error(`Stream not found: ${streamPath}`)
    }

    // Parse offsets
    const startOffset = offset ?? `0000000000000000_0000000000000000`
    const startByte = Number(startOffset.split(`_`)[1] ?? 0)
    const currentByte = Number(streamMeta.currentOffset.split(`_`)[1] ?? 0)

    // Early return if no data available
    if (streamMeta.currentOffset === `0000000000000000_0000000000000000`) {
      return { messages: [], upToDate: true }
    }

    // If start offset is at or past current offset, return empty
    if (startByte >= currentByte) {
      return { messages: [], upToDate: true }
    }

    const messages: Array<StreamMessage> = []

    // For forked streams, stitch inherited and own messages
    if (streamMeta.forkedFrom && streamMeta.forkOffset) {
      const forkByte = Number(streamMeta.forkOffset.split(`_`)[1] ?? 0)

      // If offset is before the forkOffset, read from source chain
      if (startByte < forkByte) {
        const inherited = this.readForkedMessages(
          streamMeta.forkedFrom,
          startByte,
          forkByte
        )
        messages.push(...inherited)
      }

      // Read fork's own segment file with offset translation
      // Physical bytes in file start at 0, but logical offsets start at forkOffset
      const segmentPath = path.join(
        this.dataDir,
        `streams`,
        streamMeta.directoryName,
        `segment_00000.log`
      )
      const ownMessages = this.readMessagesFromSegmentFile(
        segmentPath,
        startByte,
        forkByte
      )
      messages.push(...ownMessages)
    } else {
      // Non-forked stream: read from segment file directly
      const segmentPath = path.join(
        this.dataDir,
        `streams`,
        streamMeta.directoryName,
        `segment_00000.log`
      )
      const ownMessages = this.readMessagesFromSegmentFile(
        segmentPath,
        startByte,
        0
      )
      messages.push(...ownMessages)
    }

    return { messages, upToDate: true }
  }

  async waitForMessages(
    streamPath: string,
    offset: string,
    timeoutMs: number
  ): Promise<{
    messages: Array<StreamMessage>
    timedOut: boolean
    streamClosed?: boolean
  }> {
    const streamMeta = this.getMetaIfNotExpired(streamPath)

    if (!streamMeta) {
      throw new Error(`Stream not found: ${streamPath}`)
    }

    // For forks: if offset is in the inherited range (< forkOffset),
    // read and return immediately instead of long-polling
    if (
      streamMeta.forkedFrom &&
      streamMeta.forkOffset &&
      offset < streamMeta.forkOffset
    ) {
      const { messages } = this.read(streamPath, offset)
      return { messages, timedOut: false }
    }

    // If stream is closed and client is at tail, return immediately
    if (streamMeta.closed && offset === streamMeta.currentOffset) {
      return { messages: [], timedOut: false, streamClosed: true }
    }

    // Check if there are already new messages
    const { messages } = this.read(streamPath, offset)
    if (messages.length > 0) {
      return { messages, timedOut: false, streamClosed: streamMeta.closed }
    }

    // If stream is closed (but client not at tail), return what we have
    if (streamMeta.closed) {
      return { messages: [], timedOut: false, streamClosed: true }
    }

    // Wait for new messages
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        // Remove from pending
        this.removePendingLongPoll(pending)
        // Check if stream was closed during wait
        const currentMeta = this.getMetaIfNotExpired(streamPath)
        resolve({
          messages: [],
          timedOut: true,
          streamClosed: currentMeta?.closed,
        })
      }, timeoutMs)

      const pending: PendingLongPoll = {
        path: streamPath,
        offset,
        resolve: (msgs) => {
          clearTimeout(timeoutId)
          this.removePendingLongPoll(pending)
          // Check if stream was closed
          const currentMeta = this.getMetaIfNotExpired(streamPath)
          resolve({
            messages: msgs,
            timedOut: false,
            streamClosed: currentMeta?.closed,
          })
        },
        timeoutId,
      }

      this.pendingLongPolls.push(pending)
    })
  }

  /**
   * Format messages for response.
   * For JSON mode, wraps concatenated data in array brackets.
   * @throws Error if stream doesn't exist or is expired
   */
  formatResponse(
    streamPath: string,
    messages: Array<StreamMessage>
  ): Uint8Array {
    const streamMeta = this.getMetaIfNotExpired(streamPath)

    if (!streamMeta) {
      throw new Error(`Stream not found: ${streamPath}`)
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
    if (normalizeContentType(streamMeta.contentType) === `application/json`) {
      return formatJsonResponse(concatenated)
    }

    return concatenated
  }

  getCurrentOffset(streamPath: string): string | undefined {
    const streamMeta = this.getMetaIfNotExpired(streamPath)
    return streamMeta?.currentOffset
  }

  clear(): void {
    // Cancel all pending long-polls and resolve them with empty result
    for (const pending of this.pendingLongPolls) {
      clearTimeout(pending.timeoutId)
      // Resolve with empty result to unblock waiting handlers
      pending.resolve([])
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
      this.db.removeSync(key)
    }

    // Clear file handle pool
    this.fileHandlePool.closeAll().catch((err: Error) => {
      console.error(`[FileBackedStreamStore] Error closing handles:`, err)
    })

    // Note: Files are not deleted in clear() with unique directory names
    // New streams get fresh directories, so old files won't interfere
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

  /**
   * Notify pending long-polls that a stream has been closed.
   * They should wake up immediately and return Stream-Closed: true.
   */
  private notifyLongPollsClosed(streamPath: string): void {
    const toNotify = this.pendingLongPolls.filter((p) => p.path === streamPath)
    for (const pending of toNotify) {
      // Resolve with empty messages - the caller will check stream.closed
      pending.resolve([])
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
