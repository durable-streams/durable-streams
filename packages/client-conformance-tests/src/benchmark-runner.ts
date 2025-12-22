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
  BenchmarkOperation,
  BenchmarkResult,
  BenchmarkStats,
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
  categories?: Array<`latency` | `throughput` | `streaming`>
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
// Scenario Execution
// =============================================================================

async function runScenario(
  scenario: BenchmarkScenario,
  client: BenchmarkClientAdapter,
  serverUrl: string,
  clientFeatures: ClientFeatures,
  verbose: boolean
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
      await DurableStream.create({
        url: `${serverUrl}${basePath}/stream`,
        contentType: `application/octet-stream`,
      })

      // For read throughput, pre-populate with data
      if (scenario.id === `throughput-read`) {
        const url = `${serverUrl}${basePath}/throughput-read`
        // Create the stream first
        await DurableStream.create({
          url,
          contentType: `application/octet-stream`,
        })
        const stream = new DurableStream({
          url,
          contentType: `application/octet-stream`,
        })
        // Populate with ~10MB
        const chunk = new Uint8Array(1024 * 100).fill(42) // 100KB
        for (let i = 0; i < 100; i++) {
          await stream.append(chunk)
        }
      }
    }

    // Warmup iterations
    if (verbose) {
      console.log(`  Warmup: ${scenario.config.warmupIterations} iterations...`)
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
      console.log(
        `  Measuring: ${scenario.config.measureIterations} iterations...`
      )
    }

    let totalMessagesProcessed = 0
    let totalBytesTransferred = 0

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
      }
    }

    // Cleanup
    if (scenario.cleanup) {
      await scenario.cleanup(setupCtx)
    }

    // Calculate statistics
    const stats = calculateStats(durations)

    // Calculate total time in seconds for throughput
    const totalTimeMs = durations.reduce(
      (sum, ns) => sum + Number(ns) / 1_000_000,
      0
    )
    const totalTimeSec = totalTimeMs / 1000

    // Check criteria
    const criteriaDetails: Array<CriteriaResult> = []
    let criteriaMet = true

    if (scenario.criteria) {
      if (scenario.criteria.maxP50Ms !== undefined) {
        const met = stats.median <= scenario.criteria.maxP50Ms
        criteriaDetails.push({
          criterion: `p50 <= ${scenario.criteria.maxP50Ms}ms`,
          met,
          actual: stats.median,
          expected: scenario.criteria.maxP50Ms,
        })
        if (!met) criteriaMet = false
      }

      if (scenario.criteria.maxP99Ms !== undefined) {
        const met = stats.p99 <= scenario.criteria.maxP99Ms
        criteriaDetails.push({
          criterion: `p99 <= ${scenario.criteria.maxP99Ms}ms`,
          met,
          actual: stats.p99,
          expected: scenario.criteria.maxP99Ms,
        })
        if (!met) criteriaMet = false
      }

      if (scenario.criteria.minOpsPerSecond !== undefined) {
        // For throughput scenarios, use actual messages processed
        // For latency scenarios, use 1000/mean as ops/sec
        let opsPerSec: number
        if (totalMessagesProcessed > 0 && totalTimeSec > 0) {
          opsPerSec = totalMessagesProcessed / totalTimeSec
        } else {
          opsPerSec = stats.mean > 0 ? 1000 / stats.mean : 0
        }
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
        console.log(`    Median: ${formatted.Median}  P99: ${formatted.P99}`)

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

  lines.push(`# Client Benchmark Results`)
  lines.push(``)
  lines.push(`**Adapter**: ${summary.adapter} v${summary.adapterVersion}`)
  lines.push(`**Server**: ${summary.serverUrl}`)
  lines.push(`**Date**: ${summary.timestamp}`)
  lines.push(`**Duration**: ${(summary.duration / 1000).toFixed(2)}s`)
  lines.push(``)

  // Latency table
  const latencyResults = summary.results.filter(
    (r) => r.scenario.category === `latency` && !r.skipped && !r.error
  )
  if (latencyResults.length > 0) {
    lines.push(`## Latency (ms)`)
    lines.push(``)
    lines.push(`| Scenario | Min | Median | P95 | P99 | Max | Status |`)
    lines.push(`|----------|-----|--------|-----|-----|-----|--------|`)
    for (const r of latencyResults) {
      const s = r.stats
      const status = r.criteriaMet ? `Pass` : `Fail`
      lines.push(
        `| ${r.scenario.name} | ${s.min.toFixed(2)} | ${s.median.toFixed(2)} | ${s.p95.toFixed(2)} | ${s.p99.toFixed(2)} | ${s.max.toFixed(2)} | ${status} |`
      )
    }
    lines.push(``)
  }

  // Throughput table
  const throughputResults = summary.results.filter(
    (r) => r.scenario.category === `throughput` && !r.skipped && !r.error
  )
  if (throughputResults.length > 0) {
    lines.push(`## Throughput`)
    lines.push(``)
    lines.push(`| Scenario | Mean (ms) | Ops/sec | Status |`)
    lines.push(`|----------|-----------|---------|--------|`)
    for (const r of throughputResults) {
      const opsPerSec =
        r.stats.mean > 0 ? (1000 / r.stats.mean).toFixed(0) : `N/A`
      const status = r.criteriaMet ? `Pass` : `Fail`
      lines.push(
        `| ${r.scenario.name} | ${r.stats.mean.toFixed(2)} | ${opsPerSec} | ${status} |`
      )
    }
    lines.push(``)
  }

  // Summary
  lines.push(`## Summary`)
  lines.push(``)
  lines.push(`- **Passed**: ${summary.passed}`)
  lines.push(`- **Failed**: ${summary.failed}`)
  lines.push(`- **Skipped**: ${summary.skipped}`)

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

  console.log(`\nRunning ${scenarios.length} benchmark scenarios...\n`)

  // Start reference server
  const server = new DurableStreamTestServer({ port: options.serverPort ?? 0 })
  await server.start()
  const serverUrl = server.url

  console.log(`Reference server started at ${serverUrl}\n`)

  // Resolve client adapter path
  let adapterPath = options.clientAdapter
  let adapterArgs = options.clientArgs ?? []

  if (adapterPath === `ts` || adapterPath === `typescript`) {
    adapterPath = `npx`
    adapterArgs = [
      `tsx`,
      new URL(`./adapters/typescript-adapter.ts`, import.meta.url).pathname,
    ]
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

      console.log(`Client: ${adapterName} v${adapterVersion}`)
      const featureList = Object.entries(clientFeatures)
        .filter(([, v]) => v)
        .map(([k]) => k)
      console.log(`Features: ${featureList.join(`, `) || `none`}\n`)
    }

    // Run each scenario
    for (const scenario of scenarios) {
      console.log(`\n${scenario.name}`)
      console.log(`${`─`.repeat(scenario.name.length)}`)
      console.log(`${scenario.description}`)

      const result = await runScenario(
        scenario,
        client,
        serverUrl,
        clientFeatures,
        options.verbose ?? false
      )

      results.push(result)

      if (result.skipped) {
        console.log(`  Skipped: ${result.skipReason}`)
      } else if (result.error) {
        console.log(`  Error: ${result.error}`)
      } else {
        const icon = result.criteriaMet ? `✓` : `✗`
        console.log(
          `  ${icon} Median: ${result.stats.median.toFixed(2)}ms, P99: ${result.stats.p99.toFixed(2)}ms`
        )
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
