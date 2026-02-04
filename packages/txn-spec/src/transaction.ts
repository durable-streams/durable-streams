/**
 * Transaction Module
 *
 * Implements the transaction lifecycle from the formal specification (Figure 1):
 * - BeginTxn: Start a new transaction with snapshot timestamp
 * - Update: Apply an effect to a key
 * - Read: Read a key's value (with read-my-writes)
 * - Abort: Terminate without committing
 * - Commit: Terminate and make effects visible
 *
 * This module also implements:
 * - Transaction descriptors
 * - No-inversion check (prevents timestamp inversion bug)
 * - Transaction sets (Xa, Xc, Xr for aborted, committed, running)
 */

import { BOTTOM, isBottom } from "./types"
import { applyEffect, composeEffects, isAssignment } from "./effects"
import type {
  Bottom,
  Effect,
  EffectBuffer,
  EffectOrBottom,
  InitSet,
  Key,
  ReadBuffer,
  Timestamp,
  TxnDescriptor,
  TxnId,
  TxnStatus,
  Value,
} from "./types"

// =============================================================================
// Transaction Descriptor Operations
// =============================================================================

/**
 * Create a new transaction descriptor.
 */
export function createTxnDescriptor(
  id: TxnId,
  snapshotTs: Timestamp
): TxnDescriptor {
  return {
    id,
    snapshotTs,
    initSet: new Set(),
    readBuffer: new Map(),
    effectBuffer: new Map(),
    commitTs: undefined,
    status: `running`,
  }
}

/**
 * Clone a transaction descriptor with modifications.
 */
export function updateTxnDescriptor(
  txn: TxnDescriptor,
  updates: Partial<{
    initSet: InitSet
    readBuffer: ReadBuffer
    effectBuffer: EffectBuffer
    commitTs: Timestamp
    status: TxnStatus
  }>
): TxnDescriptor {
  return {
    ...txn,
    initSet: updates.initSet ?? new Set(txn.initSet),
    readBuffer: updates.readBuffer ?? new Map(txn.readBuffer),
    effectBuffer: updates.effectBuffer ?? new Map(txn.effectBuffer),
    commitTs: updates.commitTs ?? txn.commitTs,
    status: updates.status ?? txn.status,
  }
}

// =============================================================================
// Transaction Sets (Global State)
// =============================================================================

/**
 * Global transaction state.
 * (σ, Xa, Xc, Xr) - store and transaction sets
 */
export interface TransactionState {
  /** Aborted transactions */
  aborted: Map<TxnId, TxnDescriptor>
  /** Committed transactions */
  committed: Map<TxnId, TxnDescriptor>
  /** Running transactions */
  running: Map<TxnId, TxnDescriptor>
}

/**
 * Create initial transaction state.
 */
export function createTransactionState(): TransactionState {
  return {
    aborted: new Map(),
    committed: new Map(),
    running: new Map(),
  }
}

// =============================================================================
// Timestamp Generator (Algorithm 1 from paper)
// =============================================================================

/**
 * Timestamp generator for safe commit ordering.
 * Implements the two-phase protocol from Algorithm 1:
 * - minAllowedCt: minimum allowed commit timestamp
 * - maxAllowedSt: maximum allowed snapshot timestamp
 * - Invariant: minAllowedCt ≮ maxAllowedSt (no inversion)
 */
export interface TimestampGenerator {
  /** Get the next available timestamp for beginning a transaction */
  nextSnapshotTs: () => Timestamp
  /** Reserve a commit timestamp */
  reserveCommitTs: () => Timestamp
  /** Finalize a commit and potentially advance snapshot timestamp */
  finalizeCommit: (ct: Timestamp) => void
  /** Get current state for inspection */
  getState: () => {
    minAllowedCt: Timestamp
    maxAllowedSt: Timestamp
    pendingCommits: Set<Timestamp>
  }
}

/**
 * Create a timestamp generator.
 */
export function createTimestampGenerator(): TimestampGenerator {
  let minAllowedCt = 0
  let maxAllowedSt = 0
  const pendingCommits = new Set<Timestamp>()

  return {
    nextSnapshotTs(): Timestamp {
      return maxAllowedSt
    },

    reserveCommitTs(): Timestamp {
      const ct = minAllowedCt++
      pendingCommits.add(ct)
      return ct
    },

    finalizeCommit(ct: Timestamp): void {
      pendingCommits.delete(ct)
      // Advance maxAllowedSt if no earlier pending commits
      if (pendingCommits.size === 0) {
        maxAllowedSt = minAllowedCt
      } else {
        // Find minimum pending commit
        const minPending = Math.min(...pendingCommits)
        maxAllowedSt = minPending
      }
    },

    getState() {
      return {
        minAllowedCt,
        maxAllowedSt,
        pendingCommits: new Set(pendingCommits),
      }
    },
  }
}

// =============================================================================
// No-Inversion Check
// =============================================================================

/**
 * Check the no-inversion condition for a commit.
 * noInversion(ct, Xc, Xr) = ∀X ∈ Xc ∪ Xr: ct ≮ X.st
 *
 * This prevents the timestamp inversion bug where a commit with a lower
 * timestamp appears after a begin with a higher snapshot timestamp.
 *
 * @param ct Commit timestamp
 * @param committed Set of committed transactions
 * @param running Set of running transactions
 * @returns true if no inversion would occur
 */
export function noInversion(
  ct: Timestamp,
  committed: Map<TxnId, TxnDescriptor>,
  running: Map<TxnId, TxnDescriptor>
): boolean {
  // Check all committed transactions
  for (const txn of committed.values()) {
    if (ct < txn.snapshotTs) {
      return false
    }
  }

  // Check all running transactions
  for (const txn of running.values()) {
    if (ct < txn.snapshotTs) {
      return false
    }
  }

  return true
}

/**
 * Check no-inversion and return the violating transaction if any.
 */
export function checkNoInversion(
  ct: Timestamp,
  committed: Map<TxnId, TxnDescriptor>,
  running: Map<TxnId, TxnDescriptor>
): { valid: true } | { valid: false; violatingTxn: TxnDescriptor } {
  for (const txn of committed.values()) {
    if (ct < txn.snapshotTs) {
      return { valid: false, violatingTxn: txn }
    }
  }

  for (const txn of running.values()) {
    if (ct < txn.snapshotTs) {
      return { valid: false, violatingTxn: txn }
    }
  }

  return { valid: true }
}

// =============================================================================
// Transaction Operations (Figure 1 Rules)
// =============================================================================

/**
 * Store interface for transaction operations.
 * The actual store implementation is pluggable.
 */
export interface StoreInterface {
  doBegin: (txnId: TxnId, st: Timestamp) => void
  lookup: (key: Key, st: Timestamp) => EffectOrBottom
  doUpdate: (txnId: TxnId, key: Key, st: Timestamp, effect: Effect) => void
  doAbort: (txnId: TxnId, st: Timestamp) => void
  doCommit: (
    txnId: TxnId,
    st: Timestamp,
    effectBuffer: EffectBuffer,
    ct: Timestamp
  ) => void
}

/**
 * Result of a transaction operation.
 */
export type TxnOperationResult<T = void> =
  | { success: true; value: T; state: TransactionState }
  | { success: false; error: string }

/**
 * Begin a new transaction.
 * Rule BeginTxn from Figure 1.
 *
 * Preconditions:
 * - τ must be unique (not in Xa ∪ Xc ∪ Xr)
 *
 * Effects:
 * - Calls store.doBegin
 * - Creates new descriptor in Xr
 */
export function beginTxn(
  state: TransactionState,
  store: StoreInterface,
  txnId: TxnId,
  snapshotTs: Timestamp
): TxnOperationResult<TxnDescriptor> {
  // Check τ is unique
  if (
    state.aborted.has(txnId) ||
    state.committed.has(txnId) ||
    state.running.has(txnId)
  ) {
    return {
      success: false,
      error: `Transaction ID ${txnId} already exists`,
    }
  }

  // Call store method
  store.doBegin(txnId, snapshotTs)

  // Create descriptor
  const descriptor = createTxnDescriptor(txnId, snapshotTs)

  // Update state
  const newRunning = new Map(state.running)
  newRunning.set(txnId, descriptor)

  return {
    success: true,
    value: descriptor,
    state: { ...state, running: newRunning },
  }
}

/**
 * Apply an update within a transaction.
 * Rule Update from Figure 1.
 *
 * Preconditions:
 * - Transaction must be running
 * - Effect must not be BOTTOM
 *
 * Effects:
 * - Calls store.doUpdate
 * - Updates effect buffer: B' = B[k ← B[k] ⊙ δ]
 */
export function update(
  state: TransactionState,
  store: StoreInterface,
  txnId: TxnId,
  key: Key,
  effect: Effect
): TxnOperationResult {
  const txn = state.running.get(txnId)
  if (!txn) {
    return {
      success: false,
      error: `Transaction ${txnId} is not running`,
    }
  }

  // Call store method
  store.doUpdate(txnId, key, txn.snapshotTs, effect)

  // Update effect buffer: B' = B[k ← B[k] ⊙ δ]
  const currentEffect = txn.effectBuffer.get(key) ?? BOTTOM
  const newEffect = composeEffects(currentEffect, effect)
  const newEffectBuffer = new Map(txn.effectBuffer)
  newEffectBuffer.set(key, newEffect)

  // Update descriptor
  const newTxn = updateTxnDescriptor(txn, { effectBuffer: newEffectBuffer })

  // Update state
  const newRunning = new Map(state.running)
  newRunning.set(txnId, newTxn)

  return {
    success: true,
    value: undefined,
    state: { ...state, running: newRunning },
  }
}

/**
 * Initialize read buffer for a key (ReadSnapshot rule).
 * This models a buffer miss - fires non-deterministically before Read.
 *
 * Preconditions:
 * - Transaction must be running
 * - Key must not already be initialized (k ∉ I)
 *
 * Effects:
 * - Calls store.lookup
 * - Updates: I' = I ∪ {k}, R' = R[k ← δ]
 */
export function readSnapshot(
  state: TransactionState,
  store: StoreInterface,
  txnId: TxnId,
  key: Key
): TxnOperationResult<EffectOrBottom> {
  const txn = state.running.get(txnId)
  if (!txn) {
    return {
      success: false,
      error: `Transaction ${txnId} is not running`,
    }
  }

  if (txn.initSet.has(key)) {
    return {
      success: false,
      error: `Key ${key} already initialized in transaction ${txnId}`,
    }
  }

  // Lookup from store
  const effect = store.lookup(key, txn.snapshotTs)

  // Update init set and read buffer
  const newInitSet = new Set(txn.initSet)
  newInitSet.add(key)
  const newReadBuffer = new Map(txn.readBuffer)
  newReadBuffer.set(key, effect)

  // Update descriptor
  const newTxn = updateTxnDescriptor(txn, {
    initSet: newInitSet,
    readBuffer: newReadBuffer,
  })

  // Update state
  const newRunning = new Map(state.running)
  newRunning.set(txnId, newTxn)

  return {
    success: true,
    value: effect,
    state: { ...state, running: newRunning },
  }
}

/**
 * Read a key's value within a transaction.
 * Rule Read from Figure 1.
 *
 * Preconditions:
 * - Transaction must be running
 * - Key must be initialized (k ∈ I)
 * - Result must be an assignment (can be converted to value)
 *
 * Effects:
 * - No state changes
 * - Returns: v = (R[k] ⊙ B[k])(⊥)
 */
export function read(
  state: TransactionState,
  txnId: TxnId,
  key: Key
): TxnOperationResult<Value | Bottom> {
  const txn = state.running.get(txnId)
  if (!txn) {
    return {
      success: false,
      error: `Transaction ${txnId} is not running`,
    }
  }

  if (!txn.initSet.has(key)) {
    return {
      success: false,
      error: `Key ${key} not initialized in transaction ${txnId}`,
    }
  }

  // Get snapshot value and transaction's effects
  const snapshotEffect = txn.readBuffer.get(key) ?? BOTTOM
  const txnEffect = txn.effectBuffer.get(key) ?? BOTTOM

  // Compose: R[k] ⊙ B[k]
  const composed = composeEffects(snapshotEffect, txnEffect)

  // Apply to BOTTOM to get value
  const value = applyEffect(composed, BOTTOM)

  return {
    success: true,
    value,
    state, // No state change
  }
}

/**
 * Read with assignment optimization (ReadAssignOpt rule).
 * If the transaction has assigned the key, skip lookup.
 *
 * Preconditions:
 * - Transaction must be running
 * - B[k] must be an assignment
 *
 * Effects:
 * - No state changes
 * - Returns: v = B[k](⊥)
 */
export function readAssignOpt(
  state: TransactionState,
  txnId: TxnId,
  key: Key
): TxnOperationResult<Value | Bottom> {
  const txn = state.running.get(txnId)
  if (!txn) {
    return {
      success: false,
      error: `Transaction ${txnId} is not running`,
    }
  }

  const txnEffect = txn.effectBuffer.get(key)
  if (!txnEffect || isBottom(txnEffect) || !isAssignment(txnEffect)) {
    return {
      success: false,
      error: `Key ${key} not assigned in transaction ${txnId}`,
    }
  }

  // Return assigned value directly
  return {
    success: true,
    value: txnEffect.value,
    state, // No state change
  }
}

/**
 * Abort a transaction.
 * Rule Abort from Figure 1.
 *
 * Preconditions:
 * - Transaction must be running
 *
 * Effects:
 * - Calls store.doAbort
 * - Moves descriptor from Xr to Xa
 */
export function abort(
  state: TransactionState,
  store: StoreInterface,
  txnId: TxnId
): TxnOperationResult {
  const txn = state.running.get(txnId)
  if (!txn) {
    return {
      success: false,
      error: `Transaction ${txnId} is not running`,
    }
  }

  // Call store method
  store.doAbort(txnId, txn.snapshotTs)

  // Update descriptor
  const abortedTxn = updateTxnDescriptor(txn, { status: `aborted` })

  // Move from running to aborted
  const newRunning = new Map(state.running)
  newRunning.delete(txnId)
  const newAborted = new Map(state.aborted)
  newAborted.set(txnId, abortedTxn)

  return {
    success: true,
    value: undefined,
    state: {
      ...state,
      running: newRunning,
      aborted: newAborted,
    },
  }
}

/**
 * Commit a transaction.
 * Rule Commit from Figure 1.
 *
 * Preconditions:
 * - Transaction must be running
 * - ct must be unique (not in any Xc)
 * - st ≤ ct
 * - noInversion(ct, Xc, Xr) must hold
 *
 * Effects:
 * - Calls store.doCommit
 * - Moves descriptor from Xr to Xc with ct set
 */
export function commit(
  state: TransactionState,
  store: StoreInterface,
  txnId: TxnId,
  commitTs: Timestamp
): TxnOperationResult {
  const txn = state.running.get(txnId)
  if (!txn) {
    return {
      success: false,
      error: `Transaction ${txnId} is not running`,
    }
  }

  // Check ct is unique
  for (const committed of state.committed.values()) {
    if (committed.commitTs === commitTs) {
      return {
        success: false,
        error: `Commit timestamp ${commitTs} already used`,
      }
    }
  }

  // Check st ≤ ct
  if (txn.snapshotTs > commitTs) {
    return {
      success: false,
      error: `Commit timestamp ${commitTs} < snapshot timestamp ${txn.snapshotTs}`,
    }
  }

  // Check no-inversion (excluding self from running set)
  const runningWithoutSelf = new Map(state.running)
  runningWithoutSelf.delete(txnId)
  const inversionCheck = checkNoInversion(
    commitTs,
    state.committed,
    runningWithoutSelf
  )
  if (!inversionCheck.valid) {
    return {
      success: false,
      error: `Timestamp inversion: ct=${commitTs} < st=${inversionCheck.violatingTxn.snapshotTs} of txn ${inversionCheck.violatingTxn.id}`,
    }
  }

  // Call store method
  store.doCommit(txnId, txn.snapshotTs, txn.effectBuffer, commitTs)

  // Update descriptor
  const committedTxn = updateTxnDescriptor(txn, {
    status: `committed`,
    commitTs,
  })

  // Move from running to committed
  const newRunning = new Map(state.running)
  newRunning.delete(txnId)
  const newCommitted = new Map(state.committed)
  newCommitted.set(txnId, committedTxn)

  return {
    success: true,
    value: undefined,
    state: {
      ...state,
      running: newRunning,
      committed: newCommitted,
    },
  }
}

// =============================================================================
// Transaction Coordinator
// =============================================================================

/**
 * Transaction coordinator - manages transaction lifecycle.
 * Provides a high-level API over the individual operations.
 */
export interface TransactionCoordinator {
  /** Begin a new transaction */
  begin: (txnId?: TxnId, snapshotTs?: Timestamp) => TxnDescriptor

  /** Get a transaction by ID */
  get: (txnId: TxnId) => TxnDescriptor | undefined

  /** Update a key in a transaction */
  update: (txnId: TxnId, key: Key, effect: Effect) => void

  /** Read a key in a transaction */
  read: (txnId: TxnId, key: Key) => Value | Bottom

  /** Abort a transaction */
  abort: (txnId: TxnId) => void

  /** Commit a transaction, returns commit timestamp */
  commit: (txnId: TxnId, commitTs?: Timestamp) => Timestamp

  /** Get current state */
  getState: () => TransactionState

  /** Get timestamp generator state */
  getTimestampState: () => ReturnType<TimestampGenerator[`getState`]>
}

/**
 * Create a transaction coordinator.
 */
export function createTransactionCoordinator(
  store: StoreInterface
): TransactionCoordinator {
  let state = createTransactionState()
  const tsGen = createTimestampGenerator()
  let txnCounter = 0

  return {
    begin(txnId?: TxnId, snapshotTs?: Timestamp): TxnDescriptor {
      const id = txnId ?? `txn-${txnCounter++}`
      const st = snapshotTs ?? tsGen.nextSnapshotTs()
      const result = beginTxn(state, store, id, st)
      if (!result.success) {
        throw new Error(result.error)
      }
      state = result.state
      return result.value
    },

    get(txnId: TxnId): TxnDescriptor | undefined {
      return (
        state.running.get(txnId) ??
        state.committed.get(txnId) ??
        state.aborted.get(txnId)
      )
    },

    update(txnId: TxnId, key: Key, effect: Effect): void {
      const result = update(state, store, txnId, key, effect)
      if (!result.success) {
        throw new Error(result.error)
      }
      state = result.state
    },

    read(txnId: TxnId, key: Key): Value | Bottom {
      const txn = state.running.get(txnId)
      if (!txn) {
        throw new Error(`Transaction ${txnId} not running`)
      }

      // Initialize if needed
      if (!txn.initSet.has(key)) {
        const snapshotResult = readSnapshot(state, store, txnId, key)
        if (!snapshotResult.success) {
          throw new Error(snapshotResult.error)
        }
        state = snapshotResult.state
      }

      // Check for ReadAssignOpt
      const updatedTxn = state.running.get(txnId)!
      const txnEffect = updatedTxn.effectBuffer.get(key)
      if (txnEffect && !isBottom(txnEffect) && isAssignment(txnEffect)) {
        const optResult = readAssignOpt(state, txnId, key)
        if (optResult.success) {
          return optResult.value
        }
      }

      // Regular read
      const result = read(state, txnId, key)
      if (!result.success) {
        throw new Error(result.error)
      }
      return result.value
    },

    abort(txnId: TxnId): void {
      const result = abort(state, store, txnId)
      if (!result.success) {
        throw new Error(result.error)
      }
      state = result.state
    },

    commit(txnId: TxnId, commitTs?: Timestamp): Timestamp {
      const ct = commitTs ?? tsGen.reserveCommitTs()
      const result = commit(state, store, txnId, ct)
      if (!result.success) {
        // Release the commit timestamp if we reserved it
        if (commitTs === undefined) {
          tsGen.finalizeCommit(ct) // Clean up
        }
        throw new Error(result.error)
      }
      state = result.state
      tsGen.finalizeCommit(ct)
      return ct
    },

    getState(): TransactionState {
      return state
    },

    getTimestampState() {
      return tsGen.getState()
    },
  }
}
