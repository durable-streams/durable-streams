/**
 * Benchmark runner for client performance testing.
 *
 * Orchestrates:
 * - Reference server lifecycle
 * - Client adapter process spawning
 * - Benchmark scenario execution
 * - Statistical analysis and reporting
 */

import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { randomUUID } from "node:crypto"
import { DurableStreamTestServer } from "@durable-streams/server"
import { DurableStream } from "@durable-streams/client"
import {
  calculateStats,
  formatStats,
  parseResult,
  serializeCommand,
} from "./protocol.js"
import { allScenarios, getScenarioById } from "./benchmark-scenarios.js"
import type { Interface as ReadlineInterface } from "node:readline"
import type { ChildProcess } from "node:child_process"
import type {
  BenchmarkOpenLoopOp,
  BenchmarkOperation,
  BenchmarkResult,
  BenchmarkStats,
  OpenLoopMetrics,
  TestCommand,
  TestResult,
} from "./protocol.js"
import type {
  BenchmarkScenario,
  ScenarioContext,
} from "./benchmark-scenarios.js"

// =============================================================================
// Types
// =============================================================================

export interface BenchmarkRunnerOptions {
  /** Path to client adapter executable, or "ts" for built-in TypeScript adapter */
  clientAdapter: string
  /** Arguments to pass to client adapter */
  clientArgs?: Array<string>
  /** Specific scenarios to run (default: all) */
  scenarios?: Array<string>
  /** Categories to run (default: all) */
  categories?: Array<`latency` | `throughput` | `streaming` | `open-loop`>
  /** Verbose output */
  verbose?: boolean
  /** Port for reference server (0 for random) */
  serverPort?: number
  /** Output format */
  format?: `console` | `json` | `markdown`
}

export interface ScenarioResult {
  scenario: BenchmarkScenario
  stats: BenchmarkStats
  criteriaMet: boolean
  criteriaDetails: Array<CriteriaResult>
  skipped: boolean
  skipReason?: string
  error?: string
  /** Computed ops/sec for throughput scenarios */
  opsPerSec?: number
  /** Computed MB/sec for throughput scenarios */
  mbPerSec?: number
  /** Open-loop metrics (for open-loop scenarios) */
  openLoop?: OpenLoopMetrics
  /** Saturation test results (for open-loop scenarios) */
  saturation?: {
    /** Highest sustainable RPS found */
    sustainableRps: number
    /** RPS at which saturation was detected */
    saturationRps: number
    /** All steps taken during search */
    steps: Array<{
      targetRps: number
      achievedRps: number
      achievedRatio: number
      queueP99Ms: number
      totalP99Ms: number
      saturated: boolean
    }>
  }
}

export interface CriteriaResult {
  criterion: string
  met: boolean
  actual: number
  expected: number
}

export interface BenchmarkSummary {
  adapter: string
  adapterVersion: string
  serverUrl: string
  timestamp: string
  duration: number
  results: Array<ScenarioResult>
  passed: number
  failed: number
  skipped: number
}

/** Client feature flags reported by the adapter */
interface ClientFeatures {
  batching?: boolean
  sse?: boolean
  longPoll?: boolean
  streaming?: boolean
}

// =============================================================================
// Client Adapter Communication
// =============================================================================

class BenchmarkClientAdapter {
  private process: ChildProcess
  private readline: ReadlineInterface
  private pendingResponse: {
    resolve: (result: TestResult) => void
    reject: (error: Error) => void
  } | null = null
  private initialized = false

  constructor(executable: string, args: Array<string> = []) {
    this.process = spawn(executable, args, {
      stdio: [`pipe`, `pipe`, `pipe`],
    })

    if (!this.process.stdout || !this.process.stdin) {
      throw new Error(`Failed to create client adapter process`)
    }

    this.readline = createInterface({
      input: this.process.stdout,
      crlfDelay: Infinity,
    })

    this.readline.on(`line`, (line) => {
      if (this.pendingResponse) {
        try {
          const result = parseResult(line)
          this.pendingResponse.resolve(result)
        } catch {
          this.pendingResponse.reject(
            new Error(`Failed to parse client response: ${line}`)
          )
        }
        this.pendingResponse = null
      }
    })

    this.process.stderr?.on(`data`, (data) => {
      console.error(`[client stderr] ${data.toString().trim()}`)
    })

    this.process.on(`error`, (err) => {
      if (this.pendingResponse) {
        this.pendingResponse.reject(err)
        this.pendingResponse = null
      }
    })

    this.process.on(`exit`, (code) => {
      if (this.pendingResponse) {
        this.pendingResponse.reject(
          new Error(`Client adapter exited with code ${code}`)
        )
        this.pendingResponse = null
      }
    })
  }

  async send(command: TestCommand, timeoutMs = 60000): Promise<TestResult> {
    if (!this.process.stdin) {
      throw new Error(`Client adapter stdin not available`)
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingResponse = null
        reject(
          new Error(`Command timed out after ${timeoutMs}ms: ${command.type}`)
        )
      }, timeoutMs)

      this.pendingResponse = {
        resolve: (result) => {
          clearTimeout(timeout)
          resolve(result)
        },
        reject: (error) => {
          clearTimeout(timeout)
          reject(error)
        },
      }

      const line = serializeCommand(command) + `\n`
      this.process.stdin!.write(line)
    })
  }

  async init(serverUrl: string): Promise<TestResult> {
    const result = await this.send({ type: `init`, serverUrl })
    if (result.success) {
      this.initialized = true
    }
    return result
  }

  async benchmark(
    iterationId: string,
    operation: BenchmarkOperation
  ): Promise<BenchmarkResult | null> {
    const result = await this.send({
      type: `benchmark`,
      iterationId,
      operation,
    })

    if (result.type === `benchmark`) {
      return result
    }

    return null
  }

  async shutdown(): Promise<void> {
    if (this.initialized) {
      try {
        await this.send({ type: `shutdown` }, 5000)
      } catch {
        // Ignore shutdown errors
      }
    }
    this.process.kill()
    this.readline.close()
  }

  isInitialized(): boolean {
    return this.initialized
  }
}

// =============================================================================
// Open-Loop Saturation Finding
// =============================================================================

interface SaturationStep {
  targetRps: number
  achievedRps: number
  achievedRatio: number
  queueP99Ms: number
  totalP99Ms: number
  saturated: boolean
}

interface SaturationConfig {
  startRps: number
  maxRps: number
  minRps: number
  stepMultiplier: number
  durationMs: number
  warmupMs: number
  queueP99ThresholdMs: number
  achievedRatioThreshold: number
  concurrencyMultiplier: number
}

const defaultSaturationConfig: SaturationConfig = {
  startRps: 1000,
  maxRps: 100000,
  minRps: 10,
  stepMultiplier: 2.0,
  durationMs: 5000,
  warmupMs: 1000,
  queueP99ThresholdMs: 100,
  achievedRatioThreshold: 0.9,
  concurrencyMultiplier: 3,
}

function isSaturated(
  metrics: OpenLoopMetrics,
  config: SaturationConfig
): boolean {
  const achievedRatio = metrics.achievedRps / metrics.targetRps
  return (
    metrics.queueLatency.p99 > config.queueP99ThresholdMs ||
    achievedRatio < config.achievedRatioThreshold
  )
}

/**
 * Run a single open-loop step at the given RPS.
 */
async function runOpenLoopStep(
  client: BenchmarkClientAdapter,
  serverUrl: string,
  innerOp: `append` | `roundtrip`,
  targetRps: number,
  config: SaturationConfig,
  basePath: string
): Promise<{ metrics: OpenLoopMetrics; step: SaturationStep } | null> {
  const maxConcurrency = Math.ceil(targetRps * config.concurrencyMultiplier)

  const openLoopOp: BenchmarkOpenLoopOp = {
    op: `open_loop`,
    innerOp,
    path:
      innerOp === `append`
        ? `${basePath}/saturation-append`
        : `${basePath}/saturation-rt`,
    size: 100,
    targetRps,
    durationMs: config.durationMs,
    warmupMs: config.warmupMs,
    maxConcurrency,
    live: innerOp === `roundtrip` ? `long-poll` : undefined,
  }

  const result = await client.benchmark(`sat-${targetRps}`, openLoopOp)
  if (!result?.openLoop) {
    return null
  }

  const metrics = result.openLoop
  const achievedRatio = metrics.achievedRps / metrics.targetRps

  const step: SaturationStep = {
    targetRps: metrics.targetRps,
    achievedRps: metrics.achievedRps,
    achievedRatio,
    queueP99Ms: metrics.queueLatency.p99,
    totalP99Ms: metrics.totalLatency.p99,
    saturated: isSaturated(metrics, config),
  }

  return { metrics, step }
}

/**
 * Find saturation point for an open-loop scenario using two-phase search.
 *
 * Phase 1: If starting RPS saturates, back off until we find a sustainable baseline
 * Phase 2: Ramp up from baseline until we hit saturation
 */
async function runOpenLoopWithSaturationFinding(
  scenario: BenchmarkScenario,
  client: BenchmarkClientAdapter,
  serverUrl: string,
  log: (message: string) => void
): Promise<ScenarioResult> {
  const basePath = `/bench-${randomUUID()}`
  const steps: Array<SaturationStep> = []
  const config = { ...defaultSaturationConfig }

  // Use scenario's target RPS as starting point
  const scenarioConfig = scenario.config
  if (scenarioConfig.targetRps) {
    config.startRps = scenarioConfig.targetRps
  }

  // Determine inner operation from scenario
  const innerOp: `append` | `roundtrip` = scenario.id.includes(`roundtrip`)
    ? `roundtrip`
    : `append`

  // Pre-create stream for append tests
  if (innerOp === `append`) {
    const streamUrl = `${serverUrl}${basePath}/saturation-append`
    await DurableStream.create({
      url: streamUrl,
      contentType: `application/octet-stream`,
    })
  }

  let currentRps = config.startRps
  let sustainableRps = 0
  let saturationRps = 0
  let lastMetrics: OpenLoopMetrics | undefined

  log(`  Finding saturation point (start=${config.startRps} req/s)...`)

  // Phase 1: Find a sustainable baseline (backing off if needed)
  let foundBaseline = false

  while (!foundBaseline && currentRps >= config.minRps) {
    log(`    Testing ${currentRps} req/s...`)

    const result = await runOpenLoopStep(
      client,
      serverUrl,
      innerOp,
      currentRps,
      config,
      basePath
    )

    if (!result) {
      log(`      ✗ No metrics returned`)
      break
    }

    const { metrics, step } = result
    steps.push(step)
    lastMetrics = metrics

    const achievedPct = (step.achievedRatio * 100).toFixed(0)
    const icon = step.saturated ? `⚠️` : `✓`
    log(
      `      ${icon} ${step.achievedRps.toFixed(0)} (${achievedPct}%) qP99=${step.queueP99Ms.toFixed(1)}ms`
    )

    if (step.saturated) {
      const lowerRps = Math.floor(currentRps / config.stepMultiplier)
      if (lowerRps >= config.minRps) {
        log(`      → Backing off to ${lowerRps} req/s`)
        currentRps = lowerRps
      } else {
        log(`      → At minimum RPS, cannot back off further`)
        saturationRps = currentRps
        break
      }
    } else {
      sustainableRps = currentRps
      foundBaseline = true
      log(`      → Baseline found at ${currentRps} req/s`)
    }
  }

  // Phase 2: Ramp up to find saturation point
  if (foundBaseline) {
    currentRps = Math.ceil(sustainableRps * config.stepMultiplier)

    while (currentRps <= config.maxRps) {
      log(`    Testing ${currentRps} req/s...`)

      const result = await runOpenLoopStep(
        client,
        serverUrl,
        innerOp,
        currentRps,
        config,
        basePath
      )

      if (!result) {
        log(`      ✗ No metrics returned`)
        break
      }

      const { metrics, step } = result
      steps.push(step)
      lastMetrics = metrics

      const achievedPct = (step.achievedRatio * 100).toFixed(0)
      const icon = step.saturated ? `⚠️` : `✓`
      log(
        `      ${icon} ${step.achievedRps.toFixed(0)} (${achievedPct}%) qP99=${step.queueP99Ms.toFixed(1)}ms`
      )

      if (step.saturated) {
        saturationRps = currentRps
        log(`      → Saturated at ${currentRps} req/s`)
        break
      } else {
        sustainableRps = currentRps
        currentRps = Math.ceil(currentRps * config.stepMultiplier)
      }
    }

    if (saturationRps === 0 && currentRps > config.maxRps) {
      log(`      → Reached max RPS (${config.maxRps}) without saturating`)
    }
  }

  // Build result
  const saturationResult = {
    sustainableRps,
    saturationRps,
    steps,
  }

  // Use the last metrics for the open-loop result
  const openLoop = lastMetrics

  // Criteria: sustainable RPS should meet some minimum
  // For now, consider it "passed" if we found a sustainable point
  const criteriaMet = sustainableRps > 0

  return {
    scenario,
    stats: calculateStats([]),
    criteriaMet,
    criteriaDetails: [],
    skipped: false,
    openLoop,
    saturation: saturationResult,
  }
}

// =============================================================================
// Scenario Execution
// =============================================================================

async function runScenario(
  scenario: BenchmarkScenario,
  client: BenchmarkClientAdapter,
  serverUrl: string,
  clientFeatures: ClientFeatures,
  verbose: boolean,
  log: (message: string) => void
): Promise<ScenarioResult> {
  // Check required features
  if (scenario.requires) {
    const missing = scenario.requires.filter((f) => !clientFeatures[f])
    if (missing.length > 0) {
      return {
        scenario,
        stats: calculateStats([]),
        criteriaMet: true,
        criteriaDetails: [],
        skipped: true,
        skipReason: `missing features: ${missing.join(`, `)}`,
      }
    }
  }

  // For open-loop scenarios, use saturation-finding instead of fixed RPS
  if (scenario.category === `open-loop`) {
    try {
      return await runOpenLoopWithSaturationFinding(
        scenario,
        client,
        serverUrl,
        log
      )
    } catch (err) {
      return {
        scenario,
        stats: calculateStats([]),
        criteriaMet: false,
        criteriaDetails: [],
        skipped: false,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  const basePath = `/bench-${randomUUID()}`
  const durations: Array<bigint> = []

  try {
    // Create the base stream for the scenario if needed
    const setupCtx: ScenarioContext = {
      basePath,
      iteration: 0,
      setupData: {},
    }

    // Run setup
    if (scenario.setup) {
      await scenario.setup(setupCtx)
    }

    // Pre-create stream for append/read scenarios
    if (
      scenario.id === `latency-append` ||
      scenario.id === `latency-read` ||
      scenario.id.startsWith(`throughput-`)
    ) {
      const streamUrl = `${serverUrl}${basePath}/stream`
      await DurableStream.create({
        url: streamUrl,
        contentType: `application/octet-stream`,
      })

      // For read latency, pre-populate with some data so we're measuring actual reads
      if (scenario.id === `latency-read`) {
        const stream = new DurableStream({
          url: streamUrl,
          contentType: `application/octet-stream`,
        })
        // Add 10 chunks of 1KB each (10KB total)
        const chunk = new Uint8Array(1024).fill(42)
        for (let i = 0; i < 10; i++) {
          await stream.append(chunk)
        }
      }

      // For read throughput, pre-populate with JSON messages
      if (scenario.id === `throughput-read`) {
        const url = `${serverUrl}${basePath}/throughput-read`
        // Create the stream with JSON content type
        await DurableStream.create({
          url,
          contentType: `application/json`,
        })
        const ds = new DurableStream({
          url,
          contentType: `application/json`,
        })
        // Populate with 10000 JSON messages (each ~100 bytes)
        // Using batching for speed - append many at once
        const messages = []
        for (let i = 0; i < 10000; i++) {
          messages.push({ n: i, data: `message-${i}-padding-for-size` })
        }
        // Batch append for speed
        await Promise.all(messages.map((msg) => ds.append(msg)))
      }
    }

    // Pre-create streams for open-loop append scenarios
    if (scenario.id === `open-loop-append`) {
      const streamUrl = `${serverUrl}${basePath}/open-loop-append`
      await DurableStream.create({
        url: streamUrl,
        contentType: `application/octet-stream`,
      })
    }
    if (scenario.id === `open-loop-append-high`) {
      const streamUrl = `${serverUrl}${basePath}/open-loop-append-high`
      await DurableStream.create({
        url: streamUrl,
        contentType: `application/octet-stream`,
      })
    }

    // Warmup iterations
    if (verbose) {
      log(`  Warmup: ${scenario.config.warmupIterations} iterations...`)
    }

    for (let i = 0; i < scenario.config.warmupIterations; i++) {
      const ctx: ScenarioContext = {
        basePath,
        iteration: i,
        setupData: setupCtx.setupData,
      }
      const operation = scenario.createOperation(ctx)
      await client.benchmark(`warmup-${i}`, operation)
    }

    // Measured iterations
    if (verbose) {
      log(`  Measuring: ${scenario.config.measureIterations} iterations...`)
    }

    let totalMessagesProcessed = 0
    let totalBytesTransferred = 0
    let openLoopMetrics: OpenLoopMetrics | undefined

    for (let i = 0; i < scenario.config.measureIterations; i++) {
      const ctx: ScenarioContext = {
        basePath,
        iteration: i,
        setupData: setupCtx.setupData,
      }
      const operation = scenario.createOperation(ctx)
      const result = await client.benchmark(`measure-${i}`, operation)

      if (result) {
        durations.push(BigInt(result.durationNs))
        // Track metrics for throughput calculations
        if (result.metrics) {
          totalMessagesProcessed += result.metrics.messagesProcessed ?? 0
          totalBytesTransferred += result.metrics.bytesTransferred ?? 0
        }
        // Capture open-loop metrics
        if (result.openLoop) {
          openLoopMetrics = result.openLoop
        }
      }
    }

    // Cleanup
    if (scenario.cleanup) {
      await scenario.cleanup(setupCtx)
    }

    // Fail if no samples were collected (adapter errors or missing results)
    if (durations.length === 0) {
      return {
        scenario,
        stats: calculateStats([]),
        criteriaMet: false,
        criteriaDetails: [],
        skipped: false,
        error: `No benchmark samples collected (adapter returned no results)`,
      }
    }

    // Calculate statistics
    const stats = calculateStats(durations)

    // Calculate total time in seconds for throughput
    const totalTimeMs = durations.reduce(
      (sum, ns) => sum + Number(ns) / 1_000_000,
      0
    )
    const totalTimeSec = totalTimeMs / 1000

    // Compute ops/sec for throughput scenarios
    // Use actual messages processed if available, otherwise estimate from mean latency
    let computedOpsPerSec: number | undefined
    let computedMbPerSec: number | undefined
    if (scenario.category === `throughput`) {
      if (totalMessagesProcessed > 0 && totalTimeSec > 0) {
        computedOpsPerSec = totalMessagesProcessed / totalTimeSec
      } else if (stats.mean > 0) {
        computedOpsPerSec = 1000 / stats.mean
      }
      // Compute MB/sec from bytes transferred
      if (totalBytesTransferred > 0 && totalTimeSec > 0) {
        computedMbPerSec = totalBytesTransferred / 1024 / 1024 / totalTimeSec
      }
    }

    // Check criteria
    const criteriaDetails: Array<CriteriaResult> = []
    let criteriaMet = true

    // For open-loop scenarios, use the total latency from open-loop metrics
    const effectiveMedian = openLoopMetrics
      ? openLoopMetrics.totalLatency.median
      : stats.median
    const effectiveP99 = openLoopMetrics
      ? openLoopMetrics.totalLatency.p99
      : stats.p99

    if (scenario.criteria) {
      if (scenario.criteria.maxP50Ms !== undefined) {
        const met = effectiveMedian <= scenario.criteria.maxP50Ms
        criteriaDetails.push({
          criterion: `p50 <= ${scenario.criteria.maxP50Ms}ms`,
          met,
          actual: effectiveMedian,
          expected: scenario.criteria.maxP50Ms,
        })
        if (!met) criteriaMet = false
      }

      if (scenario.criteria.maxP99Ms !== undefined) {
        const met = effectiveP99 <= scenario.criteria.maxP99Ms
        criteriaDetails.push({
          criterion: `p99 <= ${scenario.criteria.maxP99Ms}ms`,
          met,
          actual: effectiveP99,
          expected: scenario.criteria.maxP99Ms,
        })
        if (!met) criteriaMet = false
      }

      if (scenario.criteria.minOpsPerSecond !== undefined) {
        const opsPerSec = computedOpsPerSec ?? 0
        const met = opsPerSec >= scenario.criteria.minOpsPerSecond
        criteriaDetails.push({
          criterion: `ops/sec >= ${scenario.criteria.minOpsPerSecond}`,
          met,
          actual: opsPerSec,
          expected: scenario.criteria.minOpsPerSecond,
        })
        if (!met) criteriaMet = false
      }

      if (scenario.criteria.minMBPerSecond !== undefined) {
        const mbPerSec =
          totalTimeSec > 0
            ? totalBytesTransferred / 1024 / 1024 / totalTimeSec
            : 0
        const met = mbPerSec >= scenario.criteria.minMBPerSecond
        criteriaDetails.push({
          criterion: `MB/sec >= ${scenario.criteria.minMBPerSecond}`,
          met,
          actual: mbPerSec,
          expected: scenario.criteria.minMBPerSecond,
        })
        if (!met) criteriaMet = false
      }
    }

    return {
      scenario,
      stats,
      criteriaMet,
      criteriaDetails,
      skipped: false,
      opsPerSec: computedOpsPerSec,
      mbPerSec: computedMbPerSec,
      openLoop: openLoopMetrics,
    }
  } catch (err) {
    return {
      scenario,
      stats: calculateStats([]),
      criteriaMet: false,
      criteriaDetails: [],
      skipped: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// =============================================================================
// Output Formatting
// =============================================================================

function printConsoleResults(summary: BenchmarkSummary): void {
  console.log(`\n${`=`.repeat(60)}`)
  console.log(`CLIENT BENCHMARK RESULTS`)
  console.log(`${`=`.repeat(60)}`)
  console.log(`Adapter: ${summary.adapter} v${summary.adapterVersion}`)
  console.log(`Server: ${summary.serverUrl}`)
  console.log(`Timestamp: ${summary.timestamp}`)
  console.log(`Duration: ${(summary.duration / 1000).toFixed(2)}s`)
  console.log()

  // Group by category
  const byCategory = {
    latency: summary.results.filter((r) => r.scenario.category === `latency`),
    throughput: summary.results.filter(
      (r) => r.scenario.category === `throughput`
    ),
    streaming: summary.results.filter(
      (r) => r.scenario.category === `streaming`
    ),
    "open-loop": summary.results.filter(
      (r) => r.scenario.category === `open-loop`
    ),
  }

  for (const [category, results] of Object.entries(byCategory)) {
    if (results.length === 0) continue

    console.log(`\n${category.toUpperCase()}`)
    console.log(`${`-`.repeat(40)}`)

    for (const result of results) {
      const icon = result.skipped ? `○` : result.criteriaMet ? `✓` : `✗`
      const status = result.skipped
        ? `skipped: ${result.skipReason}`
        : result.error
          ? `error: ${result.error}`
          : result.criteriaMet
            ? `passed`
            : `failed`

      console.log(`${icon} ${result.scenario.name} (${status})`)

      if (!result.skipped && !result.error) {
        const formatted = formatStats(result.stats)
        // Show ops/sec and MB/sec for throughput scenarios, latency for others
        // For read throughput, only show MB/sec (ops/sec is not meaningful)
        if (result.scenario.category === `throughput`) {
          const mbStr = result.mbPerSec
            ? result.mbPerSec.toLocaleString(`en-US`, {
                minimumFractionDigits: 1,
                maximumFractionDigits: 1,
              })
            : `N/A`
          if (result.scenario.id === `throughput-read`) {
            console.log(`    MB/sec: ${mbStr}`)
          } else {
            const opsStr = result.opsPerSec
              ? result.opsPerSec.toLocaleString(`en-US`, {
                  maximumFractionDigits: 0,
                })
              : `N/A`
            console.log(`    Ops/sec: ${opsStr}  MB/sec: ${mbStr}`)
          }
        } else if (
          result.scenario.category === `open-loop` &&
          result.saturation
        ) {
          // Display saturation-finding results
          const sat = result.saturation
          if (sat.saturationRps > 0) {
            console.log(
              `    Saturates between ${sat.sustainableRps.toLocaleString()} and ${sat.saturationRps.toLocaleString()} req/s`
            )
          } else {
            console.log(
              `    Sustainable up to ${sat.sustainableRps.toLocaleString()} req/s (no saturation found)`
            )
          }
          // Show the last successful step's latency
          const lastOkStep = [...sat.steps].reverse().find((s) => !s.saturated)
          if (lastOkStep) {
            console.log(
              `    At ${lastOkStep.targetRps.toLocaleString()} req/s: qP99=${lastOkStep.queueP99Ms.toFixed(1)}ms  totalP99=${lastOkStep.totalP99Ms.toFixed(1)}ms`
            )
          }
        } else {
          console.log(`    Median: ${formatted.Median}  P99: ${formatted.P99}`)
        }

        if (!result.criteriaMet) {
          for (const c of result.criteriaDetails.filter((d) => !d.met)) {
            console.log(
              `    ✗ ${c.criterion}: got ${c.actual.toFixed(2)}, expected ${c.expected}`
            )
          }
        }
      }
    }
  }

  console.log(`\n${`=`.repeat(60)}`)
  console.log(
    `Summary: ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped`
  )
  console.log(`${`=`.repeat(60)}\n`)
}

function generateMarkdownReport(summary: BenchmarkSummary): string {
  const lines: Array<string> = []

  // Create collapsible section with summary status
  const statusIcon = summary.failed === 0 ? `✓` : `✗`
  const statusText =
    summary.failed === 0
      ? `${summary.passed} passed`
      : `${summary.passed} passed, ${summary.failed} failed`

  lines.push(`<details>`)
  lines.push(
    `<summary><strong>${summary.adapter}</strong>: ${statusText} ${statusIcon}</summary>`
  )
  lines.push(``)
  lines.push(`### ${summary.adapter} v${summary.adapterVersion}`)
  lines.push(``)
  lines.push(`**Server**: ${summary.serverUrl}`)
  lines.push(`**Date**: ${summary.timestamp}`)
  lines.push(`**Duration**: ${(summary.duration / 1000).toFixed(2)}s`)
  lines.push(``)

  // Latency section
  const latencyResults = summary.results.filter(
    (r) => r.scenario.category === `latency` && !r.skipped && !r.error
  )
  if (latencyResults.length > 0) {
    lines.push(`#### Latency`)
    lines.push(``)
    lines.push(
      `Single-operation latency tests measure the time for individual operations to complete.`
    )
    lines.push(``)
    lines.push(
      `| Scenario | Description | Min | Median | P95 | P99 | Max | Status |`
    )
    lines.push(
      `|----------|-------------|-----|--------|-----|-----|-----|--------|`
    )
    for (const r of latencyResults) {
      const s = r.stats
      const status = r.criteriaMet ? `Pass` : `Fail`
      lines.push(
        `| ${r.scenario.name} | ${r.scenario.description} | ${s.min.toFixed(2)}ms | ${s.median.toFixed(2)}ms | ${s.p95.toFixed(2)}ms | ${s.p99.toFixed(2)}ms | ${s.max.toFixed(2)}ms | ${status} |`
      )
    }
    lines.push(``)
  }

  // Throughput section
  const throughputResults = summary.results.filter(
    (r) => r.scenario.category === `throughput` && !r.skipped && !r.error
  )
  if (throughputResults.length > 0) {
    lines.push(`#### Throughput`)
    lines.push(``)
    lines.push(
      `Throughput tests measure how quickly the client can batch and send/receive data.`
    )
    lines.push(
      `Writes use automatic batching to maximize operations per second.`
    )
    lines.push(`Reads measure JSON parsing and iteration speed.`)
    lines.push(``)
    lines.push(`| Scenario | Description | Ops/sec | MB/sec | Status |`)
    lines.push(`|----------|-------------|---------|--------|--------|`)
    for (const r of throughputResults) {
      // For read throughput, ops/sec is not meaningful - show "-"
      const opsPerSec =
        r.scenario.id === `throughput-read`
          ? `-`
          : r.opsPerSec !== undefined
            ? r.opsPerSec.toLocaleString(`en-US`, { maximumFractionDigits: 0 })
            : `N/A`
      const mbPerSec =
        r.mbPerSec !== undefined
          ? r.mbPerSec.toLocaleString(`en-US`, {
              minimumFractionDigits: 1,
              maximumFractionDigits: 1,
            })
          : `N/A`
      const status = r.criteriaMet ? `Pass` : `Fail`
      lines.push(
        `| ${r.scenario.name} | ${r.scenario.description} | ${opsPerSec} | ${mbPerSec} | ${status} |`
      )
    }
    lines.push(``)
  }

  // Streaming section
  const streamingResults = summary.results.filter(
    (r) => r.scenario.category === `streaming` && !r.skipped && !r.error
  )
  if (streamingResults.length > 0) {
    lines.push(`#### Streaming`)
    lines.push(``)
    lines.push(
      `Streaming tests measure real-time event delivery via SSE (Server-Sent Events).`
    )
    lines.push(``)
    lines.push(
      `| Scenario | Description | Min | Median | P95 | P99 | Max | Status |`
    )
    lines.push(
      `|----------|-------------|-----|--------|-----|-----|-----|--------|`
    )
    for (const r of streamingResults) {
      const s = r.stats
      const status = r.criteriaMet ? `Pass` : `Fail`
      lines.push(
        `| ${r.scenario.name} | ${r.scenario.description} | ${s.min.toFixed(2)}ms | ${s.median.toFixed(2)}ms | ${s.p95.toFixed(2)}ms | ${s.p99.toFixed(2)}ms | ${s.max.toFixed(2)}ms | ${status} |`
      )
    }
    lines.push(``)
  }

  // Open-loop section
  const openLoopResults = summary.results.filter(
    (r) => r.scenario.category === `open-loop` && !r.skipped && !r.error
  )
  if (openLoopResults.length > 0) {
    lines.push(`#### Open-Loop Saturation`)
    lines.push(``)
    lines.push(
      `Open-loop tests find the sustainable RPS by ramping load until queue latency explodes.`
    )
    lines.push(
      `This reveals true performance limits that closed-loop tests hide.`
    )
    lines.push(``)
    lines.push(
      `| Scenario | Sustainable RPS | Saturates At | Queue P99 | Total P99 |`
    )
    lines.push(
      `|----------|-----------------|--------------|-----------|-----------|`
    )
    for (const r of openLoopResults) {
      const sat = r.saturation
      if (sat) {
        const sustainableStr = sat.sustainableRps.toLocaleString()
        const saturationStr =
          sat.saturationRps > 0
            ? sat.saturationRps.toLocaleString()
            : `> ${sat.sustainableRps.toLocaleString()}`
        // Get latency from the last sustainable step
        const lastOkStep = [...sat.steps].reverse().find((s) => !s.saturated)
        const queueP99 = lastOkStep ? lastOkStep.queueP99Ms.toFixed(1) : `-`
        const totalP99 = lastOkStep ? lastOkStep.totalP99Ms.toFixed(1) : `-`
        lines.push(
          `| ${r.scenario.name} | ${sustainableStr} | ${saturationStr} | ${queueP99}ms | ${totalP99}ms |`
        )
      }
    }
    lines.push(``)
  }

  // Summary
  lines.push(`#### Summary`)
  lines.push(``)
  lines.push(`- **Passed**: ${summary.passed}`)
  lines.push(`- **Failed**: ${summary.failed}`)
  lines.push(`- **Skipped**: ${summary.skipped}`)
  lines.push(``)
  lines.push(`</details>`)

  return lines.join(`\n`)
}

// =============================================================================
// Public API
// =============================================================================

export async function runBenchmarks(
  options: BenchmarkRunnerOptions
): Promise<BenchmarkSummary> {
  const startTime = Date.now()
  const results: Array<ScenarioResult> = []

  // When format is json or markdown, progress output goes to stderr so only the report goes to stdout
  const log = (message: string): void => {
    if (options.format === `json` || options.format === `markdown`) {
      process.stderr.write(message + `\n`)
    } else {
      console.log(message)
    }
  }

  // Filter scenarios
  let scenarios = allScenarios
  if (options.scenarios && options.scenarios.length > 0) {
    scenarios = options.scenarios
      .map((id) => getScenarioById(id))
      .filter((s): s is BenchmarkScenario => s !== undefined)
  }
  if (options.categories && options.categories.length > 0) {
    scenarios = scenarios.filter((s) =>
      options.categories!.includes(s.category)
    )
  }

  log(`\nRunning ${scenarios.length} benchmark scenarios...\n`)

  // Start reference server
  const server = new DurableStreamTestServer({ port: options.serverPort ?? 0 })
  await server.start()
  const serverUrl = server.url

  log(`Reference server started at ${serverUrl}\n`)

  // Resolve client adapter path
  let adapterPath = options.clientAdapter
  let adapterArgs = options.clientArgs ?? []

  if (adapterPath === `ts` || adapterPath === `typescript`) {
    // Determine if we're running from compiled dist or source
    // import.meta.url will be .../dist/... or .../src/...
    const isCompiledDist = import.meta.url.includes(`/dist/`)

    if (isCompiledDist) {
      // Use the compiled adapter directly
      adapterPath = `node`
      adapterArgs = [
        new URL(`./adapters/typescript-adapter.js`, import.meta.url).pathname,
      ]
    } else {
      // Running from source via tsx
      adapterPath = `npx`
      adapterArgs = [
        `tsx`,
        new URL(`./adapters/typescript-adapter.ts`, import.meta.url).pathname,
      ]
    }
  }

  // Start client adapter
  const client = new BenchmarkClientAdapter(adapterPath, adapterArgs)

  let adapterName = `unknown`
  let adapterVersion = `0.0.0`
  let clientFeatures: ClientFeatures = {}

  try {
    // Initialize client
    const initResult = await client.init(serverUrl)
    if (!initResult.success) {
      throw new Error(`Failed to initialize client adapter`)
    }

    if (initResult.type === `init`) {
      adapterName = initResult.clientName
      adapterVersion = initResult.clientVersion
      clientFeatures = initResult.features ?? {}

      log(`Client: ${adapterName} v${adapterVersion}`)
      const featureList = Object.entries(clientFeatures)
        .filter(([, v]) => v)
        .map(([k]) => k)
      log(`Features: ${featureList.join(`, `) || `none`}\n`)
    }

    // Run each scenario
    for (const scenario of scenarios) {
      log(`\n${scenario.name}`)
      log(`${`─`.repeat(scenario.name.length)}`)
      log(`${scenario.description}`)

      const result = await runScenario(
        scenario,
        client,
        serverUrl,
        clientFeatures,
        options.verbose ?? false,
        log
      )

      results.push(result)

      if (result.skipped) {
        log(`  Skipped: ${result.skipReason}`)
      } else if (result.error) {
        log(`  Error: ${result.error}`)
      } else {
        const icon = result.criteriaMet ? `✓` : `✗`
        // Show ops/sec and MB/sec for throughput, latency for others
        // For read throughput, only show MB/sec (ops/sec is not meaningful)
        if (result.scenario.category === `throughput`) {
          const mbStr = result.mbPerSec
            ? result.mbPerSec.toLocaleString(`en-US`, {
                minimumFractionDigits: 1,
                maximumFractionDigits: 1,
              })
            : `N/A`
          if (result.scenario.id === `throughput-read`) {
            log(`  ${icon} MB/sec: ${mbStr}`)
          } else {
            const opsStr = result.opsPerSec
              ? result.opsPerSec.toLocaleString(`en-US`, {
                  maximumFractionDigits: 0,
                })
              : `N/A`
            log(`  ${icon} Ops/sec: ${opsStr}, MB/sec: ${mbStr}`)
          }
        } else if (
          result.scenario.category === `open-loop` &&
          result.saturation
        ) {
          // Display saturation finding result
          const sat = result.saturation
          if (sat.saturationRps > 0) {
            log(
              `  ${icon} Saturates between ${sat.sustainableRps.toLocaleString()} and ${sat.saturationRps.toLocaleString()} req/s`
            )
          } else {
            log(
              `  ${icon} Sustainable up to ${sat.sustainableRps.toLocaleString()} req/s`
            )
          }
        } else {
          log(
            `  ${icon} Median: ${result.stats.median.toFixed(2)}ms, P99: ${result.stats.p99.toFixed(2)}ms`
          )
        }
      }
    }
  } finally {
    await client.shutdown()
    await server.stop()
  }

  const summary: BenchmarkSummary = {
    adapter: adapterName,
    adapterVersion,
    serverUrl,
    timestamp: new Date().toISOString(),
    duration: Date.now() - startTime,
    results,
    passed: results.filter((r) => !r.skipped && !r.error && r.criteriaMet)
      .length,
    failed: results.filter((r) => !r.skipped && (!r.criteriaMet || r.error))
      .length,
    skipped: results.filter((r) => r.skipped).length,
  }

  // Output results
  switch (options.format) {
    case `json`:
      console.log(JSON.stringify(summary, null, 2))
      break
    case `markdown`:
      console.log(generateMarkdownReport(summary))
      break
    default:
      printConsoleResults(summary)
  }

  return summary
}

export { allScenarios, getScenarioById }
