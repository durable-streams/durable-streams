/**
 * Core Types for Transactional Storage Specification
 *
 * Based on the formal specification from "Formalising Transactional Storage Systems"
 * (CobbleDB paper targeting ASPLOS 2026)
 *
 * This module defines the fundamental types used throughout the specification:
 * - Keys, Values, Timestamps
 * - Effects (assignments and increments)
 * - Transaction descriptors
 * - Trace nodes and edges
 */

// =============================================================================
// Primitive Types
// =============================================================================

/**
 * Opaque key type - identifies a data item in the store.
 * Keys compare for equality only.
 */
export type Key = string

/**
 * Value type - the data associated with a key.
 * Can be any JSON-serializable value, or undefined (⊥) for absence.
 */
export type Value = unknown

/**
 * Timestamp type - partially ordered, used for versioning.
 * In this implementation we use scalar timestamps (numbers).
 * The theory also applies to vector timestamps.
 */
export type Timestamp = number

/**
 * Transaction identifier - unique per transaction.
 */
export type TxnId = string

/**
 * The null/bottom value (⊥) - represents absence of value or effect.
 */
export const BOTTOM: unique symbol = Symbol(`BOTTOM`)
export type Bottom = typeof BOTTOM

/**
 * Check if a value is bottom (⊥)
 */
export function isBottom(v: unknown): v is Bottom {
  return v === BOTTOM
}

// =============================================================================
// Effect Types
// =============================================================================

/**
 * Effect type enumeration.
 * An effect is a function from pre-value to post-value.
 */
export type EffectType = `assign` | `increment` | `delete` | `custom`

/**
 * Base effect interface.
 * Effects combine sequentially with ⊙ (apply) and concurrently with merge.
 */
export interface BaseEffect {
  readonly type: EffectType
}

/**
 * Assignment effect - a constant function that replaces the value.
 * δ_assign_v always yields v, even when applied to ⊥.
 * Assignments mask previous effects: ∀δ, (δ ⊙ δ_assign_x) = δ_assign_x
 */
export interface AssignEffect extends BaseEffect {
  readonly type: `assign`
  readonly value: Value
}

/**
 * Increment effect - adds to the current value.
 * For counters: δ_incr_n adds n to the current value.
 * Supports blind updates without read-modify-write.
 */
export interface IncrementEffect extends BaseEffect {
  readonly type: `increment`
  readonly delta: number
}

/**
 * Delete effect - removes the key (sets to ⊥).
 * Equivalent to assigning BOTTOM.
 */
export interface DeleteEffect extends BaseEffect {
  readonly type: `delete`
}

/**
 * Custom effect - user-defined effect with apply and merge functions.
 * Enables rich CRDT-like data types.
 */
export interface CustomEffect<T = unknown> extends BaseEffect {
  readonly type: `custom`
  readonly name: string
  readonly payload: T
  /**
   * Apply this effect to a value.
   */
  readonly apply: (value: Value | Bottom) => Value | Bottom
  /**
   * Merge this effect with another concurrent effect of the same type.
   */
  readonly merge: (other: CustomEffect<T>) => CustomEffect<T>
}

/**
 * Union type for all effects.
 */
export type Effect =
  | AssignEffect
  | IncrementEffect
  | DeleteEffect
  | CustomEffect

/**
 * Effect or bottom (⊥) - used in buffers where a key may not have an effect.
 */
export type EffectOrBottom = Effect | Bottom

// =============================================================================
// Buffer Types
// =============================================================================

/**
 * Read buffer - maps keys to their snapshot values (as effects).
 * R ∈ ReadBuf = Key → Effect⊥
 */
export type ReadBuffer = Map<Key, EffectOrBottom>

/**
 * Effect buffer - maps keys to the transaction's accumulated effects.
 * B ∈ EffectBuf = Key → Effect⊥
 */
export type EffectBuffer = Map<Key, EffectOrBottom>

/**
 * Init set - tracks which keys have been initialized in the read buffer.
 * I ∈ InitSet = P(Key)
 */
export type InitSet = Set<Key>

// =============================================================================
// Transaction Descriptor
// =============================================================================

/**
 * Transaction status.
 */
export type TxnStatus = `running` | `committed` | `aborted`

/**
 * Transaction descriptor - encapsulates all transaction state.
 * (τ, st, I, R, B, ct) ∈ TxnDesc
 */
export interface TxnDescriptor {
  /** Transaction identifier - unique */
  readonly id: TxnId
  /** Snapshot timestamp - when the transaction began */
  readonly snapshotTs: Timestamp
  /** Init set - keys initialized in read buffer */
  readonly initSet: InitSet
  /** Read buffer - snapshot values */
  readonly readBuffer: ReadBuffer
  /** Effect buffer - transaction's effects so far */
  readonly effectBuffer: EffectBuffer
  /** Commit timestamp - set when committed */
  readonly commitTs: Timestamp | undefined
  /** Transaction status */
  readonly status: TxnStatus
}

// =============================================================================
// Trace Node Types
// =============================================================================

/**
 * Node types in a trace graph.
 * Node = B ⊎ U ⊎ A ⊎ C
 */
export type NodeType = `begin` | `update` | `abort` | `commit`

/**
 * Base node interface.
 */
export interface BaseNode {
  readonly nodeType: NodeType
  readonly txnId: TxnId
}

/**
 * Begin node - starts a transaction.
 * Labels: τ, st
 */
export interface BeginNode extends BaseNode {
  readonly nodeType: `begin`
  readonly snapshotTs: Timestamp
}

/**
 * Update node - records an update within a transaction.
 * Labels: τ, k, δ
 */
export interface UpdateNode extends BaseNode {
  readonly nodeType: `update`
  readonly key: Key
  readonly effect: Effect
}

/**
 * Abort node - terminates a transaction without committing.
 * Labels: τ
 */
export interface AbortNode extends BaseNode {
  readonly nodeType: `abort`
}

/**
 * Commit node - terminates a transaction with commit.
 * Labels: τ, st, ct, B
 */
export interface CommitNode extends BaseNode {
  readonly nodeType: `commit`
  readonly snapshotTs: Timestamp
  readonly commitTs: Timestamp
  readonly effectBuffer: EffectBuffer
}

/**
 * Union type for all trace nodes.
 */
export type TraceNode = BeginNode | UpdateNode | AbortNode | CommitNode

// =============================================================================
// Trace Edge Types
// =============================================================================

/**
 * Edge in the trace graph.
 * Edges connect nodes in execution order within a transaction,
 * and connect commit nodes to begin nodes across transactions.
 */
export interface TraceEdge {
  readonly from: TraceNode
  readonly to: TraceNode
}

// =============================================================================
// Store Types
// =============================================================================

/**
 * Version in a map store.
 * Maps (key, version_timestamp) to (dependency_timestamp, effect).
 */
export interface MapVersion {
  readonly key: Key
  readonly versionTs: Timestamp
  readonly dependencyTs: Timestamp
  readonly effect: Effect
}

/**
 * Record types in a journal store.
 */
export type JournalRecordType = `beginTxn` | `update` | `abort` | `commit`

/**
 * Base journal record.
 */
export interface BaseJournalRecord {
  readonly recordType: JournalRecordType
  readonly txnId: TxnId
  /** Log Sequence Number - position in the journal */
  readonly lsn: number
}

/**
 * Begin transaction record.
 */
export interface BeginTxnRecord extends BaseJournalRecord {
  readonly recordType: `beginTxn`
  readonly snapshotTs: Timestamp
}

/**
 * Update record.
 */
export interface UpdateRecord extends BaseJournalRecord {
  readonly recordType: `update`
  readonly key: Key
  readonly effect: Effect
}

/**
 * Abort record.
 */
export interface AbortRecord extends BaseJournalRecord {
  readonly recordType: `abort`
}

/**
 * Commit record.
 */
export interface CommitRecord extends BaseJournalRecord {
  readonly recordType: `commit`
  readonly commitTs: Timestamp
}

/**
 * Union type for all journal records.
 */
export type JournalRecord =
  | BeginTxnRecord
  | UpdateRecord
  | AbortRecord
  | CommitRecord

// =============================================================================
// Ordered Timestamp Pairs (OTSPs)
// =============================================================================

/**
 * Ordered Timestamp Pair (OTSP) - represents [d, w] where d ≤ w.
 * Can represent snapshot/commit timestamps of a transaction,
 * or dependency/version timestamps of a store version.
 */
export interface OTSP {
  readonly low: Timestamp
  readonly high: Timestamp
}

/**
 * Create an OTSP from two timestamps.
 * Throws if low > high.
 */
export function createOTSP(low: Timestamp, high: Timestamp): OTSP {
  if (low > high) {
    throw new Error(`Invalid OTSP: low (${low}) > high (${high})`)
  }
  return { low, high }
}

/**
 * Check if two OTSPs are concurrent (their ranges overlap).
 * (d1, w1) ∥_OTSP (d2, w2) iff [d1, w1] ∩ [d2, w2] ≠ ∅
 */
export function otspsAreConcurrent(a: OTSP, b: OTSP): boolean {
  // Not concurrent if one strictly precedes the other
  // a ≺ b means a.high < b.low
  // b ≺ a means b.high < a.low
  const aPrecedesB = a.high < b.low
  const bPrecedesA = b.high < a.low
  return !aPrecedesB && !bPrecedesA
}

/**
 * Check if OTSP a precedes OTSP b.
 * (d1, w1) ≺_OTSP (d2, w2) iff w1 < d2
 */
export function otspPrecedes(a: OTSP, b: OTSP): boolean {
  return a.high < b.low
}
