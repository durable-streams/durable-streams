# Conformance Testing Research: Jepsen & Antithesis

This document summarizes research on [Jepsen](https://jepsen.io/) and [Antithesis](https://antithesis.com/) testing methodologies, with actionable recommendations for improving the Durable Streams client and server conformance test suites.

## Executive Summary

| Approach | Jepsen | Antithesis |
|----------|--------|------------|
| **Focus** | Distributed systems correctness under failures | Autonomous bug discovery with deterministic replay |
| **Key Technique** | Property-based testing + fault injection | Deterministic simulation testing (DST) |
| **Verification** | Linearizability/serializability checking | Always/sometimes property assertions |
| **Reproducibility** | History-based analysis | Perfect deterministic replay |
| **Fault Types** | Network partitions, clock skew, process crashes | Node throttling, hangs, thread pauses |

---

## Part 1: Jepsen Methodology

### Overview

Jepsen is a Clojure-based framework that tests distributed systems by:
1. Deploying a cluster (typically 5 nodes)
2. Running concurrent operations via "generators"
3. Injecting faults via a "nemesis" process
4. Checking operation histories for correctness violations

### Key Components

#### 1. Generators
Produce operations for concurrent clients to execute. Control both normal operations and fault-injection timing.

```clojure
;; Example: Interleave reads, writes, and faults
(gen/mix [(gen/repeat {:type :read})
          (gen/repeat {:type :write, :value (rand-int 100)})
          (gen/nemesis-partition)])
```

**Relevance to Durable Streams:** Our current test YAML files are static sequences. We could add randomized operation generators using fast-check.

#### 2. Nemesis (Fault Injection)
A special client that introduces failures across the cluster:

| Fault Type | Description | DS Applicability |
|------------|-------------|------------------|
| `partition-halves` | Network split into majority/minority | Test SSE during network issues |
| `partition-one` | Isolate single node | Test client reconnection |
| `clock-skew` | Randomized clock drift | Test TTL/expiry behavior |
| `kill` | Kill random processes | Test crash recovery |
| `pause` | SIGSTOP/SIGCONT processes | Test timeout handling |
| `packet-loss` | Random packet drops | Test retry resilience |
| `file-corruption` | Corrupt storage files | Test recovery on restart |

#### 3. Checkers

**Knossos** - Linearizability verification for single-object operations:
- Verifies that concurrent operations appear to take effect instantaneously
- Works on register-based models (read/write/CAS)
- Limited to ~hundreds of operations due to NP-complete complexity

**Elle** - Transactional consistency checker:
- Handles hundreds of thousands of operations in linear time
- Detects isolation anomalies via dependency graph cycle detection
- Provides minimal counterexamples for violations

**Relevance to Durable Streams:** We should verify:
- Offset monotonicity (never go backwards)
- Append linearizability (writes appear atomic)
- Read-your-writes consistency

#### 4. Workload Patterns

| Workload | What It Tests | DS Equivalent |
|----------|---------------|---------------|
| `register` | Single-key read/write linearizability | Single stream append/read |
| `set` | Set membership (no duplicates, no loss) | All appended messages readable |
| `counter` | Increment/decrement correctness | Stream offset progression |
| `list-append` | Ordered list append correctness | **Direct match** - stream append ordering |
| `bank` | Transfer consistency (no money created/lost) | N/A |

### Common Bugs Found by Jepsen

From [Jepsen analyses](https://jepsen.io/analyses), common distributed systems bugs include:

1. **Stale reads** - Reading outdated data after acknowledged writes
2. **Lost writes** - Acknowledged writes that disappear
3. **Split brain** - Multiple primaries accepting conflicting writes
4. **Clock dependency** - Incorrect behavior under clock skew
5. **Dirty reads** - Reading uncommitted/rolled-back data
6. **Write skew** - Concurrent transactions creating invalid states
7. **Lost updates** - Concurrent writes losing one operation

**For Durable Streams, focus on:**
- Stale reads (client reads old offset after append acknowledged)
- Lost writes (append acknowledged but data not persisted)
- Ordering violations (messages appear out of order)

---

## Part 2: Antithesis Methodology

### Overview

Antithesis uses Deterministic Simulation Testing (DST) with a custom hypervisor ("The Determinator") that makes all execution fully deterministic. Key features:

1. **Perfect reproducibility** - Any bug can be replayed exactly
2. **Autonomous exploration** - AI-driven state space search
3. **Fault injection** - Integrated into the simulation
4. **No flaky tests** - Determinism eliminates test flakiness

### Key Concepts

#### 1. Always vs Sometimes Properties

Antithesis distinguishes two property types:

**Always Properties** - Invariants that must never be violated:
```typescript
// Pseudo-code for Durable Streams
always("offset monotonicity", () => {
  return currentOffset >= previousOffset
})

always("no data loss", () => {
  return appendedData.every(d => canReadData(d))
})

always("append atomicity", () => {
  // Either all data visible or none
  return isFullyVisible(append) || isNotVisible(append)
})
```

**Sometimes Properties** - Reachability assertions that should trigger at least once:
```typescript
// Ensures test coverage reaches important states
sometimes("reader catches up during write", () => {
  return readerReceivedDataWhileWriterActive
})

sometimes("SSE receives live data", () => {
  return sseReceivedDataAppendedAfterConnect
})

sometimes("retry logic exercised", () => {
  return retryAttemptMade && eventuallySucceeded
})
```

**Why Sometimes Properties Matter:**
- Better than code coverage (covers *situations*, not just *locations*)
- Detects dead code paths
- Validates test effectiveness
- Catches unreachable states (e.g., checkout flow broken)

#### 2. Fault Injection Types

Antithesis supports:

| Fault | Description | DS Application |
|-------|-------------|----------------|
| Node throttle | Limit CPU resources | Slow server response |
| Node hang | Completely unresponsive | Test client timeouts |
| Thread pause | Individual thread delays | Race condition detection |
| Network partition | Node isolation | SSE reconnection |
| Disk I/O delays | Storage latency | Append timeout handling |

#### 3. Deterministic Replay

Unlike traditional testing where bugs may not reproduce:
- Every execution is recorded with a seed
- Any state can be rewound and replayed
- Debugging can step backwards in time
- No "works on my machine" problems

### Test Composition Best Practices

From [Antithesis documentation](https://antithesis.com/docs/test_templates/test_best_practices/):

1. **Distinguish always vs eventually properties**
   - Don't fail tests for temporary violations during fault injection
   - After faults clear, system should *eventually* recover

2. **Validate throughout, not just at end**
   - Check invariants continuously during test execution
   - Don't wait until teardown to detect failures

3. **Properties over assertions**
   - Express invariants as reusable properties
   - Aggregate assertions by message for clear reporting

---

## Part 3: Recommendations for Durable Streams

### A. Immediate Improvements (Low Effort)

#### 1. Add Property-Based Fuzzing with fast-check

Expand the existing fast-check usage to cover more scenarios:

```typescript
// packages/server-conformance-tests/src/fuzzing/stream-operations.ts

import fc from "fast-check"

const streamOperationArb = fc.oneof(
  fc.record({ type: fc.constant("append"), data: fc.uint8Array({ maxLength: 10000 }) }),
  fc.record({ type: fc.constant("read"), offset: fc.option(fc.string()) }),
  fc.record({ type: fc.constant("read-sse"), maxChunks: fc.integer({ min: 1, max: 100 }) }),
  fc.record({ type: fc.constant("read-longpoll"), timeout: fc.integer({ min: 100, max: 5000 }) })
)

test("stream operations maintain invariants", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(streamOperationArb, { minLength: 10, maxLength: 100 }),
      async (operations) => {
        // Invariants to check after each operation sequence
        const offsets: string[] = []

        for (const op of operations) {
          if (op.type === "append") {
            const result = await server.append(streamPath, op.data)
            offsets.push(result.offset)
          } else if (op.type === "read") {
            const result = await server.read(streamPath, op.offset)
            // Invariant: offsets in response are monotonic
            expect(isMonotonic(result.offsets)).toBe(true)
          }
        }

        // Invariant: all offsets are unique
        expect(new Set(offsets).size).toBe(offsets.length)

        // Invariant: offsets are monotonically increasing
        expect(isMonotonic(offsets)).toBe(true)

        // Invariant: all appended data is readable
        const allData = await server.read(streamPath, "-1")
        expect(allData.chunks.length).toBe(offsets.length)
      }
    ),
    { numRuns: 100 }
  )
})
```

#### 2. Add "Sometimes" Assertions for Test Coverage

Track that important code paths are actually exercised:

```typescript
// Add to test runner
const sometimesHit = new Map<string, boolean>()

function sometimes(name: string, condition: boolean) {
  if (condition) sometimesHit.set(name, true)
}

// In tests
test("SSE receives live data", async () => {
  // ... test setup ...

  sometimes("sse-connected-before-append", sseConnectedBeforeAppend)
  sometimes("sse-received-live-push", receivedDataAfterConnect)
  sometimes("sse-up-to-date-received", sawUpToDateSignal)
})

// After all tests
afterAll(() => {
  const missing = [...sometimesHit.entries()]
    .filter(([_, hit]) => !hit)
    .map(([name]) => name)

  if (missing.length > 0) {
    console.warn("Sometimes conditions never triggered:", missing)
  }
})
```

#### 3. Add Invariant Checkers

Define Jepsen-style checkers for Durable Streams properties:

```typescript
// packages/shared/src/checkers/linearizability.ts

interface Operation {
  type: "append" | "read"
  invocation: number  // timestamp
  completion: number  // timestamp
  input: any
  output: any
}

function checkOffsetMonotonicity(history: Operation[]): CheckResult {
  const appendOps = history.filter(op => op.type === "append")
  const offsets = appendOps.map(op => op.output.offset)

  for (let i = 1; i < offsets.length; i++) {
    if (compareOffsets(offsets[i], offsets[i-1]) <= 0) {
      return {
        valid: false,
        violation: `Offset ${offsets[i]} not greater than ${offsets[i-1]}`,
        operations: [appendOps[i-1], appendOps[i]]
      }
    }
  }
  return { valid: true }
}

function checkReadYourWrites(history: Operation[]): CheckResult {
  // For each append, verify subsequent reads include that data
  for (const append of history.filter(op => op.type === "append")) {
    const laterReads = history.filter(op =>
      op.type === "read" &&
      op.invocation > append.completion
    )

    for (const read of laterReads) {
      if (!read.output.offsets.includes(append.output.offset)) {
        return {
          valid: false,
          violation: `Read at ${read.invocation} missing append from ${append.completion}`,
          operations: [append, read]
        }
      }
    }
  }
  return { valid: true }
}
```

### B. Medium-Term Improvements

#### 4. Add Fault Injection to Client Conformance Tests

Create a "chaotic" server wrapper for client tests:

```typescript
// packages/client-conformance-tests/src/chaotic-server.ts

interface FaultConfig {
  errorRate: number        // 0-1, chance of returning 500/503
  latencyMs: number        // Added delay
  partitionChance: number  // Chance of timing out
  clockSkewMs: number      // Offset for TTL testing
}

class ChaoticServer {
  constructor(private realServer: Server, private faults: FaultConfig) {}

  async handleRequest(req: Request): Promise<Response> {
    // Inject partition (timeout)
    if (Math.random() < this.faults.partitionChance) {
      await sleep(30000) // Force client timeout
      throw new Error("Simulated partition")
    }

    // Inject latency
    if (this.faults.latencyMs > 0) {
      await sleep(this.faults.latencyMs)
    }

    // Inject errors
    if (Math.random() < this.faults.errorRate) {
      const errorCode = Math.random() < 0.5 ? 500 : 503
      return new Response(null, {
        status: errorCode,
        headers: { "Retry-After": "1" }
      })
    }

    return this.realServer.handleRequest(req)
  }
}
```

New YAML test cases for chaos:

```yaml
# test-cases/chaos/retry-under-faults.yaml
id: chaos-retry
name: Retry Under Faults
description: Tests client retry behavior under chaotic conditions
category: chaos
tags:
  - chaos
  - retry
  - resilience

chaos:
  errorRate: 0.3
  latencyMs: 500
  partitionChance: 0.1

tests:
  - id: append-succeeds-despite-failures
    name: Append eventually succeeds
    description: Client should retry and eventually succeed
    setup:
      - action: create
        as: streamPath
    operations:
      - action: append
        path: ${streamPath}
        data: "resilient-data"
        # Client should retry up to N times
        expect:
          success: true
          maxRetries: 5
      - action: read
        path: ${streamPath}
        expect:
          dataContains: "resilient-data"
```

#### 5. Add Concurrent Operation Tests

Test multiple clients operating simultaneously:

```yaml
# test-cases/concurrent/multi-client-append.yaml
id: concurrent-append
name: Concurrent Multi-Client Appends
description: Multiple clients appending to same stream
category: concurrent
tags:
  - concurrent
  - ordering

tests:
  - id: concurrent-appends-ordered
    name: Concurrent appends maintain order
    description: All concurrent appends should get unique, ordered offsets
    setup:
      - action: create
        as: streamPath
    operations:
      # Launch 5 concurrent append operations
      - action: parallel
        operations:
          - action: append
            path: ${streamPath}
            data: "client-1"
            expect:
              storeOffsetAs: offset1
          - action: append
            path: ${streamPath}
            data: "client-2"
            expect:
              storeOffsetAs: offset2
          - action: append
            path: ${streamPath}
            data: "client-3"
            expect:
              storeOffsetAs: offset3
          - action: append
            path: ${streamPath}
            data: "client-4"
            expect:
              storeOffsetAs: offset4
          - action: append
            path: ${streamPath}
            data: "client-5"
            expect:
              storeOffsetAs: offset5
    assertions:
      - type: unique
        values: [offset1, offset2, offset3, offset4, offset5]
      - type: monotonic
        values: [offset1, offset2, offset3, offset4, offset5]
        # Note: order depends on which append completed first
```

#### 6. Add History Recording and Replay

Record operation histories for post-hoc analysis:

```typescript
// packages/shared/src/history/recorder.ts

interface HistoryEntry {
  id: string
  type: "invoke" | "complete" | "fail"
  operation: string
  process: number  // client ID
  timestamp: number
  value?: any
}

class HistoryRecorder {
  private entries: HistoryEntry[] = []

  invoke(process: number, operation: string, value?: any): string {
    const id = crypto.randomUUID()
    this.entries.push({
      id, type: "invoke", operation, process,
      timestamp: Date.now(), value
    })
    return id
  }

  complete(id: string, value?: any) {
    this.entries.push({
      id, type: "complete", operation: "",
      process: 0, timestamp: Date.now(), value
    })
  }

  fail(id: string, error: Error) {
    this.entries.push({
      id, type: "fail", operation: "",
      process: 0, timestamp: Date.now(), value: error.message
    })
  }

  analyze(): AnalysisResult {
    return {
      linearizable: checkLinearizability(this.entries),
      monotonic: checkOffsetMonotonicity(this.entries),
      readYourWrites: checkReadYourWrites(this.entries),
      timeline: this.entries
    }
  }

  export(): string {
    return JSON.stringify(this.entries, null, 2)
  }
}
```

### C. Long-Term Improvements

#### 7. Implement Deterministic Simulation Mode

Create a deterministic execution environment for the server:

```typescript
// packages/server/src/simulation/deterministic.ts

class DeterministicClock {
  constructor(private seed: number) {}

  now(): number {
    // Deterministic time based on seed
    return this.seed + this.tickCount * 1000
  }

  advance(ms: number) {
    this.tickCount += Math.ceil(ms / 1000)
  }
}

class DeterministicRandom {
  constructor(private seed: number) {}

  next(): number {
    // Seeded PRNG for reproducibility
    this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff
    return this.seed / 0x7fffffff
  }
}

class DeterministicScheduler {
  private pending: Array<{ time: number, fn: () => void }> = []

  schedule(delay: number, fn: () => void) {
    this.pending.push({ time: this.clock.now() + delay, fn })
    this.pending.sort((a, b) => a.time - b.time)
  }

  runUntil(time: number) {
    while (this.pending.length > 0 && this.pending[0].time <= time) {
      const { fn } = this.pending.shift()!
      fn()
    }
  }
}
```

#### 8. Add Model-Based Testing

Define a reference model and verify implementation matches:

```typescript
// packages/shared/src/model/stream-model.ts

class StreamModel {
  private streams: Map<string, {
    chunks: Array<{ offset: string, data: Uint8Array }>
    contentType: string
    nextOffset: number
  }> = new Map()

  create(path: string, contentType: string): boolean {
    if (this.streams.has(path)) return false
    this.streams.set(path, { chunks: [], contentType, nextOffset: 0 })
    return true
  }

  append(path: string, data: Uint8Array): string | null {
    const stream = this.streams.get(path)
    if (!stream) return null

    const offset = stream.nextOffset.toString()
    stream.chunks.push({ offset, data })
    stream.nextOffset += data.length
    return offset
  }

  read(path: string, fromOffset: string): Uint8Array[] | null {
    const stream = this.streams.get(path)
    if (!stream) return null

    const startIdx = stream.chunks.findIndex(c => c.offset >= fromOffset)
    if (startIdx === -1) return []

    return stream.chunks.slice(startIdx).map(c => c.data)
  }
}

// In tests: verify model and implementation produce same results
test("implementation matches model", async () => {
  const model = new StreamModel()
  const server = createServer()

  await fc.assert(
    fc.asyncProperty(operationsArb, async (ops) => {
      for (const op of ops) {
        const modelResult = model[op.type](...op.args)
        const serverResult = await server[op.type](...op.args)

        expect(serverResult).toEqual(modelResult)
      }
    })
  )
})
```

#### 9. Add Jepsen-Style Analysis Reports

Generate detailed reports after test runs:

```typescript
// packages/shared/src/reports/jepsen-report.ts

interface JepsenReport {
  name: string
  startTime: Date
  endTime: Date

  // Test configuration
  nemesis: string[]
  concurrency: number
  operationCount: number

  // Results
  valid: boolean

  // Detailed analysis
  checks: {
    name: string
    valid: boolean
    errors: Array<{ description: string, operations: Operation[] }>
  }[]

  // Timing statistics
  latency: {
    p50: number
    p99: number
    max: number
  }

  // Fault statistics
  faultsInjected: number
  faultTypes: Record<string, number>

  // Operation outcomes
  operations: {
    total: number
    successful: number
    failed: number
    timedOut: number
  }
}

function generateReport(history: HistoryEntry[], config: TestConfig): JepsenReport {
  return {
    name: config.name,
    startTime: new Date(history[0].timestamp),
    endTime: new Date(history[history.length - 1].timestamp),

    nemesis: config.nemesis,
    concurrency: config.concurrency,
    operationCount: history.filter(h => h.type === "invoke").length,

    valid: runAllCheckers(history).every(c => c.valid),

    checks: runAllCheckers(history),

    latency: calculateLatencyStats(history),

    faultsInjected: history.filter(h => h.operation.startsWith("nemesis")).length,
    faultTypes: groupBy(
      history.filter(h => h.operation.startsWith("nemesis")),
      h => h.operation
    ),

    operations: {
      total: history.filter(h => h.type === "invoke").length,
      successful: history.filter(h => h.type === "complete").length,
      failed: history.filter(h => h.type === "fail").length,
      timedOut: history.filter(h => h.type === "fail" && h.value?.includes("timeout")).length
    }
  }
}
```

---

## Part 4: Implementation Priority

### Phase 1: Quick Wins (1-2 weeks)

| Item | Effort | Impact | Location |
|------|--------|--------|----------|
| Property-based fuzz tests | Low | High | `server-conformance-tests/src/fuzzing/` |
| "Sometimes" coverage tracking | Low | Medium | `client-conformance-tests/src/runner.ts` |
| Offset monotonicity checker | Low | High | `shared/src/checkers/` |
| Read-your-writes checker | Low | High | `shared/src/checkers/` |

### Phase 2: Core Improvements (2-4 weeks)

| Item | Effort | Impact | Location |
|------|--------|--------|----------|
| Chaos server wrapper | Medium | High | `client-conformance-tests/src/` |
| Concurrent operation tests | Medium | High | `test-cases/concurrent/` |
| History recording | Medium | Medium | `shared/src/history/` |
| Latency injection tests | Medium | Medium | `test-cases/chaos/` |

### Phase 3: Advanced Features (4-8 weeks)

| Item | Effort | Impact | Location |
|------|--------|--------|----------|
| Deterministic simulation | High | High | `server/src/simulation/` |
| Model-based testing | High | High | `shared/src/model/` |
| Full Jepsen-style reports | Medium | Medium | `shared/src/reports/` |
| Clock skew testing | Medium | Medium | TTL/expiry behavior |

---

## Part 5: New Test Categories

Based on Jepsen and Antithesis patterns, add these test categories:

### Proposed New Test Files

```
test-cases/
├── chaos/
│   ├── retry-under-faults.yaml      # Client retry with server errors
│   ├── timeout-resilience.yaml      # Behavior under delays
│   └── partition-recovery.yaml      # Recovery after network splits
├── concurrent/
│   ├── multi-client-append.yaml     # Parallel appends
│   ├── read-during-write.yaml       # Concurrent read/write
│   └── sse-with-appends.yaml        # SSE receiving live writes
├── consistency/
│   ├── linearizability.yaml         # Jepsen-style register tests
│   ├── read-your-writes.yaml        # Write then immediate read
│   └── monotonic-reads.yaml         # Reads never go backwards
├── durability/
│   ├── crash-recovery.yaml          # Restart between operations
│   └── persist-before-ack.yaml      # Data persisted before response
└── clock/
    ├── ttl-expiry.yaml              # TTL behavior
    └── clock-skew.yaml              # Behavior under skewed clocks
```

---

## Sources

### Jepsen
- [Jepsen GitHub Repository](https://github.com/jepsen-io/jepsen)
- [Jepsen Nemesis Documentation](https://github.com/jepsen-io/jepsen/blob/main/doc/tutorial/05-nemesis.md)
- [Elle Transactional Checker](https://github.com/jepsen-io/elle)
- [Knossos Linearizability Checker](https://github.com/jepsen-io/knossos)
- [Common Safety Pitfalls Found by Jepsen](https://hoverbear.org/blog/common-safety-pitfalls-found-by-jepsen/)
- [Jepsen Analyses](https://jepsen.io/analyses)
- [Testing Distributed Systems Resources](https://asatarin.github.io/testing-distributed-systems/)

### Antithesis
- [Antithesis: Autonomous Software Testing](https://antithesis.com/)
- [Deterministic Simulation Testing](https://antithesis.com/resources/deterministic_simulation_testing/)
- [How Antithesis Works](https://antithesis.com/product/how_antithesis_works/)
- [Sometimes Assertions Best Practices](https://antithesis.com/docs/best_practices/sometimes_assertions/)
- [Properties in Antithesis](https://antithesis.com/docs/properties_assertions/properties/)
- [Fault Injection Documentation](https://antithesis.com/docs/environment/fault_injection/)
- [Test Composition Principles](https://antithesis.com/docs/test_templates/test_best_practices/)

### Related
- [The Pragmatic Engineer: Antithesis Deep Dive](https://newsletter.pragmaticengineer.com/p/antithesis)
- [Building Open-Source Antithesis](https://databases.systems/posts/open-source-antithesis-p1)
- [Elle: Inferring Isolation Anomalies (Paper)](https://blog.acolyer.org/2020/11/23/elle/)
