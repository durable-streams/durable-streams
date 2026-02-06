/**
 * History-Based Verification Tests
 *
 * Tests for Elle-style consistency checking via dependency graphs.
 */

import { describe, expect, it } from "vitest"
import {
  buildDependencyGraph,
  checkSerializable,
  checkSnapshotIsolation,
  createHistoryBuilder,
  findCycle,
  formatGraph,
  hasCycle,
} from "../src/history"

describe(`History-Based Verification`, () => {
  describe(`History Builder`, () => {
    it(`records transactions and operations`, () => {
      const builder = createHistoryBuilder()

      builder.beginTxn(`t1`, 0)
      builder.write(`t1`, `x`, 10)
      builder.commit(`t1`, 5)

      builder.beginTxn(`t2`, 6)
      builder.read(`t2`, `x`, 10)
      builder.commit(`t2`, 10)

      const history = builder.build()

      expect(history.transactions.size).toBe(2)
      expect(history.operations.length).toBe(2)

      const t1 = history.transactions.get(`t1`)
      expect(t1?.status).toBe(`committed`)
      expect(t1?.snapshotTs).toBe(0)
      expect(t1?.commitTs).toBe(5)

      const t2 = history.transactions.get(`t2`)
      expect(t2?.status).toBe(`committed`)
      expect(t2?.snapshotTs).toBe(6)
    })

    it(`handles aborted transactions`, () => {
      const builder = createHistoryBuilder()

      builder.beginTxn(`t1`, 0)
      builder.write(`t1`, `x`, 10)
      builder.abort(`t1`)

      const history = builder.build()
      const t1 = history.transactions.get(`t1`)
      expect(t1?.status).toBe(`aborted`)
    })
  })

  describe(`Dependency Graph`, () => {
    it(`builds WR (write-read) edges`, () => {
      const builder = createHistoryBuilder()

      // T1 writes x=10
      builder.beginTxn(`t1`, 0)
      builder.write(`t1`, `x`, 10)
      builder.commit(`t1`, 5)

      // T2 reads x=10 (depends on T1)
      builder.beginTxn(`t2`, 6)
      builder.read(`t2`, `x`, 10)
      builder.commit(`t2`, 10)

      const history = builder.build()
      const graph = buildDependencyGraph(history)

      expect(graph.nodes).toContain(`t1`)
      expect(graph.nodes).toContain(`t2`)

      const wrEdge = graph.edges.find(
        (e) => e.from === `t1` && e.to === `t2` && e.type === `wr`
      )
      expect(wrEdge).toBeDefined()
      expect(wrEdge?.key).toBe(`x`)
    })

    it(`builds WW (write-write) edges`, () => {
      const builder = createHistoryBuilder()

      // T1 writes x=10
      builder.beginTxn(`t1`, 0)
      builder.write(`t1`, `x`, 10)
      builder.commit(`t1`, 5)

      // T2 writes x=20 (overwrites T1)
      builder.beginTxn(`t2`, 6)
      builder.write(`t2`, `x`, 20)
      builder.commit(`t2`, 10)

      const history = builder.build()
      const graph = buildDependencyGraph(history)

      const wwEdge = graph.edges.find(
        (e) => e.from === `t1` && e.to === `t2` && e.type === `ww`
      )
      expect(wwEdge).toBeDefined()
    })

    it(`builds RW (anti-dependency) edges`, () => {
      const builder = createHistoryBuilder()

      // T1 writes x=10
      builder.beginTxn(`t1`, 0)
      builder.write(`t1`, `x`, 10)
      builder.commit(`t1`, 5)

      // T2 reads x=10, T3 writes x=20 concurrently
      builder.beginTxn(`t2`, 6)
      builder.read(`t2`, `x`, 10)
      builder.commit(`t2`, 15)

      builder.beginTxn(`t3`, 6)
      builder.write(`t3`, `x`, 20)
      builder.commit(`t3`, 10) // Commits before T2 finishes

      const history = builder.build()
      const graph = buildDependencyGraph(history)

      // T2 reads, T3 writes - RW anti-dependency
      const rwEdge = graph.edges.find(
        (e) => e.from === `t2` && e.to === `t3` && e.type === `rw`
      )
      expect(rwEdge).toBeDefined()
    })

    it(`excludes aborted transactions`, () => {
      const builder = createHistoryBuilder()

      builder.beginTxn(`t1`, 0)
      builder.write(`t1`, `x`, 10)
      builder.abort(`t1`)

      builder.beginTxn(`t2`, 0)
      builder.write(`t2`, `x`, 20)
      builder.commit(`t2`, 5)

      const history = builder.build()
      const graph = buildDependencyGraph(history)

      expect(graph.nodes).not.toContain(`t1`)
      expect(graph.nodes).toContain(`t2`)
    })
  })

  describe(`Cycle Detection`, () => {
    it(`detects no cycle in acyclic graph`, () => {
      const builder = createHistoryBuilder()

      // Simple linear history: T1 -> T2 -> T3
      builder.beginTxn(`t1`, 0)
      builder.write(`t1`, `x`, 10)
      builder.commit(`t1`, 1)

      builder.beginTxn(`t2`, 2)
      builder.read(`t2`, `x`, 10)
      builder.write(`t2`, `x`, 20)
      builder.commit(`t2`, 3)

      builder.beginTxn(`t3`, 4)
      builder.read(`t3`, `x`, 20)
      builder.commit(`t3`, 5)

      const history = builder.build()
      const graph = buildDependencyGraph(history)

      expect(hasCycle(graph)).toBe(false)
      expect(findCycle(graph)).toBeNull()
    })

    it(`detects cycle in non-serializable history`, () => {
      // Construct a history with a cycle manually
      // This represents a write skew anomaly

      const builder = createHistoryBuilder()

      // Initial state: x=0, y=0
      builder.beginTxn(`init`, 0)
      builder.write(`init`, `x`, 0)
      builder.write(`init`, `y`, 0)
      builder.commit(`init`, 1)

      // T1: reads x=0, writes y=1
      builder.beginTxn(`t1`, 2)
      builder.read(`t1`, `x`, 0)
      builder.write(`t1`, `y`, 1)
      builder.commit(`t1`, 10)

      // T2: reads y=0, writes x=1 (concurrent with T1)
      builder.beginTxn(`t2`, 2)
      builder.read(`t2`, `y`, 0)
      builder.write(`t2`, `x`, 1)
      builder.commit(`t2`, 11)

      const history = builder.build()
      const graph = buildDependencyGraph(history)

      // This creates a cycle:
      // T1 reads x, T2 writes x -> RW edge T1 -> T2
      // T2 reads y, T1 writes y -> RW edge T2 -> T1
      // Cycle: T1 -> T2 -> T1

      // Note: The cycle depends on the exact ordering and visibility
      // With our timestamp model, this should create the cycle
      expect(hasCycle(graph)).toBe(true)

      const cycle = findCycle(graph)
      expect(cycle).not.toBeNull()
      expect(cycle?.length).toBeGreaterThanOrEqual(2)
    })
  })

  describe(`Consistency Checking`, () => {
    it(`validates serializable history`, () => {
      const builder = createHistoryBuilder()

      // Simple serial execution
      builder.beginTxn(`t1`, 0)
      builder.write(`t1`, `x`, 10)
      builder.commit(`t1`, 1)

      builder.beginTxn(`t2`, 2)
      builder.read(`t2`, `x`, 10)
      builder.write(`t2`, `x`, 20)
      builder.commit(`t2`, 3)

      const history = builder.build()
      const result = checkSerializable(history)

      expect(result.valid).toBe(true)
      expect(result.violation).toBeUndefined()
    })

    it(`detects non-serializable history`, () => {
      const builder = createHistoryBuilder()

      // Set up write skew
      builder.beginTxn(`init`, 0)
      builder.write(`init`, `x`, 0)
      builder.write(`init`, `y`, 0)
      builder.commit(`init`, 1)

      builder.beginTxn(`t1`, 2)
      builder.read(`t1`, `x`, 0)
      builder.write(`t1`, `y`, 1)
      builder.commit(`t1`, 10)

      builder.beginTxn(`t2`, 2)
      builder.read(`t2`, `y`, 0)
      builder.write(`t2`, `x`, 1)
      builder.commit(`t2`, 11)

      const history = builder.build()
      const result = checkSerializable(history)

      expect(result.valid).toBe(false)
      expect(result.violation?.type).toBe(`cycle`)
    })

    it(`snapshot isolation allows write skew`, () => {
      const builder = createHistoryBuilder()

      // Same write skew scenario
      builder.beginTxn(`init`, 0)
      builder.write(`init`, `x`, 0)
      builder.write(`init`, `y`, 0)
      builder.commit(`init`, 1)

      builder.beginTxn(`t1`, 2)
      builder.read(`t1`, `x`, 0)
      builder.write(`t1`, `y`, 1)
      builder.commit(`t1`, 10)

      builder.beginTxn(`t2`, 2)
      builder.read(`t2`, `y`, 0)
      builder.write(`t2`, `x`, 1)
      builder.commit(`t2`, 11)

      const history = builder.build()

      // Write skew violates serializability...
      const serResult = checkSerializable(history)
      expect(serResult.valid).toBe(false)

      // ...but is allowed under snapshot isolation
      // (SI only checks WW and WR, not RW)
      const siResult = checkSnapshotIsolation(history)
      expect(siResult.valid).toBe(true)
    })
  })

  describe(`Utilities`, () => {
    it(`formats graph for debugging`, () => {
      const builder = createHistoryBuilder()

      builder.beginTxn(`t1`, 0)
      builder.write(`t1`, `x`, 10)
      builder.commit(`t1`, 1)

      builder.beginTxn(`t2`, 2)
      builder.read(`t2`, `x`, 10)
      builder.commit(`t2`, 3)

      const history = builder.build()
      const graph = buildDependencyGraph(history)
      const formatted = formatGraph(graph)

      expect(formatted).toContain(`t1`)
      expect(formatted).toContain(`t2`)
      expect(formatted).toContain(`wr`)
    })
  })
})
