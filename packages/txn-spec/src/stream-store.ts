/**
 * Stream-Backed Store Implementation
 *
 * Implements the formal specification's store interface backed by actual
 * durable streams. This enables:
 * - Persistence: All operations are durably stored
 * - Recovery: State can be reconstructed by replaying the stream
 * - Replication: Multiple readers can tail the stream
 * - Live queries: Subscribers can watch for changes
 *
 * Architecture:
 * - Operations are serialized as JSON records to the stream
 * - The Map Store is used as an in-memory cache for fast reads
 * - The stream serves as the source of truth (WAL pattern)
 */

import { isBottom } from "./types"
import { assign, del, increment } from "./effects"
import { createEventStream, createMapStore } from "./store"
import type { StoreEventStream, StreamStore } from "./store"
import type {
  Effect,
  EffectBuffer,
  EffectOrBottom,
  Key,
  Timestamp,
  TxnId,
} from "./types"
import type { DurableStream, JsonBatch } from "@durable-streams/client"

// =============================================================================
// Stream Record Types
// =============================================================================

/**
 * Base record type for all stream records.
 */
interface BaseStreamRecord {
  readonly type: string
  readonly timestamp: number
}

/**
 * Begin transaction record.
 */
interface BeginRecord extends BaseStreamRecord {
  readonly type: `begin`
  readonly txnId: TxnId
  readonly snapshotTs: Timestamp
}

/**
 * Update record.
 */
interface UpdateRecord extends BaseStreamRecord {
  readonly type: `update`
  readonly txnId: TxnId
  readonly key: Key
  readonly effect: SerializedEffect
}

/**
 * Abort record.
 */
interface AbortRecord extends BaseStreamRecord {
  readonly type: `abort`
  readonly txnId: TxnId
}

/**
 * Commit record.
 */
interface CommitRecord extends BaseStreamRecord {
  readonly type: `commit`
  readonly txnId: TxnId
  readonly snapshotTs: Timestamp
  readonly commitTs: Timestamp
  readonly effectBuffer: Array<[Key, SerializedEffect]>
}

/**
 * Union of all stream record types.
 */
type StreamRecord = BeginRecord | UpdateRecord | AbortRecord | CommitRecord

/**
 * Serialized effect format (JSON-safe).
 */
type SerializedEffect =
  | { type: `assign`; value: unknown }
  | { type: `increment`; delta: number }
  | { type: `delete` }
  | { type: `custom`; name: string; payload: unknown }

// =============================================================================
// Effect Serialization
// =============================================================================

/**
 * Serialize an effect to JSON-safe format.
 */
function serializeEffect(effect: Effect): SerializedEffect {
  switch (effect.type) {
    case `assign`:
      return { type: `assign`, value: effect.value }
    case `increment`:
      return { type: `increment`, delta: effect.delta }
    case `delete`:
      return { type: `delete` }
    case `custom`:
      return { type: `custom`, name: effect.name, payload: effect.payload }
  }
}

/**
 * Deserialize an effect from JSON format.
 */
function deserializeEffect(serialized: SerializedEffect): Effect {
  switch (serialized.type) {
    case `assign`:
      return assign(serialized.value)
    case `increment`:
      return increment(serialized.delta)
    case `delete`:
      return del()
    case `custom`:
      // Custom effects need their apply/merge functions restored
      // For now, create a simple passthrough custom effect
      return {
        type: `custom`,
        name: serialized.name,
        payload: serialized.payload,
        apply: () => serialized.payload,
        merge: () => ({
          type: `custom`,
          name: serialized.name,
          payload: serialized.payload,
          apply: () => serialized.payload,
          merge: () => {
            throw new Error(`Cannot merge deserialized custom effects`)
          },
        }),
      }
  }
}

/**
 * Serialize an effect buffer to JSON-safe format.
 */
function serializeEffectBuffer(
  buffer: EffectBuffer
): Array<[Key, SerializedEffect]> {
  const result: Array<[Key, SerializedEffect]> = []
  for (const [key, effect] of buffer) {
    if (!isBottom(effect)) {
      result.push([key, serializeEffect(effect)])
    }
  }
  return result
}

/**
 * Deserialize an effect buffer from JSON format.
 */
function deserializeEffectBuffer(
  serialized: Array<[Key, SerializedEffect]>
): EffectBuffer {
  const buffer: EffectBuffer = new Map()
  for (const [key, effect] of serialized) {
    buffer.set(key, deserializeEffect(effect))
  }
  return buffer
}

// =============================================================================
// Stream-Backed Store Options
// =============================================================================

/**
 * Options for creating a stream-backed store.
 */
export interface StreamBackedStoreOptions {
  /**
   * The durable stream handle to use for persistence.
   */
  stream: DurableStream

  /**
   * Whether to recover state from the stream on creation.
   * @default true
   */
  recover?: boolean

  /**
   * Whether to enable live updates (tail the stream).
   * @default false
   */
  live?: boolean

  /**
   * Starting offset for reading (for recovery).
   * @default "-1" (beginning)
   */
  offset?: string
}

// =============================================================================
// Stream-Backed Store
// =============================================================================

/**
 * Create a stream-backed store.
 *
 * This store persists all operations to a durable stream and uses
 * an in-memory Map Store as a cache for fast reads.
 *
 * @example
 * ```typescript
 * const durableStream = await DurableStream.create({
 *   url: "http://localhost:8080/txn-store",
 *   contentType: "application/json",
 * })
 *
 * const store = await createStreamBackedStore({
 *   stream: durableStream,
 *   recover: true,
 * })
 *
 * // Use like any other store
 * store.doBegin("txn1", 0)
 * store.doUpdate("txn1", "key", 0, assign(42))
 * store.doCommit("txn1", 0, effectBuffer, 5)
 * ```
 */
export async function createStreamBackedStore(
  options: StreamBackedStoreOptions
): Promise<
  StreamStore & {
    /** Get the underlying durable stream */
    getDurableStream: () => DurableStream
    /** Get the current stream offset */
    getOffset: () => string
    /** Wait for pending writes to complete */
    flush: () => Promise<void>
  }
> {
  const { stream, recover = true, live = false, offset = `-1` } = options

  // Use a Map Store as the in-memory cache
  const cache = createMapStore()
  const eventStream = createEventStream()

  // Track current offset and pending writes
  let currentOffset = offset
  const pendingWrites: Array<Promise<void>> = []

  // Track transaction state for recovery
  const txnSnapshots = new Map<TxnId, Timestamp>()

  /**
   * Write a record to the stream.
   */
  async function writeRecord(
    record: Omit<StreamRecord, `timestamp`>
  ): Promise<void> {
    const fullRecord: StreamRecord = {
      ...record,
      timestamp: Date.now(),
    } as StreamRecord

    const promise = stream.append(JSON.stringify(fullRecord))
    pendingWrites.push(promise)

    try {
      await promise
    } finally {
      const index = pendingWrites.indexOf(promise)
      if (index > -1) {
        pendingWrites.splice(index, 1)
      }
    }
  }

  /**
   * Apply a record to the cache.
   */
  function applyRecord(record: StreamRecord): void {
    switch (record.type) {
      case `begin`:
        cache.doBegin(record.txnId, record.snapshotTs)
        txnSnapshots.set(record.txnId, record.snapshotTs)
        break

      case `update`:
        // Updates are buffered until commit, so no cache action needed
        break

      case `abort`:
        txnSnapshots.delete(record.txnId)
        break

      case `commit`: {
        const effectBuffer = deserializeEffectBuffer(record.effectBuffer)
        cache.doCommit(
          record.txnId,
          record.snapshotTs,
          effectBuffer,
          record.commitTs
        )
        txnSnapshots.delete(record.txnId)
        break
      }
    }
  }

  /**
   * Recover state from the stream.
   */
  async function recoverFromStream(): Promise<void> {
    const response = await stream.stream<StreamRecord>({
      offset: currentOffset,
      live: false, // Catch up only
    })

    const records = await response.json<StreamRecord>()
    for (const record of records) {
      applyRecord(record)
    }

    currentOffset = response.offset
  }

  // Recover state if requested
  if (recover) {
    await recoverFromStream()
  }

  // Start live subscription if requested
  // Note: _liveUnsubscribe could be exposed in the future to stop live updates
  let _liveUnsubscribe: (() => void) | undefined
  if (live) {
    const response = await stream.stream<StreamRecord>({
      offset: currentOffset,
      live: true,
    })

    _liveUnsubscribe = response.subscribeJson<StreamRecord>((batch) => {
      for (const record of batch.items) {
        applyRecord(record)
      }
      currentOffset = batch.offset
    })
  }

  return {
    doBegin(txnId: TxnId, st: Timestamp): void {
      // Write to stream (fire and forget for now)
      writeRecord({ type: `begin`, txnId, snapshotTs: st })

      // Update cache
      cache.doBegin(txnId, st)
      txnSnapshots.set(txnId, st)

      // Emit event
      eventStream.emit({ type: `begin`, txnId, snapshotTs: st })
    },

    lookup(key: Key, st: Timestamp): EffectOrBottom {
      // Read from cache (fast path)
      const result = cache.lookup(key, st)
      eventStream.emit({ type: `lookup`, key, snapshotTs: st, result })
      return result
    },

    doUpdate(txnId: TxnId, key: Key, st: Timestamp, effect: Effect): void {
      // Write to stream
      writeRecord({
        type: `update`,
        txnId,
        key,
        effect: serializeEffect(effect),
      })

      // Update cache
      cache.doUpdate(txnId, key, st, effect)

      // Emit event
      eventStream.emit({ type: `update`, txnId, key, effect })
    },

    doAbort(txnId: TxnId, st: Timestamp): void {
      // Write to stream
      writeRecord({ type: `abort`, txnId })

      // Update cache
      cache.doAbort(txnId, st)
      txnSnapshots.delete(txnId)

      // Emit event
      eventStream.emit({ type: `abort`, txnId })
    },

    doCommit(
      txnId: TxnId,
      st: Timestamp,
      effectBuffer: EffectBuffer,
      ct: Timestamp
    ): void {
      // Write to stream
      writeRecord({
        type: `commit`,
        txnId,
        snapshotTs: st,
        commitTs: ct,
        effectBuffer: serializeEffectBuffer(effectBuffer),
      })

      // Update cache
      cache.doCommit(txnId, st, effectBuffer, ct)
      txnSnapshots.delete(txnId)

      // Emit event
      eventStream.emit({
        type: `commit`,
        txnId,
        snapshotTs: st,
        commitTs: ct,
        effectBuffer,
      })
    },

    getEventStream(): StoreEventStream {
      return eventStream
    },

    getDurableStream(): DurableStream {
      return stream
    },

    getOffset(): string {
      return currentOffset
    },

    async flush(): Promise<void> {
      await Promise.all(pendingWrites)
    },
  }
}

// =============================================================================
// In-Memory Stream Store (for testing without network)
// =============================================================================

/**
 * A simple in-memory stream implementation for testing.
 * Mimics the DurableStream API without network IO.
 */
export class InMemoryStream {
  private records: Array<string> = []
  private offset = 0
  private subscribers = new Set<(record: string, offset: string) => void>()
  private closed = false

  /**
   * Append data to the stream.
   */
  append(data: string): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error(`Stream is closed`))
    }
    this.records.push(data)
    this.offset++
    const currentOffset = String(this.offset)
    for (const subscriber of this.subscribers) {
      subscriber(data, currentOffset)
    }
    return Promise.resolve()
  }

  /**
   * Read all records from the stream.
   */
  stream<T>(options?: { offset?: string; live?: boolean }): Promise<{
    json: <U = T>() => Promise<Array<U>>
    subscribeJson: <U = T>(cb: (batch: JsonBatch<U>) => void) => () => void
    offset: string
  }> {
    const startOffset =
      options?.offset === `-1` ? 0 : parseInt(options?.offset ?? `0`, 10)
    const live = options?.live ?? false

    let currentOffset = startOffset

    return Promise.resolve({
      json: <U = T>(): Promise<Array<U>> => {
        const results: Array<U> = []
        for (let i = startOffset; i < this.records.length; i++) {
          results.push(JSON.parse(this.records[i]!) as U)
        }
        currentOffset = this.records.length
        return Promise.resolve(results)
      },

      subscribeJson: <U = T>(
        cb: (batch: JsonBatch<U>) => void
      ): (() => void) => {
        // First, send existing records
        const existingRecords: Array<U> = []
        for (let i = startOffset; i < this.records.length; i++) {
          existingRecords.push(JSON.parse(this.records[i]!) as U)
        }
        if (existingRecords.length > 0) {
          cb({
            items: existingRecords,
            offset: String(this.records.length),
            upToDate: !live,
            streamClosed: this.closed,
          })
        }

        if (!live) {
          return () => {}
        }

        // Subscribe to new records
        const handler = (record: string, offset: string) => {
          cb({
            items: [JSON.parse(record) as U],
            offset,
            upToDate: true,
            streamClosed: this.closed,
          })
        }
        this.subscribers.add(handler)

        return () => {
          this.subscribers.delete(handler)
        }
      },

      get offset() {
        return String(currentOffset)
      },
    })
  }

  /**
   * Close the stream.
   */
  close(): Promise<void> {
    this.closed = true
    return Promise.resolve()
  }

  /**
   * Get the current length.
   */
  get length(): number {
    return this.records.length
  }
}

/**
 * Create a stream-backed store using an in-memory stream.
 * Useful for testing without network IO.
 */
export async function createInMemoryStreamStore(): Promise<
  StreamStore & {
    getInMemoryStream: () => InMemoryStream
    getOffset: () => string
    flush: () => Promise<void>
  }
> {
  const memStream = new InMemoryStream()

  // Adapt InMemoryStream to look like DurableStream for createStreamBackedStore
  const adapted = {
    append: (data: string) => memStream.append(data),
    stream: <T>(opts?: { offset?: string; live?: boolean }) =>
      memStream.stream<T>(opts),
  } as unknown as DurableStream

  const store = await createStreamBackedStore({
    stream: adapted,
    recover: false, // Empty stream
  })

  return {
    ...store,
    getInMemoryStream: () => memStream,
  }
}
