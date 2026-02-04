/**
 * Trace Module
 *
 * Implements the trace representation from the formal specification:
 * - A trace is a DAG depicting relations between transactions
 * - Nodes: Begin, Update, Abort, Commit
 * - Edges: Within-transaction (execution order) and cross-transaction (visibility)
 * - Valuation: Computes the correct value of a key at any node
 *
 * Key concepts:
 * - Visibility order (≺): n1 ≺ n2 iff there's a path from n1 to n2
 * - Concurrent nodes: not mutually ordered by visibility
 * - Valuation (valAt): effect representing state at a node
 */

import { BOTTOM } from "./types"
import { composeEffects, mergeEffectSet } from "./effects"
import type {
  AbortNode,
  BeginNode,
  CommitNode,
  Effect,
  EffectBuffer,
  EffectOrBottom,
  Key,
  Timestamp,
  TraceEdge,
  TraceNode,
  TxnId,
  UpdateNode,
} from "./types"

// =============================================================================
// Node Constructors
// =============================================================================

/**
 * Create a begin node.
 */
export function beginNode(txnId: TxnId, snapshotTs: Timestamp): BeginNode {
  return {
    nodeType: `begin`,
    txnId,
    snapshotTs,
  }
}

/**
 * Create an update node.
 */
export function updateNode(txnId: TxnId, key: Key, effect: Effect): UpdateNode {
  return {
    nodeType: `update`,
    txnId,
    key,
    effect,
  }
}

/**
 * Create an abort node.
 */
export function abortNode(txnId: TxnId): AbortNode {
  return {
    nodeType: `abort`,
    txnId,
  }
}

/**
 * Create a commit node.
 */
export function commitNode(
  txnId: TxnId,
  snapshotTs: Timestamp,
  commitTs: Timestamp,
  effectBuffer: EffectBuffer
): CommitNode {
  return {
    nodeType: `commit`,
    txnId,
    snapshotTs,
    commitTs,
    effectBuffer,
  }
}

// =============================================================================
// Trace Data Structure
// =============================================================================

/**
 * Trace - a DAG of transaction nodes.
 * G = (N, E) where N ⊆ Node and E ⊆ N × N
 */
export interface Trace {
  /** All nodes in the trace */
  readonly nodes: ReadonlySet<TraceNode>
  /** All edges in the trace */
  readonly edges: ReadonlySet<TraceEdge>
  /** Index: node -> children */
  readonly children: ReadonlyMap<TraceNode, Set<TraceNode>>
  /** Index: node -> parents */
  readonly parents: ReadonlyMap<TraceNode, Set<TraceNode>>
  /** Index: txnId -> nodes in that transaction */
  readonly txnNodes: ReadonlyMap<TxnId, Array<TraceNode>>
}

/**
 * Mutable trace builder.
 */
export interface TraceBuilder {
  /** Add a node to the trace */
  addNode: (node: TraceNode) => void
  /** Add an edge between nodes */
  addEdge: (from: TraceNode, to: TraceNode) => void
  /** Get the immutable trace */
  build: () => Trace
  /** Get current state (for inspection during building) */
  getTrace: () => Trace
}

/**
 * Create a trace builder.
 */
export function createTraceBuilder(): TraceBuilder {
  const nodes = new Set<TraceNode>()
  const edges = new Set<TraceEdge>()
  const children = new Map<TraceNode, Set<TraceNode>>()
  const parents = new Map<TraceNode, Set<TraceNode>>()
  const txnNodes = new Map<TxnId, Array<TraceNode>>()

  function ensureNodeMaps(node: TraceNode): void {
    if (!children.has(node)) children.set(node, new Set())
    if (!parents.has(node)) parents.set(node, new Set())
  }

  function getTrace(): Trace {
    return {
      nodes: new Set(nodes),
      edges: new Set(edges),
      children: new Map(children),
      parents: new Map(parents),
      txnNodes: new Map(txnNodes),
    }
  }

  return {
    addNode(node: TraceNode): void {
      nodes.add(node)
      ensureNodeMaps(node)

      // Index by transaction
      const existing = txnNodes.get(node.txnId) ?? []
      existing.push(node)
      txnNodes.set(node.txnId, existing)
    },

    addEdge(from: TraceNode, to: TraceNode): void {
      // Ensure both nodes exist
      if (!nodes.has(from)) {
        throw new Error(`Source node not in trace`)
      }
      if (!nodes.has(to)) {
        throw new Error(`Target node not in trace`)
      }

      edges.add({ from, to })
      children.get(from)!.add(to)
      parents.get(to)!.add(from)
    },

    build(): Trace {
      return getTrace()
    },

    getTrace,
  }
}

// =============================================================================
// Trace Queries
// =============================================================================

/**
 * Get all root nodes (nodes with no parents).
 */
export function getRoots(trace: Trace): Array<TraceNode> {
  const roots: Array<TraceNode> = []
  for (const node of trace.nodes) {
    const nodeParents = trace.parents.get(node)
    if (!nodeParents || nodeParents.size === 0) {
      roots.push(node)
    }
  }
  return roots
}

/**
 * Get parents of a node.
 */
export function getParents(trace: Trace, node: TraceNode): Set<TraceNode> {
  return trace.parents.get(node) ?? new Set()
}

/**
 * Get children of a node.
 */
export function getChildren(trace: Trace, node: TraceNode): Set<TraceNode> {
  return trace.children.get(node) ?? new Set()
}

/**
 * Check if n1 is visible to n2 (n1 ≺ n2).
 * Uses BFS to find path.
 */
export function isVisible(
  trace: Trace,
  from: TraceNode,
  to: TraceNode
): boolean {
  if (from === to) return false

  const visited = new Set<TraceNode>()
  const queue: Array<TraceNode> = [from]

  while (queue.length > 0) {
    const current = queue.shift()!
    if (current === to) return true
    if (visited.has(current)) continue
    visited.add(current)

    const nodeChildren = trace.children.get(current)
    if (nodeChildren) {
      for (const child of nodeChildren) {
        if (!visited.has(child)) {
          queue.push(child)
        }
      }
    }
  }

  return false
}

/**
 * Check if two nodes are concurrent (neither visible to the other).
 */
export function areConcurrent(
  trace: Trace,
  a: TraceNode,
  b: TraceNode
): boolean {
  return !isVisible(trace, a, b) && !isVisible(trace, b, a)
}

/**
 * Get all nodes visible to a given node (all ancestors).
 */
export function getVisibleNodes(trace: Trace, node: TraceNode): Set<TraceNode> {
  const visible = new Set<TraceNode>()
  const queue: Array<TraceNode> = [...getParents(trace, node)]

  while (queue.length > 0) {
    const current = queue.shift()!
    if (visible.has(current)) continue
    visible.add(current)

    for (const parent of getParents(trace, current)) {
      if (!visible.has(parent)) {
        queue.push(parent)
      }
    }
  }

  return visible
}

/**
 * Get all commit nodes visible to a given node.
 */
export function getVisibleCommits(
  trace: Trace,
  node: TraceNode
): Array<CommitNode> {
  const visible = getVisibleNodes(trace, node)
  const commits: Array<CommitNode> = []
  for (const n of visible) {
    if (n.nodeType === `commit`) {
      commits.push(n)
    }
  }
  return commits
}

// =============================================================================
// Topological Sort
// =============================================================================

/**
 * Topological sort of trace nodes.
 * Returns nodes in an order where all parents come before children.
 */
export function topologicalSort(trace: Trace): Array<TraceNode> {
  const result: Array<TraceNode> = []
  const visited = new Set<TraceNode>()
  const visiting = new Set<TraceNode>() // For cycle detection

  function visit(node: TraceNode): void {
    if (visited.has(node)) return
    if (visiting.has(node)) {
      throw new Error(`Cycle detected in trace - not a valid DAG`)
    }

    visiting.add(node)

    // Visit all parents first
    for (const parent of getParents(trace, node)) {
      visit(parent)
    }

    visiting.delete(node)
    visited.add(node)
    result.push(node)
  }

  for (const node of trace.nodes) {
    visit(node)
  }

  return result
}

// =============================================================================
// Valuation (Figure 4)
// =============================================================================

/**
 * Compute valuation of a key at a node.
 * valAt_G(n, k) - the effect representing state of key k at node n.
 *
 * From Figure 4:
 * - Begin node: merge({ valAt(m, k) : m ∈ parents(n) })
 * - Update node (different key): valAt(parent(n), k)
 * - Update node (same key): valAt(parent(n), k) ⊙ δ
 * - Abort/Commit node: valAt(parent(n), k)
 */
export function valAt(
  trace: Trace,
  node: TraceNode,
  key: Key,
  cache?: Map<TraceNode, EffectOrBottom>
): EffectOrBottom {
  // Use cache if provided
  const cacheKey = cache ? node : undefined
  if (cacheKey && cache?.has(cacheKey)) {
    return cache.get(cacheKey)!
  }

  let result: EffectOrBottom

  switch (node.nodeType) {
    case `begin`: {
      // merge({ valAt(m, k) : m ∈ parents(n) })
      const parentNodes = getParents(trace, node)
      if (parentNodes.size === 0) {
        // Root node
        result = BOTTOM
      } else {
        const parentEffects: Array<EffectOrBottom> = []
        for (const parent of parentNodes) {
          parentEffects.push(valAt(trace, parent, key, cache))
        }
        result = mergeEffectSet(parentEffects)
      }
      break
    }

    case `update`: {
      // Get the single parent
      const parentNodes = getParents(trace, node)
      if (parentNodes.size !== 1) {
        throw new Error(`Update node must have exactly one parent`)
      }
      const parent = [...parentNodes][0]!
      const parentVal = valAt(trace, parent, key, cache)

      if (node.key === key) {
        // valAt(parent(n), k) ⊙ δ
        result = composeEffects(parentVal, node.effect)
      } else {
        // valAt(parent(n), k)
        result = parentVal
      }
      break
    }

    case `abort`:
    case `commit`: {
      // valAt(parent(n), k)
      const parentNodes = getParents(trace, node)
      if (parentNodes.size !== 1) {
        throw new Error(`${node.nodeType} node must have exactly one parent`)
      }
      const parent = [...parentNodes][0]!
      result = valAt(trace, parent, key, cache)
      break
    }
  }

  // Cache result
  if (cacheKey && cache) {
    cache.set(cacheKey, result)
  }

  return result
}

/**
 * Compute valuation for all keys at a node.
 * Returns a map of key -> effect.
 */
export function valAtAll(
  trace: Trace,
  node: TraceNode,
  keys: Iterable<Key>
): Map<Key, EffectOrBottom> {
  const result = new Map<Key, EffectOrBottom>()
  const cache = new Map<TraceNode, EffectOrBottom>()

  for (const key of keys) {
    cache.clear() // Cache is per-key
    result.set(key, valAt(trace, node, key, cache))
  }

  return result
}

/**
 * Get all keys mentioned in a trace.
 */
export function getTraceKeys(trace: Trace): Set<Key> {
  const keys = new Set<Key>()
  for (const node of trace.nodes) {
    if (node.nodeType === `update`) {
      keys.add(node.key)
    } else if (node.nodeType === `commit`) {
      for (const key of node.effectBuffer.keys()) {
        keys.add(key)
      }
    }
  }
  return keys
}

// =============================================================================
// Trace Building from Transaction Semantics
// =============================================================================

/**
 * A trace-building store that records operations as nodes.
 * Used to verify that a store implementation matches the specification.
 */
export interface TraceRecorder {
  /** Record a begin transaction */
  recordBegin: (txnId: TxnId, snapshotTs: Timestamp) => BeginNode
  /** Record an update */
  recordUpdate: (txnId: TxnId, key: Key, effect: Effect) => UpdateNode
  /** Record an abort */
  recordAbort: (txnId: TxnId) => AbortNode
  /** Record a commit */
  recordCommit: (
    txnId: TxnId,
    snapshotTs: Timestamp,
    commitTs: Timestamp,
    effectBuffer: EffectBuffer
  ) => CommitNode
  /** Get the built trace */
  getTrace: () => Trace
  /** Get the last node for a transaction */
  getLastNode: (txnId: TxnId) => TraceNode | undefined
}

/**
 * Create a trace recorder.
 */
export function createTraceRecorder(): TraceRecorder {
  const builder = createTraceBuilder()
  const lastNodeByTxn = new Map<TxnId, TraceNode>()
  const commitNodes: Array<CommitNode> = []

  return {
    recordBegin(txnId: TxnId, snapshotTs: Timestamp): BeginNode {
      const node = beginNode(txnId, snapshotTs)
      builder.addNode(node)

      // Add edges from all commit nodes with ct < st
      for (const commit of commitNodes) {
        if (commit.commitTs < snapshotTs) {
          // Check if this is a maximal commit (no other commit between it and this begin)
          const isMaximal = !commitNodes.some(
            (other) =>
              other !== commit &&
              commit.commitTs < other.commitTs &&
              other.commitTs < snapshotTs
          )
          if (isMaximal) {
            builder.addEdge(commit, node)
          }
        }
      }

      lastNodeByTxn.set(txnId, node)
      return node
    },

    recordUpdate(txnId: TxnId, key: Key, effect: Effect): UpdateNode {
      const node = updateNode(txnId, key, effect)
      builder.addNode(node)

      const lastNode = lastNodeByTxn.get(txnId)
      if (lastNode) {
        builder.addEdge(lastNode, node)
      }

      lastNodeByTxn.set(txnId, node)
      return node
    },

    recordAbort(txnId: TxnId): AbortNode {
      const node = abortNode(txnId)
      builder.addNode(node)

      const lastNode = lastNodeByTxn.get(txnId)
      if (lastNode) {
        builder.addEdge(lastNode, node)
      }

      lastNodeByTxn.set(txnId, node)
      return node
    },

    recordCommit(
      txnId: TxnId,
      snapshotTs: Timestamp,
      commitTs: Timestamp,
      effectBuffer: EffectBuffer
    ): CommitNode {
      const node = commitNode(txnId, snapshotTs, commitTs, effectBuffer)
      builder.addNode(node)

      const lastNode = lastNodeByTxn.get(txnId)
      if (lastNode) {
        builder.addEdge(lastNode, node)
      }

      lastNodeByTxn.set(txnId, node)
      commitNodes.push(node)
      return node
    },

    getTrace(): Trace {
      return builder.build()
    },

    getLastNode(txnId: TxnId): TraceNode | undefined {
      return lastNodeByTxn.get(txnId)
    },
  }
}

// =============================================================================
// Trace Validation
// =============================================================================

/**
 * Validate that a trace is well-formed.
 * Checks all constraints from Table 2 in the paper.
 */
export function validateTrace(trace: Trace): {
  valid: boolean
  errors: Array<string>
} {
  const errors: Array<string> = []

  // Check: Transaction identifiers are unique per begin node
  const beginByTxn = new Map<TxnId, Array<BeginNode>>()
  for (const node of trace.nodes) {
    if (node.nodeType === `begin`) {
      const existing = beginByTxn.get(node.txnId) ?? []
      existing.push(node)
      beginByTxn.set(node.txnId, existing)
    }
  }
  for (const [txnId, begins] of beginByTxn) {
    if (begins.length > 1) {
      errors.push(`Transaction ${txnId} has ${begins.length} begin nodes`)
    }
  }

  // Check: Commit timestamps are unique
  const commitTs = new Map<Timestamp, Array<CommitNode>>()
  for (const node of trace.nodes) {
    if (node.nodeType === `commit`) {
      const existing = commitTs.get(node.commitTs) ?? []
      existing.push(node)
      commitTs.set(node.commitTs, existing)
    }
  }
  for (const [ts, commits] of commitTs) {
    if (commits.length > 1) {
      errors.push(
        `Commit timestamp ${ts} used by multiple transactions: ${commits.map((c) => c.txnId).join(`, `)}`
      )
    }
  }

  // Check: Each non-begin node has exactly one parent in the same transaction
  for (const node of trace.nodes) {
    if (node.nodeType !== `begin`) {
      const nodeParents = trace.parents.get(node)
      const sameTransactionParents = nodeParents
        ? [...nodeParents].filter((p) => p.txnId === node.txnId)
        : []
      if (sameTransactionParents.length !== 1) {
        errors.push(
          `Node ${node.nodeType} in txn ${node.txnId} has ${sameTransactionParents.length} same-transaction parents`
        )
      }
    }
  }

  // Check: Inter-transaction edges only from commit to begin
  for (const edge of trace.edges) {
    if (edge.from.txnId !== edge.to.txnId) {
      if (edge.from.nodeType !== `commit` || edge.to.nodeType !== `begin`) {
        errors.push(
          `Invalid inter-transaction edge: ${edge.from.nodeType}@${edge.from.txnId} -> ${edge.to.nodeType}@${edge.to.txnId}`
        )
      }
    }
  }

  // Check: st ≤ ct for commit nodes
  for (const node of trace.nodes) {
    if (node.nodeType === `commit`) {
      if (node.snapshotTs > node.commitTs) {
        errors.push(
          `Commit node in txn ${node.txnId}: st (${node.snapshotTs}) > ct (${node.commitTs})`
        )
      }
    }
  }

  // Check: Trace is acyclic (topological sort should succeed)
  try {
    topologicalSort(trace)
  } catch {
    errors.push(`Trace contains a cycle`)
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}
