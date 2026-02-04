/**
 * Store Module
 *
 * Implements the store semantics from the formal specification:
 * - Map store: eager, random-access, good for reads
 * - Journal store: lazy, sequential, good for writes, crash-tolerant
 * - Composed store: combines stores (e.g., WAL = map + journal)
 *
 * Key insight: All stores are backed by durable streams.
 * - Journal = append-only stream of records
 * - Map = materialized view of a stream
 * - LSM tree = hierarchy of streams with compaction
 * - Queries emit streams (for live updates and resumability)
 *
 * Store interface (Figure 10):
 * - doBegin(σ, τ, st) → σ'
 * - lookup(σ, k, st) → δ
 * - doUpdate(σ, τ, k, st, δ) → σ'
 * - doAbort(σ, τ, st) → σ'
 * - doCommit(σ, τ, st, B, ct) → σ'
 */

import { BOTTOM, createOTSP, isBottom, otspPrecedes } from "./types"
import { composeEffects, isAssignment, mergeEffectSet } from "./effects"
import type {
  AbortRecord,
  BeginTxnRecord,
  CommitRecord,
  Effect,
  EffectBuffer,
  EffectOrBottom,
  JournalRecord,
  Key,
  Timestamp,
  TxnId,
  UpdateRecord,
} from "./types"

import type { StoreInterface } from "./transaction"
import type { Trace, TraceNode, TraceRecorder } from "./trace"

/** Type for the valAt function from trace module */
type ValAtFn = (
  trace: Trace,
  node: TraceNode,
  key: Key,
  cache?: Map<TraceNode, EffectOrBottom>
) => EffectOrBottom

// =============================================================================
// Store Events (for stream-based architecture)
// =============================================================================

/**
 * Store event types - all store operations emit events to a stream.
 * This enables:
 * - Durable persistence via append-only log
 * - Replication by tailing the stream
 * - Recovery by replaying the stream
 * - Live queries by subscribing to the stream
 */
export type StoreEventType =
  | `begin`
  | `update`
  | `abort`
  | `commit`
  | `lookup`
  | `checkpoint`
  | `compaction`

/**
 * Base store event.
 */
export interface BaseStoreEvent {
  readonly type: StoreEventType
  readonly timestamp: number // Wall-clock time for ordering
  readonly sequence: number // Monotonic sequence number
}

/**
 * Begin transaction event.
 */
export interface BeginEvent extends BaseStoreEvent {
  readonly type: `begin`
  readonly txnId: TxnId
  readonly snapshotTs: Timestamp
}

/**
 * Update event.
 */
export interface UpdateEvent extends BaseStoreEvent {
  readonly type: `update`
  readonly txnId: TxnId
  readonly key: Key
  readonly effect: Effect
}

/**
 * Abort event.
 */
export interface AbortEvent extends BaseStoreEvent {
  readonly type: `abort`
  readonly txnId: TxnId
}

/**
 * Commit event.
 */
export interface CommitEvent extends BaseStoreEvent {
  readonly type: `commit`
  readonly txnId: TxnId
  readonly snapshotTs: Timestamp
  readonly commitTs: Timestamp
  readonly effectBuffer: EffectBuffer
}

/**
 * Lookup event (for query streams).
 */
export interface LookupEvent extends BaseStoreEvent {
  readonly type: `lookup`
  readonly key: Key
  readonly snapshotTs: Timestamp
  readonly result: EffectOrBottom
}

/**
 * Checkpoint event (map/SSTable creation).
 */
export interface CheckpointEvent extends BaseStoreEvent {
  readonly type: `checkpoint`
  readonly level: number
  readonly lowTs: Timestamp
  readonly highTs: Timestamp
  readonly keys: Array<Key>
}

/**
 * Compaction event (LSM-tree maintenance).
 */
export interface CompactionEvent extends BaseStoreEvent {
  readonly type: `compaction`
  readonly fromLevel: number
  readonly toLevel: number
  readonly removedKeys: Array<Key>
  readonly mergedKeys: Array<Key>
}

/**
 * Union of all store events.
 */
export type StoreEvent =
  | BeginEvent
  | UpdateEvent
  | AbortEvent
  | CommitEvent
  | LookupEvent
  | CheckpointEvent
  | CompactionEvent

/**
 * Store event stream - enables tailing store changes.
 */
export interface StoreEventStream {
  /** Subscribe to events */
  subscribe: (handler: (event: StoreEvent) => void) => () => void
  /** Get events since a sequence number */
  since: (sequence: number) => Array<StoreEvent>
  /** Get the current sequence number */
  getSequence: () => number
}

// =============================================================================
// Abstract Store
// =============================================================================

/**
 * Extended store interface with stream capabilities.
 */
export interface StreamStore extends StoreInterface {
  /** Get the event stream for this store */
  getEventStream: () => StoreEventStream
  /** Create a checkpoint (for map stores) */
  checkpoint?: () => void
  /** Compact the store (for LSM trees) */
  compact?: () => void
  /** Recover from a stream */
  recover?: (events: Iterable<StoreEvent>) => void
}

/**
 * Base implementation for event streaming.
 */
export function createEventStream(): StoreEventStream & {
  emit: (event: Omit<StoreEvent, `sequence` | `timestamp`>) => void
} {
  const events: Array<StoreEvent> = []
  const subscribers = new Set<(event: StoreEvent) => void>()
  let sequence = 0

  return {
    emit(event: Omit<StoreEvent, `sequence` | `timestamp`>): void {
      const fullEvent = {
        ...event,
        sequence: sequence++,
        timestamp: Date.now(),
      } as StoreEvent
      events.push(fullEvent)
      for (const handler of subscribers) {
        handler(fullEvent)
      }
    },

    subscribe(handler: (event: StoreEvent) => void): () => void {
      subscribers.add(handler)
      return () => subscribers.delete(handler)
    },

    since(seq: number): Array<StoreEvent> {
      return events.filter((e) => e.sequence >= seq)
    },

    getSequence(): number {
      return sequence
    },
  }
}

// =============================================================================
// Map Store (Figure 5)
// =============================================================================

/**
 * Map store state.
 * σ_M ∈ (Key × Timestamp → Timestamp × Assign)
 *
 * Maps (key, version_timestamp) to (dependency_timestamp, effect).
 */
export interface MapStoreState {
  /** Version index: key -> version_ts -> { dependency_ts, effect } */
  readonly versions: Map<
    Key,
    Map<Timestamp, { depTs: Timestamp; effect: Effect }>
  >
}

/**
 * Create a map store.
 * Implements the semantics from Figure 5.
 */
export function createMapStore(): StreamStore {
  const state: MapStoreState = {
    versions: new Map(),
  }
  const eventStream = createEventStream()

  /**
   * Get visible versions for a key at a snapshot timestamp.
   * Visible versions have version_ts < st.
   */
  function getVisibleVersions(
    key: Key,
    st: Timestamp
  ): Array<{ versionTs: Timestamp; depTs: Timestamp; effect: Effect }> {
    const keyVersions = state.versions.get(key)
    if (!keyVersions) return []

    const visible: Array<{
      versionTs: Timestamp
      depTs: Timestamp
      effect: Effect
    }> = []
    for (const [versionTs, data] of keyVersions) {
      if (versionTs < st) {
        visible.push({ versionTs, depTs: data.depTs, effect: data.effect })
      }
    }
    return visible
  }

  /**
   * Get maximal visible versions (for merge).
   * Uses OTSP ordering: v1 ≺ v2 iff v1.versionTs < v2.depTs
   */
  function getMaximalVersions(
    versions: Array<{ versionTs: Timestamp; depTs: Timestamp; effect: Effect }>
  ): Array<{ versionTs: Timestamp; depTs: Timestamp; effect: Effect }> {
    // Filter to only maximal elements (not preceded by any other)
    return versions.filter((v1) => {
      const otsp1 = createOTSP(v1.depTs, v1.versionTs)
      return !versions.some((v2) => {
        if (v1 === v2) return false
        const otsp2 = createOTSP(v2.depTs, v2.versionTs)
        return otspPrecedes(otsp1, otsp2)
      })
    })
  }

  /**
   * Find the common predecessor(s) of a set of versions.
   * These are versions that are predecessors of ALL the given versions.
   */
  function findCommonPredecessors(
    versions: Array<{ versionTs: Timestamp; depTs: Timestamp; effect: Effect }>,
    allVersions: Array<{
      versionTs: Timestamp
      depTs: Timestamp
      effect: Effect
    }>
  ): Array<{ versionTs: Timestamp; depTs: Timestamp; effect: Effect }> {
    // A version is a common predecessor if it precedes all given versions
    return allVersions.filter((p) => {
      // Check if p is a predecessor of ALL versions in the set
      return versions.every((v) => v !== p && p.versionTs < v.depTs)
    })
  }

  /**
   * Compute the composed effect at a version, recursively including predecessors.
   * Handles concurrent effects by merging their raw effects, then composing with
   * the common predecessor's effect.
   */
  function computeEffectAtVersion(
    versions: Array<{ versionTs: Timestamp; depTs: Timestamp; effect: Effect }>,
    allVersions: Array<{
      versionTs: Timestamp
      depTs: Timestamp
      effect: Effect
    }>
  ): EffectOrBottom {
    if (versions.length === 0) {
      return BOTTOM
    }

    if (versions.length === 1) {
      const v = versions[0]!
      // Find predecessors of this single version
      const predecessors = allVersions.filter(
        (p) => p !== v && p.versionTs < v.depTs
      )
      if (predecessors.length === 0) {
        return v.effect
      }
      // Get maximal predecessors
      const maximalPredecessors = predecessors.filter((p1) => {
        const otsp1 = createOTSP(p1.depTs, p1.versionTs)
        return !predecessors.some((p2) => {
          if (p1 === p2) return false
          const otsp2 = createOTSP(p2.depTs, p2.versionTs)
          return otspPrecedes(otsp1, otsp2)
        })
      })
      // Recursively compute effect at predecessors
      const predecessorEffect = computeEffectAtVersion(
        maximalPredecessors,
        allVersions
      )
      // Compose: predecessor ⊙ this
      return composeEffects(predecessorEffect, v.effect)
    }

    // Multiple concurrent versions
    // Find their common predecessors
    const commonPredecessors = findCommonPredecessors(versions, allVersions)

    // Get maximal common predecessors
    const maximalCommonPredecessors = commonPredecessors.filter((p1) => {
      const otsp1 = createOTSP(p1.depTs, p1.versionTs)
      return !commonPredecessors.some((p2) => {
        if (p1 === p2) return false
        const otsp2 = createOTSP(p2.depTs, p2.versionTs)
        return otspPrecedes(otsp1, otsp2)
      })
    })

    // Compute effect at common predecessors
    const commonEffect = computeEffectAtVersion(
      maximalCommonPredecessors,
      allVersions
    )

    // Merge the raw effects of the concurrent versions
    const mergedRawEffects = mergeEffectSet(versions.map((v) => v.effect))

    // Compose: common predecessor effect ⊙ merged raw effects
    return composeEffects(commonEffect, mergedRawEffects)
  }

  return {
    doBegin(txnId: TxnId, st: Timestamp): void {
      // Map store: doBegin is a no-op
      eventStream.emit({ type: `begin`, txnId, snapshotTs: st })
    },

    lookup(key: Key, st: Timestamp): EffectOrBottom {
      const visible = getVisibleVersions(key, st)
      if (visible.length === 0) {
        const result = BOTTOM
        eventStream.emit({ type: `lookup`, key, snapshotTs: st, result })
        return result
      }

      const maximal = getMaximalVersions(visible)

      // Compute the composed effect considering concurrent merges
      const result = computeEffectAtVersion(maximal, visible)

      eventStream.emit({ type: `lookup`, key, snapshotTs: st, result })
      return result
    },

    doUpdate(txnId: TxnId, key: Key, st: Timestamp, effect: Effect): void {
      // Map store: doUpdate is a no-op (deferred to commit)
      eventStream.emit({ type: `update`, txnId, key, effect })
    },

    doAbort(txnId: TxnId, _st: Timestamp): void {
      // Map store: doAbort is a no-op
      eventStream.emit({ type: `abort`, txnId })
    },

    doCommit(
      txnId: TxnId,
      st: Timestamp,
      effectBuffer: EffectBuffer,
      ct: Timestamp
    ): void {
      // Add versions for each key in effect buffer
      for (const [key, effect] of effectBuffer) {
        if (!isBottom(effect)) {
          let keyVersions = state.versions.get(key)
          if (!keyVersions) {
            keyVersions = new Map()
            state.versions.set(key, keyVersions)
          }
          keyVersions.set(ct, { depTs: st, effect })
        }
      }

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
  }
}

// =============================================================================
// Journal Store (Figure 6)
// =============================================================================

/**
 * Create a journal store.
 * Implements the semantics from Figure 6.
 *
 * The journal is an append-only log of records.
 * This is the natural fit for durable streams!
 */
export function createJournalStore(): StreamStore {
  const records: Array<JournalRecord> = []
  const eventStream = createEventStream()
  let lsn = 0

  /**
   * Get the transaction's begin record.
   */
  function _getBeginRecord(txnId: TxnId): BeginTxnRecord | undefined {
    for (const record of records) {
      if (record.recordType === `beginTxn` && record.txnId === txnId) {
        return record
      }
    }
    return undefined
  }

  /**
   * Check if a transaction is committed.
   */
  function isCommitted(txnId: TxnId): boolean {
    for (const record of records) {
      if (record.recordType === `commit` && record.txnId === txnId) {
        return true
      }
    }
    return false
  }

  /**
   * Check if a transaction is aborted.
   */
  function _isAborted(txnId: TxnId): boolean {
    for (const record of records) {
      if (record.recordType === `abort` && record.txnId === txnId) {
        return true
      }
    }
    return false
  }

  /**
   * Get commit timestamp for a transaction.
   */
  function _getCommitTs(txnId: TxnId): Timestamp | undefined {
    for (const record of records) {
      if (record.recordType === `commit` && record.txnId === txnId) {
        return record.commitTs
      }
    }
    return undefined
  }

  /**
   * Compute poststate for a key after a record (Figure 6).
   * This is the core lookup algorithm for journals.
   */
  function poststate(recordIndex: number, key: Key): EffectOrBottom {
    const record = records[recordIndex]
    if (!record) return BOTTOM

    switch (record.recordType) {
      case `beginTxn`: {
        // merge({ poststate(r', k) : r' ∈ parent(r) })
        // Parents are commit records with ct < st
        const parentEffects: Array<EffectOrBottom> = []
        for (let i = 0; i < recordIndex; i++) {
          const r = records[i]
          if (
            r?.recordType === `commit` &&
            r.commitTs < record.snapshotTs &&
            isCommitted(r.txnId)
          ) {
            // Check if this is a maximal parent (no other commit between)
            const isMaximal = !records
              .slice(0, recordIndex)
              .some(
                (other) =>
                  other.recordType === `commit` &&
                  other !== r &&
                  r.commitTs < other.commitTs &&
                  other.commitTs < record.snapshotTs
              )
            if (isMaximal) {
              parentEffects.push(poststate(i, key))
            }
          }
        }
        return mergeEffectSet(parentEffects)
      }

      case `update`: {
        // Find parent (previous record in same transaction)
        let parentIndex = -1
        for (let i = recordIndex - 1; i >= 0; i--) {
          if (records[i]?.txnId === record.txnId) {
            parentIndex = i
            break
          }
        }
        if (parentIndex < 0) return BOTTOM

        const parentVal = poststate(parentIndex, key)
        if (record.key === key) {
          return composeEffects(parentVal, record.effect)
        }
        return parentVal
      }

      case `commit`:
      case `abort`: {
        // Find parent (previous record in same transaction)
        let parentIndex = -1
        for (let i = recordIndex - 1; i >= 0; i--) {
          if (records[i]?.txnId === record.txnId) {
            parentIndex = i
            break
          }
        }
        if (parentIndex < 0) return BOTTOM
        return poststate(parentIndex, key)
      }
    }
  }

  return {
    doBegin(txnId: TxnId, st: Timestamp): void {
      const record: BeginTxnRecord = {
        recordType: `beginTxn`,
        txnId,
        snapshotTs: st,
        lsn: lsn++,
      }
      records.push(record)
      eventStream.emit({ type: `begin`, txnId, snapshotTs: st })
    },

    lookup(key: Key, st: Timestamp): EffectOrBottom {
      // Find the begin record with this snapshot timestamp
      let beginIndex = -1
      for (let i = 0; i < records.length; i++) {
        const record = records[i]
        if (record?.recordType === `beginTxn` && record.snapshotTs === st) {
          beginIndex = i
          break
        }
      }

      if (beginIndex < 0) {
        // No matching begin - compute from committed effects up to st
        const effects: Array<EffectOrBottom> = []
        for (let i = 0; i < records.length; i++) {
          const record = records[i]
          if (record?.recordType === `commit` && record.commitTs < st) {
            effects.push(poststate(i, key))
          }
        }
        const result = mergeEffectSet(effects)
        eventStream.emit({ type: `lookup`, key, snapshotTs: st, result })
        return result
      }

      const result = poststate(beginIndex, key)
      eventStream.emit({ type: `lookup`, key, snapshotTs: st, result })
      return result
    },

    doUpdate(txnId: TxnId, key: Key, st: Timestamp, effect: Effect): void {
      const record: UpdateRecord = {
        recordType: `update`,
        txnId,
        key,
        effect,
        lsn: lsn++,
      }
      records.push(record)
      eventStream.emit({ type: `update`, txnId, key, effect })
    },

    doAbort(txnId: TxnId, _st: Timestamp): void {
      const record: AbortRecord = {
        recordType: `abort`,
        txnId,
        lsn: lsn++,
      }
      records.push(record)
      eventStream.emit({ type: `abort`, txnId })
    },

    doCommit(
      txnId: TxnId,
      st: Timestamp,
      effectBuffer: EffectBuffer,
      ct: Timestamp
    ): void {
      const record: CommitRecord = {
        recordType: `commit`,
        txnId,
        commitTs: ct,
        lsn: lsn++,
      }
      records.push(record)
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

    recover(events: Iterable<StoreEvent>): void {
      // Replay events to reconstruct journal
      for (const event of events) {
        switch (event.type) {
          case `begin`:
            records.push({
              recordType: `beginTxn`,
              txnId: event.txnId,
              snapshotTs: event.snapshotTs,
              lsn: lsn++,
            })
            break
          case `update`:
            records.push({
              recordType: `update`,
              txnId: event.txnId,
              key: event.key,
              effect: event.effect,
              lsn: lsn++,
            })
            break
          case `abort`:
            records.push({
              recordType: `abort`,
              txnId: event.txnId,
              lsn: lsn++,
            })
            break
          case `commit`:
            records.push({
              recordType: `commit`,
              txnId: event.txnId,
              commitTs: event.commitTs,
              lsn: lsn++,
            })
            break
        }
      }
    },
  }
}

// =============================================================================
// Composed Store (WAL + MemTable pattern)
// =============================================================================

/**
 * Window - describes the timestamp domain of a ministore.
 */
export interface StoreWindow {
  readonly low: Timestamp // Inclusive
  readonly high: Timestamp // Exclusive (or Infinity for live)
}

/**
 * Ministore in a composed store.
 */
export interface Ministore {
  readonly store: StreamStore
  readonly window: StoreWindow
}

/**
 * Create a composed store (e.g., WAL pattern: journal + map).
 *
 * The composed store follows "write all, read one":
 * - doX methods write to ALL ministores in window
 * - lookup reads from the FASTEST ministore (typically map)
 */
export function createComposedStore(ministores: Array<Ministore>): StreamStore {
  const eventStream = createEventStream()

  /**
   * Get ministores that contain a timestamp.
   */
  function getMinistoresForTs(ts: Timestamp): Array<Ministore> {
    return ministores.filter((m) => ts >= m.window.low && ts < m.window.high)
  }

  /**
   * Get ministores ordered by window (most recent first).
   */
  function getOrderedMinistores(): Array<Ministore> {
    return [...ministores].sort((a, b) => b.window.high - a.window.high)
  }

  return {
    doBegin(txnId: TxnId, st: Timestamp): void {
      // Write to all ministores in window
      for (const m of getMinistoresForTs(st)) {
        m.store.doBegin(txnId, st)
      }
      eventStream.emit({ type: `begin`, txnId, snapshotTs: st })
    },

    lookup(key: Key, st: Timestamp): EffectOrBottom {
      // Read from ministores in order, accumulating effects
      const ordered = getOrderedMinistores()
      let result: EffectOrBottom = BOTTOM
      let _foundAssignment = false

      for (const m of ordered) {
        if (st >= m.window.low && st < m.window.high) {
          const effect = m.store.lookup(key, st)
          if (!isBottom(effect)) {
            result = composeEffects(result, effect)
            if (isAssignment(effect)) {
              _foundAssignment = true
              break // Assignment masks earlier effects
            }
          }
        }
      }

      eventStream.emit({ type: `lookup`, key, snapshotTs: st, result })
      return result
    },

    doUpdate(txnId: TxnId, key: Key, st: Timestamp, effect: Effect): void {
      for (const m of getMinistoresForTs(st)) {
        m.store.doUpdate(txnId, key, st, effect)
      }
      eventStream.emit({ type: `update`, txnId, key, effect })
    },

    doAbort(txnId: TxnId, _st: Timestamp): void {
      for (const m of getMinistoresForTs(st)) {
        m.store.doAbort(txnId, st)
      }
      eventStream.emit({ type: `abort`, txnId })
    },

    doCommit(
      txnId: TxnId,
      st: Timestamp,
      effectBuffer: EffectBuffer,
      ct: Timestamp
    ): void {
      for (const m of getMinistoresForTs(ct)) {
        m.store.doCommit(txnId, st, effectBuffer, ct)
      }
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
  }
}

// =============================================================================
// WAL-MemTable Pair (RocksDB pattern)
// =============================================================================

/**
 * Create a WAL-MemTable pair.
 * - WAL (journal): persists updates for crash recovery
 * - MemTable (map): serves reads with low latency
 *
 * This is the fundamental unit of the LSM tree live level.
 */
export function createWALMemtablePair(): StreamStore & {
  getWAL: () => StreamStore
  getMemTable: () => StreamStore
  checkpoint: () => StreamStore
} {
  const wal = createJournalStore()
  const memtable = createMapStore()
  const eventStream = createEventStream()

  const composed: StreamStore & {
    getWAL: () => StreamStore
    getMemTable: () => StreamStore
    checkpoint: () => StreamStore
  } = {
    doBegin(txnId: TxnId, st: Timestamp): void {
      wal.doBegin(txnId, st)
      memtable.doBegin(txnId, st)
      eventStream.emit({ type: `begin`, txnId, snapshotTs: st })
    },

    lookup(key: Key, st: Timestamp): EffectOrBottom {
      // Read from memtable (fast path)
      const result = memtable.lookup(key, st)
      eventStream.emit({ type: `lookup`, key, snapshotTs: st, result })
      return result
    },

    doUpdate(txnId: TxnId, key: Key, st: Timestamp, effect: Effect): void {
      // Write to WAL only (memtable updates on commit)
      wal.doUpdate(txnId, key, st, effect)
      eventStream.emit({ type: `update`, txnId, key, effect })
    },

    doAbort(txnId: TxnId, _st: Timestamp): void {
      wal.doAbort(txnId, st)
      memtable.doAbort(txnId, st)
      eventStream.emit({ type: `abort`, txnId })
    },

    doCommit(
      txnId: TxnId,
      st: Timestamp,
      effectBuffer: EffectBuffer,
      ct: Timestamp
    ): void {
      // Write to both WAL and memtable
      wal.doCommit(txnId, st, effectBuffer, ct)
      memtable.doCommit(txnId, st, effectBuffer, ct)
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

    getWAL(): StreamStore {
      return wal
    },

    getMemTable(): StreamStore {
      return memtable
    },

    checkpoint(): StreamStore {
      // Create a new map store with current state
      // In production, this would write to disk
      return memtable
    },
  }

  return composed
}

// =============================================================================
// Trace-Building Store
// =============================================================================

/**
 * Create a trace-building store.
 * Records all operations as trace nodes for verification.
 */
export function createTraceBuildingStore(): StreamStore & {
  getTrace: () => Trace
} {
  // Import dynamically to avoid circular dependency

  const { createTraceRecorder } = require(`./trace`) as {
    createTraceRecorder: () => TraceRecorder
  }
  const recorder = createTraceRecorder()
  const eventStream = createEventStream()
  const effectBuffers = new Map<TxnId, EffectBuffer>()
  const snapshotTimestamps = new Map<TxnId, Timestamp>()

  return {
    doBegin(txnId: TxnId, st: Timestamp): void {
      recorder.recordBegin(txnId, st)
      effectBuffers.set(txnId, new Map())
      snapshotTimestamps.set(txnId, st)
      eventStream.emit({ type: `begin`, txnId, snapshotTs: st })
    },

    lookup(key: Key, st: Timestamp): EffectOrBottom {
      const { valAt } = require(`./trace`) as { valAt: ValAtFn }
      const trace = recorder.getTrace()

      // Find the begin node with this snapshot timestamp
      for (const node of trace.nodes) {
        if (node.nodeType === `begin` && node.snapshotTs === st) {
          const result = valAt(trace, node, key)
          eventStream.emit({ type: `lookup`, key, snapshotTs: st, result })
          return result
        }
      }

      // No matching begin - return BOTTOM
      eventStream.emit({ type: `lookup`, key, snapshotTs: st, result: BOTTOM })
      return BOTTOM
    },

    doUpdate(txnId: TxnId, key: Key, st: Timestamp, effect: Effect): void {
      recorder.recordUpdate(txnId, key, effect)

      // Track in effect buffer
      const buffer = effectBuffers.get(txnId) ?? new Map()
      const current = buffer.get(key) ?? BOTTOM
      buffer.set(key, composeEffects(current, effect))
      effectBuffers.set(txnId, buffer)

      eventStream.emit({ type: `update`, txnId, key, effect })
    },

    doAbort(txnId: TxnId, _st: Timestamp): void {
      recorder.recordAbort(txnId)
      effectBuffers.delete(txnId)
      snapshotTimestamps.delete(txnId)
      eventStream.emit({ type: `abort`, txnId })
    },

    doCommit(
      txnId: TxnId,
      st: Timestamp,
      effectBuffer: EffectBuffer,
      ct: Timestamp
    ): void {
      recorder.recordCommit(txnId, st, ct, effectBuffer)
      effectBuffers.delete(txnId)
      snapshotTimestamps.delete(txnId)
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

    getTrace() {
      return recorder.getTrace()
    },
  }
}

// =============================================================================
// Store Verification
// =============================================================================

/**
 * Verify that two stores are equivalent for a set of operations.
 * Used to test that store implementations are correct.
 */
export function verifyStoreEquivalence(
  store1: StoreInterface,
  store2: StoreInterface,
  operations: Array<
    | { op: `begin`; txnId: TxnId; st: Timestamp }
    | { op: `update`; txnId: TxnId; key: Key; st: Timestamp; effect: Effect }
    | { op: `lookup`; key: Key; st: Timestamp }
    | { op: `abort`; txnId: TxnId; st: Timestamp }
    | {
        op: `commit`
        txnId: TxnId
        st: Timestamp
        effectBuffer: EffectBuffer
        ct: Timestamp
      }
  >
): { equivalent: boolean; differences: Array<string> } {
  const differences: Array<string> = []

  for (const op of operations) {
    switch (op.op) {
      case `begin`:
        store1.doBegin(op.txnId, op.st)
        store2.doBegin(op.txnId, op.st)
        break

      case `update`:
        store1.doUpdate(op.txnId, op.key, op.st, op.effect)
        store2.doUpdate(op.txnId, op.key, op.st, op.effect)
        break

      case `lookup`: {
        const result1 = store1.lookup(op.key, op.st)
        const result2 = store2.lookup(op.key, op.st)
        if (JSON.stringify(result1) !== JSON.stringify(result2)) {
          differences.push(
            `lookup(${op.key}, ${op.st}): store1=${JSON.stringify(result1)}, store2=${JSON.stringify(result2)}`
          )
        }
        break
      }

      case `abort`:
        store1.doAbort(op.txnId, op.st)
        store2.doAbort(op.txnId, op.st)
        break

      case `commit`:
        store1.doCommit(op.txnId, op.st, op.effectBuffer, op.ct)
        store2.doCommit(op.txnId, op.st, op.effectBuffer, op.ct)
        break
    }
  }

  return {
    equivalent: differences.length === 0,
    differences,
  }
}
