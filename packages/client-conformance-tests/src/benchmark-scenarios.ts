/**
 * Benchmark scenario definitions.
 *
 * Each scenario defines what to measure, how many iterations,
 * and success criteria for the benchmark.
 */

import type { BenchmarkOperation } from "./protocol.js"

// =============================================================================
// Types
// =============================================================================

export interface BenchmarkScenario {
  /** Unique scenario ID */
  id: string
  /** Human-readable name */
  name: string
  /** Description */
  description: string
  /** Category for grouping */
  category: `latency` | `throughput` | `streaming`
  /** Required client features */
  requires?: Array<`batching` | `sse` | `longPoll` | `streaming`>
  /** Scenario configuration */
  config: BenchmarkScenarioConfig
  /** Success criteria */
  criteria?: BenchmarkCriteria
  /** Factory to create benchmark operations for each iteration */
  createOperation: (ctx: ScenarioContext) => BenchmarkOperation
  /** Optional setup before running iterations */
  setup?: (ctx: ScenarioContext) => Promise<SetupResult>
  /** Optional cleanup after running iterations */
  cleanup?: (ctx: ScenarioContext) => Promise<void>
}

export interface BenchmarkScenarioConfig {
  /** Number of warmup iterations (not measured) */
  warmupIterations: number
  /** Number of measured iterations */
  measureIterations: number
  /** Message size in bytes (where applicable) */
  messageSize: number
  /** Concurrency level (for throughput tests) */
  concurrency?: number
}

export interface BenchmarkCriteria {
  /** Maximum acceptable p50 latency in ms */
  maxP50Ms?: number
  /** Maximum acceptable p99 latency in ms */
  maxP99Ms?: number
  /** Minimum throughput in operations/second */
  minOpsPerSecond?: number
  /** Minimum throughput in MB/second */
  minMBPerSecond?: number
}

export interface ScenarioContext {
  /** Base path for streams (unique per scenario run) */
  basePath: string
  /** Current iteration number (0-based) */
  iteration: number
  /** Stored values from setup */
  setupData: Record<string, unknown>
}

export interface SetupResult {
  /** Data to pass to each iteration */
  data?: Record<string, unknown>
}

// =============================================================================
// Latency Scenarios
// =============================================================================

export const appendLatencyScenario: BenchmarkScenario = {
  id: `latency-append`,
  name: `Append Latency`,
  description: `Measure time to complete a single append operation`,
  category: `latency`,
  config: {
    warmupIterations: 10,
    measureIterations: 100,
    messageSize: 100, // 100 bytes
  },
  criteria: {
    maxP50Ms: 20,
    maxP99Ms: 100,
  },
  createOperation: (ctx) => ({
    op: `append`,
    path: `${ctx.basePath}/stream`,
    size: 100,
  }),
  setup: (ctx) => {
    ctx.setupData.streamPath = `${ctx.basePath}/stream`
    return Promise.resolve({})
  },
}

export const readLatencyScenario: BenchmarkScenario = {
  id: `latency-read`,
  name: `Read Latency`,
  description: `Measure time to complete a single read operation`,
  category: `latency`,
  config: {
    warmupIterations: 10,
    measureIterations: 100,
    messageSize: 100,
  },
  criteria: {
    maxP50Ms: 20,
    maxP99Ms: 100,
  },
  createOperation: (ctx) => ({
    op: `read`,
    path: `${ctx.basePath}/stream`,
    offset: ctx.setupData.offset as string | undefined,
  }),
  setup: (ctx) => {
    ctx.setupData.streamPath = `${ctx.basePath}/stream`
    return Promise.resolve({})
  },
}

export const roundtripLatencyScenario: BenchmarkScenario = {
  id: `latency-roundtrip`,
  name: `Roundtrip Latency`,
  description: `Measure time to append and immediately read back via long-poll`,
  category: `latency`,
  requires: [`longPoll`],
  config: {
    warmupIterations: 5,
    measureIterations: 50,
    messageSize: 100,
  },
  criteria: {
    maxP50Ms: 50,
    maxP99Ms: 200,
  },
  createOperation: (ctx) => ({
    op: `roundtrip`,
    path: `${ctx.basePath}/roundtrip-${ctx.iteration}`,
    size: 100,
    live: `long-poll`,
  }),
}

export const createLatencyScenario: BenchmarkScenario = {
  id: `latency-create`,
  name: `Create Latency`,
  description: `Measure time to create a new stream`,
  category: `latency`,
  config: {
    warmupIterations: 5,
    measureIterations: 50,
    messageSize: 0,
  },
  criteria: {
    maxP50Ms: 30,
    maxP99Ms: 150,
  },
  createOperation: (ctx) => ({
    op: `create`,
    path: `${ctx.basePath}/create-${ctx.iteration}`,
    contentType: `application/octet-stream`,
  }),
}

// =============================================================================
// Throughput Scenarios
// =============================================================================

export const smallMessageThroughputScenario: BenchmarkScenario = {
  id: `throughput-small-messages`,
  name: `Small Message Throughput`,
  description: `Measure throughput for 100-byte messages at high concurrency`,
  category: `throughput`,
  requires: [`batching`],
  config: {
    warmupIterations: 2,
    measureIterations: 10,
    messageSize: 100,
    concurrency: 200,
  },
  criteria: {
    minOpsPerSecond: 1000,
  },
  createOperation: (ctx) => ({
    op: `throughput_append`,
    path: `${ctx.basePath}/throughput-small`,
    count: 100000,
    size: 100,
    concurrency: 200,
  }),
}

export const largeMessageThroughputScenario: BenchmarkScenario = {
  id: `throughput-large-messages`,
  name: `Large Message Throughput`,
  description: `Measure throughput for 1MB messages`,
  category: `throughput`,
  requires: [`batching`],
  config: {
    warmupIterations: 1,
    measureIterations: 5,
    messageSize: 1024 * 1024, // 1MB
    concurrency: 10,
  },
  criteria: {
    minOpsPerSecond: 20,
  },
  createOperation: (ctx) => ({
    op: `throughput_append`,
    path: `${ctx.basePath}/throughput-large`,
    count: 50,
    size: 1024 * 1024,
    concurrency: 10,
  }),
}

export const readThroughputScenario: BenchmarkScenario = {
  id: `throughput-read`,
  name: `Read Throughput`,
  description: `Measure JSON parsing and iteration speed reading back messages`,
  category: `throughput`,
  config: {
    warmupIterations: 1,
    measureIterations: 5,
    messageSize: 100, // ~100 bytes per JSON message
  },
  criteria: {
    minMBPerSecond: 3, // Python is slower, so use lower threshold
  },
  createOperation: (ctx) => ({
    op: `throughput_read`,
    path: `${ctx.basePath}/throughput-read`,
    expectedCount: ctx.setupData.expectedCount as number | undefined,
  }),
  setup: (ctx) => {
    // Expecting 100000 JSON messages to be pre-populated
    ctx.setupData.expectedCount = 100000
    return Promise.resolve({ data: { expectedCount: 100000 } })
  },
}

// =============================================================================
// Streaming Scenarios
// =============================================================================

export const sseLatencyScenario: BenchmarkScenario = {
  id: `streaming-sse-latency`,
  name: `SSE First Event Latency`,
  description: `Measure time to receive first event via SSE`,
  category: `streaming`,
  requires: [`sse`],
  config: {
    warmupIterations: 3,
    measureIterations: 20,
    messageSize: 100,
  },
  criteria: {
    maxP50Ms: 100,
    maxP99Ms: 500,
  },
  createOperation: (ctx) => ({
    op: `roundtrip`,
    path: `${ctx.basePath}/sse-latency-${ctx.iteration}`,
    size: 100,
    live: `sse`,
    contentType: `application/json`, // SSE requires JSON-compatible content type
  }),
}

// =============================================================================
// All Scenarios
// =============================================================================

export const allScenarios: Array<BenchmarkScenario> = [
  // Latency
  appendLatencyScenario,
  readLatencyScenario,
  roundtripLatencyScenario,
  createLatencyScenario,
  // Throughput
  smallMessageThroughputScenario,
  largeMessageThroughputScenario,
  readThroughputScenario,
  // Streaming
  sseLatencyScenario,
]

export const scenariosByCategory: Record<
  `latency` | `throughput` | `streaming`,
  Array<BenchmarkScenario>
> = {
  latency: allScenarios.filter((s) => s.category === `latency`),
  throughput: allScenarios.filter((s) => s.category === `throughput`),
  streaming: allScenarios.filter((s) => s.category === `streaming`),
}

export function getScenarioById(id: string): BenchmarkScenario | undefined {
  return allScenarios.find((s) => s.id === id)
}

export function getScenariosByCategory(
  category: `latency` | `throughput` | `streaming`
): Array<BenchmarkScenario> {
  return scenariosByCategory[category]
}
