/**
 * History-Based Verification
 *
 * Implements Elle-style consistency checking via dependency graph analysis.
 * Records execution histories and verifies they satisfy consistency models.
 *
 * Key concepts:
 * - History: A sequence of operations with invocations and completions
 * - Dependency Graph: Transactions as nodes, dependencies as edges
 * - WW (write-write): T1 writes x, T2 overwrites x
 * - WR (write-read): T1 writes x, T2 reads x (and sees T1's value)
 * - RW (read-write): T1 reads x, T2 writes x (anti-dependency)
 *
 * A history is serializable if its dependency graph is acyclic.
 *
 * @see https://github.com/jepsen-io/elle
 */

import { isBottom } from "./types"
import type { Bottom, Key, Timestamp, TxnId, Value } from "./types"

// =============================================================================
// History Types
// =============================================================================

/**
 * Operation types in a history
 */
export type OperationType = `read` | `write`

/**
 * Operation status
 */
export type OperationStatus = `invoke` | `ok` | `fail`

/**
 * A single operation in the history
 */
export interface HistoryOperation {
  /** Unique operation ID */
  id: number
  /** Transaction this operation belongs to */
  txnId: TxnId
  /** Type of operation */
  type: OperationType
  /** Key being accessed */
  key: Key
  /** Value written (for writes) or read (for reads) */
  value: Value | Bottom
  /** Operation status */
  status: OperationStatus
  /** Logical timestamp of the operation */
  timestamp: number
}

/**
 * Transaction info in the history
 */
export interface HistoryTransaction {
  txnId: TxnId
  snapshotTs: Timestamp
  commitTs?: Timestamp
  status: `pending` | `committed` | `aborted`
  operations: Array<HistoryOperation>
}

/**
 * A complete execution history
 */
export interface History {
  operations: Array<HistoryOperation>
  transactions: Map<TxnId, HistoryTransaction>
}

// =============================================================================
// History Builder
// =============================================================================

/**
 * Builder for recording execution histories
 */
export interface HistoryBuilder {
  /** Record a transaction begin */
  beginTxn: (txnId: TxnId, snapshotTs: Timestamp) => void

  /** Record a read operation */
  read: (txnId: TxnId, key: Key, value: Value | Bottom) => void

  /** Record a write operation */
  write: (txnId: TxnId, key: Key, value: Value | Bottom) => void

  /** Record a transaction commit */
  commit: (txnId: TxnId, commitTs: Timestamp) => void

  /** Record a transaction abort */
  abort: (txnId: TxnId) => void

  /** Get the recorded history */
  build: () => History
}

/**
 * Create a history builder
 */
export function createHistoryBuilder(): HistoryBuilder {
  const operations: Array<HistoryOperation> = []
  const transactions = new Map<TxnId, HistoryTransaction>()
  let operationCounter = 0
  let timestampCounter = 0

  return {
    beginTxn(txnId: TxnId, snapshotTs: Timestamp): void {
      transactions.set(txnId, {
        txnId,
        snapshotTs,
        status: `pending`,
        operations: [],
      })
    },

    read(txnId: TxnId, key: Key, value: Value | Bottom): void {
      const op: HistoryOperation = {
        id: operationCounter++,
        txnId,
        type: `read`,
        key,
        value,
        status: `ok`,
        timestamp: timestampCounter++,
      }
      operations.push(op)
      transactions.get(txnId)?.operations.push(op)
    },

    write(txnId: TxnId, key: Key, value: Value | Bottom): void {
      const op: HistoryOperation = {
        id: operationCounter++,
        txnId,
        type: `write`,
        key,
        value,
        status: `ok`,
        timestamp: timestampCounter++,
      }
      operations.push(op)
      transactions.get(txnId)?.operations.push(op)
    },

    commit(txnId: TxnId, commitTs: Timestamp): void {
      const txn = transactions.get(txnId)
      if (txn) {
        txn.commitTs = commitTs
        txn.status = `committed`
      }
    },

    abort(txnId: TxnId): void {
      const txn = transactions.get(txnId)
      if (txn) {
        txn.status = `aborted`
      }
    },

    build(): History {
      return { operations, transactions }
    },
  }
}

// =============================================================================
// Dependency Graph
// =============================================================================

/**
 * Edge types in the dependency graph
 */
export type DependencyType =
  | `ww` // write-write: T1 writes, T2 overwrites
  | `wr` // write-read: T1 writes, T2 reads T1's value
  | `rw` // read-write: T1 reads, T2 writes (anti-dependency)

/**
 * An edge in the dependency graph
 */
export interface DependencyEdge {
  from: TxnId
  to: TxnId
  type: DependencyType
  key: Key
}

/**
 * The dependency graph
 */
export interface DependencyGraph {
  /** Transaction IDs (nodes) */
  nodes: Array<TxnId>
  /** Dependencies (edges) */
  edges: Array<DependencyEdge>
}

/**
 * Build a dependency graph from a history
 *
 * For each key, we track:
 * - The sequence of writes (committed transactions that wrote to the key)
 * - Which transactions read which values
 *
 * Then we infer dependencies:
 * - WW: If T1 writes x, then T2 writes x, and T2's write is visible after T1's
 * - WR: If T1 writes x=v, and T2 reads x=v, then T2 depends on T1
 * - RW: If T1 reads x, and T2 writes x, and T2 is not visible to T1's read
 */
export function buildDependencyGraph(history: History): DependencyGraph {
  const nodes: Array<TxnId> = []
  const edges: Array<DependencyEdge> = []

  // Collect committed transactions
  const committedTxns: Array<HistoryTransaction> = []
  for (const txn of history.transactions.values()) {
    if (txn.status === `committed`) {
      committedTxns.push(txn)
      nodes.push(txn.txnId)
    }
  }

  // Sort by commit timestamp
  committedTxns.sort((a, b) => (a.commitTs ?? 0) - (b.commitTs ?? 0))

  // For each key, track writes in commit order
  const writesByKey = new Map<
    Key,
    Array<{ txn: HistoryTransaction; value: Value | Bottom }>
  >()

  for (const txn of committedTxns) {
    for (const op of txn.operations) {
      if (op.type === `write`) {
        const writes = writesByKey.get(op.key) ?? []
        writes.push({ txn, value: op.value })
        writesByKey.set(op.key, writes)
      }
    }
  }

  // Build WW edges: consecutive writes to the same key
  for (const [key, writes] of writesByKey) {
    for (let i = 1; i < writes.length; i++) {
      const prev = writes[i - 1]
      const curr = writes[i]
      // Check if curr could see prev (based on timestamps)
      if (
        prev.txn.commitTs !== undefined &&
        curr.txn.snapshotTs >= prev.txn.commitTs
      ) {
        edges.push({
          from: prev.txn.txnId,
          to: curr.txn.txnId,
          type: `ww`,
          key,
        })
      }
    }
  }

  // Build WR edges: T1 writes, T2 reads the written value
  for (const txn of committedTxns) {
    for (const op of txn.operations) {
      if (op.type === `read` && !isBottom(op.value)) {
        // Find which transaction wrote this value
        const writes = writesByKey.get(op.key) ?? []
        for (const write of writes) {
          // Check if this read could have seen this write
          if (
            write.txn.txnId !== txn.txnId &&
            write.txn.commitTs !== undefined &&
            txn.snapshotTs >= write.txn.commitTs &&
            valuesEqual(write.value, op.value)
          ) {
            edges.push({
              from: write.txn.txnId,
              to: txn.txnId,
              type: `wr`,
              key: op.key,
            })
            break // Only one write can be the source
          }
        }
      }
    }
  }

  // Build RW edges (anti-dependencies): T1 reads, T2 writes, T2 not visible to T1
  for (const reader of committedTxns) {
    for (const op of reader.operations) {
      if (op.type === `read`) {
        // Find writes that happened concurrently (not visible to reader)
        const writes = writesByKey.get(op.key) ?? []
        for (const write of writes) {
          if (
            write.txn.txnId !== reader.txnId &&
            write.txn.commitTs !== undefined &&
            reader.snapshotTs < write.txn.commitTs // Write not visible to reader
          ) {
            edges.push({
              from: reader.txnId,
              to: write.txn.txnId,
              type: `rw`,
              key: op.key,
            })
          }
        }
      }
    }
  }

  return { nodes, edges }
}

function valuesEqual(a: Value | Bottom, b: Value | Bottom): boolean {
  if (isBottom(a) && isBottom(b)) return true
  if (isBottom(a) || isBottom(b)) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

// =============================================================================
// Cycle Detection
// =============================================================================

/**
 * Check if the dependency graph has a cycle
 *
 * Uses Kahn's algorithm for topological sort.
 * If we can't sort all nodes, there's a cycle.
 */
export function hasCycle(graph: DependencyGraph): boolean {
  // Build adjacency list and in-degree count
  const adj = new Map<TxnId, Array<TxnId>>()
  const inDegree = new Map<TxnId, number>()

  for (const node of graph.nodes) {
    adj.set(node, [])
    inDegree.set(node, 0)
  }

  for (const edge of graph.edges) {
    adj.get(edge.from)?.push(edge.to)
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1)
  }

  // Kahn's algorithm
  const queue: Array<TxnId> = []
  for (const [node, degree] of inDegree) {
    if (degree === 0) queue.push(node)
  }

  let processed = 0
  while (queue.length > 0) {
    const node = queue.shift()!
    processed++

    for (const neighbor of adj.get(node) ?? []) {
      const newDegree = (inDegree.get(neighbor) ?? 1) - 1
      inDegree.set(neighbor, newDegree)
      if (newDegree === 0) {
        queue.push(neighbor)
      }
    }
  }

  // If we didn't process all nodes, there's a cycle
  return processed !== graph.nodes.length
}

/**
 * Find a cycle in the graph (if one exists)
 *
 * Returns the cycle as a list of transaction IDs, or null if no cycle.
 */
export function findCycle(graph: DependencyGraph): Array<TxnId> | null {
  const visited = new Set<TxnId>()
  const recursionStack = new Set<TxnId>()
  const parent = new Map<TxnId, TxnId>()

  // Build adjacency list
  const adj = new Map<TxnId, Array<TxnId>>()
  for (const node of graph.nodes) {
    adj.set(node, [])
  }
  for (const edge of graph.edges) {
    adj.get(edge.from)?.push(edge.to)
  }

  function dfs(node: TxnId): TxnId | null {
    visited.add(node)
    recursionStack.add(node)

    for (const neighbor of adj.get(node) ?? []) {
      if (!visited.has(neighbor)) {
        parent.set(neighbor, node)
        const cycleNode = dfs(neighbor)
        if (cycleNode) return cycleNode
      } else if (recursionStack.has(neighbor)) {
        // Found cycle - return the start of the cycle
        parent.set(neighbor, node)
        return neighbor
      }
    }

    recursionStack.delete(node)
    return null
  }

  for (const node of graph.nodes) {
    if (!visited.has(node)) {
      const cycleStart = dfs(node)
      if (cycleStart) {
        // Reconstruct cycle
        const cycle: Array<TxnId> = [cycleStart]
        let current = parent.get(cycleStart)
        while (current && current !== cycleStart) {
          cycle.push(current)
          current = parent.get(current)
        }
        cycle.push(cycleStart) // Complete the cycle
        return cycle.reverse()
      }
    }
  }

  return null
}

// =============================================================================
// Consistency Checking
// =============================================================================

/**
 * Checker metadata - documents soundness, completeness, and scope
 *
 * Following formal methods conventions:
 * - Sound: Never false positives (if it says "violation," there is one)
 * - Complete: Never false negatives (finds all violations in scope)
 *
 * Most practical checkers are sound but incomplete.
 */
export interface CheckerMetadata {
  name: string
  /** Sound = no false positives */
  soundness: `sound` | `unsound`
  /** Complete = finds all violations in scope */
  completeness: `complete` | `incomplete`
  /** What this checker covers */
  scope: string
  /** What this checker does NOT cover */
  limitations: Array<string>
}

/**
 * Metadata for the serializability checker
 */
export const SERIALIZABILITY_CHECKER: CheckerMetadata = {
  name: `Cycle-based Serializability`,
  soundness: `sound`,
  completeness: `incomplete`,
  scope: `Single-key read/write operations with known commit order`,
  limitations: [
    `Predicate-based anomalies (e.g., phantom reads)`,
    `Multi-key constraints`,
    `Operations without explicit read/write logging`,
  ],
}

/**
 * Metadata for the snapshot isolation checker
 */
export const SNAPSHOT_ISOLATION_CHECKER: CheckerMetadata = {
  name: `SI via WW/WR Graph`,
  soundness: `sound`,
  completeness: `incomplete`,
  scope: `Write-write and write-read conflicts`,
  limitations: [
    `Write skew detection (allowed by SI, but may indicate bugs)`,
    `Lost update anomalies under certain schedules`,
  ],
}

/**
 * Result of a consistency check
 */
export interface ConsistencyCheckResult {
  /** Whether the history satisfies the consistency model */
  valid: boolean
  /** Metadata about the checker used */
  checker: CheckerMetadata
  /** If invalid, describes the violation */
  violation?: {
    type: `cycle`
    cycle: Array<TxnId>
    edges: Array<DependencyEdge>
  }
  /** The dependency graph used for checking */
  graph: DependencyGraph
}

/**
 * Check if a history is serializable
 *
 * A history is serializable if its dependency graph is acyclic.
 * This is equivalent to strict serializability when real-time order is respected.
 */
export function checkSerializable(history: History): ConsistencyCheckResult {
  const graph = buildDependencyGraph(history)
  const checker = SERIALIZABILITY_CHECKER

  if (!hasCycle(graph)) {
    return { valid: true, checker, graph }
  }

  const cycle = findCycle(graph)
  if (!cycle) {
    // Shouldn't happen, but handle gracefully
    return { valid: false, checker, graph }
  }

  // Find edges in the cycle
  const cycleEdges: Array<DependencyEdge> = []
  for (let i = 0; i < cycle.length - 1; i++) {
    const from = cycle[i]
    const to = cycle[i + 1]
    const edge = graph.edges.find((e) => e.from === from && e.to === to)
    if (edge) cycleEdges.push(edge)
  }

  return {
    valid: false,
    checker,
    violation: {
      type: `cycle`,
      cycle,
      edges: cycleEdges,
    },
    graph,
  }
}

/**
 * Check if a history satisfies snapshot isolation
 *
 * Snapshot isolation allows certain anomalies that serializability forbids,
 * specifically write skew. We check for SI-specific violations.
 *
 * For SI, we only look at WW and WR dependencies (not RW anti-dependencies).
 */
export function checkSnapshotIsolation(
  history: History
): ConsistencyCheckResult {
  const fullGraph = buildDependencyGraph(history)
  const checker = SNAPSHOT_ISOLATION_CHECKER

  // For SI, only consider WW and WR edges
  const siGraph: DependencyGraph = {
    nodes: fullGraph.nodes,
    edges: fullGraph.edges.filter((e) => e.type === `ww` || e.type === `wr`),
  }

  if (!hasCycle(siGraph)) {
    return { valid: true, checker, graph: siGraph }
  }

  const cycle = findCycle(siGraph)
  if (!cycle) {
    return { valid: false, checker, graph: siGraph }
  }

  const cycleEdges: Array<DependencyEdge> = []
  for (let i = 0; i < cycle.length - 1; i++) {
    const from = cycle[i]
    const to = cycle[i + 1]
    const edge = siGraph.edges.find((e) => e.from === from && e.to === to)
    if (edge) cycleEdges.push(edge)
  }

  return {
    valid: false,
    checker,
    violation: {
      type: `cycle`,
      cycle,
      edges: cycleEdges,
    },
    graph: siGraph,
  }
}

// =============================================================================
// Utilities
// =============================================================================

/**
 * Format a dependency graph as a string for debugging
 */
export function formatGraph(graph: DependencyGraph): string {
  const lines: Array<string> = []
  lines.push(`Nodes: ${graph.nodes.join(`, `)}`)
  lines.push(`Edges:`)
  for (const edge of graph.edges) {
    lines.push(`  ${edge.from} --[${edge.type}:${edge.key}]--> ${edge.to}`)
  }
  return lines.join(`\n`)
}

/**
 * Format a consistency check result as a string
 */
export function formatCheckResult(result: ConsistencyCheckResult): string {
  const lines: Array<string> = []

  // Include checker metadata
  lines.push(`Checker: ${result.checker.name}`)
  lines.push(`  Soundness: ${result.checker.soundness}`)
  lines.push(`  Completeness: ${result.checker.completeness}`)
  lines.push(`  Scope: ${result.checker.scope}`)
  lines.push(``)

  if (result.valid) {
    lines.push(`VALID: History is consistent`)
    return lines.join(`\n`)
  }

  lines.push(`INVALID: Consistency violation detected`)

  if (result.violation) {
    lines.push(`  Type: ${result.violation.type}`)
    lines.push(`  Cycle: ${result.violation.cycle.join(` -> `)}`)
    lines.push(`  Edges:`)
    for (const edge of result.violation.edges) {
      lines.push(`    ${edge.from} --[${edge.type}:${edge.key}]--> ${edge.to}`)
    }
  }

  if (result.checker.limitations.length > 0) {
    lines.push(``)
    lines.push(`Note: This checker has limitations:`)
    for (const limitation of result.checker.limitations) {
      lines.push(`  - ${limitation}`)
    }
  }

  return lines.join(`\n`)
}
