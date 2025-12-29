/**
 * Saturation finder - automatically discovers the sustainable RPS for an operation.
 *
 * Ramps up load until queue latency explodes or achieved RPS falls behind target,
 * then reports the sustainable limit.
 */

import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { randomUUID } from "node:crypto"
import { DurableStreamTestServer } from "@durable-streams/server"
import { DurableStream } from "@durable-streams/client"
import { parseResult, serializeCommand } from "./protocol.js"
import type { Interface as ReadlineInterface } from "node:readline"
import type { ChildProcess } from "node:child_process"
import type {
  BenchmarkOpenLoopOp,
  OpenLoopMetrics,
  TestCommand,
  TestResult,
} from "./protocol.js"

export interface SaturationStep {
  /** Target RPS for this step */
  targetRps: number
  /** Actually achieved RPS */
  achievedRps: number
  /** Ratio of achieved to target (1.0 = 100%) */
  achievedRatio: number
  /** Queue latency p99 in ms */
  queueP99Ms: number
  /** Total latency p99 in ms */
  totalP99Ms: number
  /** Total latency p50 in ms */
  totalP50Ms: number
  /** Whether this step saturated the system */
  saturated: boolean
}

export interface SaturationResult {
  /** Operation type tested */
  operation: `append` | `read` | `roundtrip`
  /** Highest RPS where system wasn't saturated */
  sustainableRps: number
  /** RPS at which saturation occurred (0 if never saturated) */
  saturationRps: number
  /** Queue p99 at saturation point */
  saturationQueueP99Ms: number
  /** All steps taken during the search */
  steps: Array<SaturationStep>
  /** Reason saturation was detected */
  saturationReason?: `queue_latency` | `achieved_ratio` | `max_rps_reached`
}

export interface SaturationConfig {
  /** Starting RPS */
  startRps: number
  /** Maximum RPS to test (safety limit) */
  maxRps: number
  /** Multiplier for each step (e.g., 1.5 = 50% increase) */
  stepMultiplier: number
  /** Duration per step in ms */
  durationMs: number
  /** Warmup per step in ms */
  warmupMs: number
  /** Queue p99 threshold in ms - saturated if exceeded */
  queueP99ThresholdMs: number
  /** Achieved ratio threshold - saturated if below (e.g., 0.9 = 90%) */
  achievedRatioThreshold: number
  /** Max concurrency multiplier (maxConcurrency = targetRps * this) */
  concurrencyMultiplier: number
}

export const defaultSaturationConfig: SaturationConfig = {
  startRps: 1000, // Start high for quick discovery
  maxRps: 100000,
  stepMultiplier: 2.0, // Double each step (exponential growth)
  durationMs: 5000,
  warmupMs: 1000,
  queueP99ThresholdMs: 100, // Saturated if queue p99 > 100ms
  achievedRatioThreshold: 0.9, // Saturated if achieved < 90% of target
  concurrencyMultiplier: 3, // Allow 3x concurrency vs RPS
}

/**
 * Check if a step indicates saturation.
 */
export function isSaturated(
  metrics: OpenLoopMetrics,
  config: SaturationConfig
): { saturated: boolean; reason?: `queue_latency` | `achieved_ratio` } {
  const achievedRatio = metrics.achievedRps / metrics.targetRps

  if (metrics.queueLatency.p99 > config.queueP99ThresholdMs) {
    return { saturated: true, reason: `queue_latency` }
  }

  if (achievedRatio < config.achievedRatioThreshold) {
    return { saturated: true, reason: `achieved_ratio` }
  }

  return { saturated: false }
}

/**
 * Format saturation result for display.
 */
export function formatSaturationResult(result: SaturationResult): string {
  const lines: Array<string> = []

  lines.push(`Saturation Test: ${result.operation}`)
  lines.push(`${`─`.repeat(40)}`)

  if (result.saturationRps > 0) {
    lines.push(
      `Saturates between ${result.sustainableRps.toLocaleString()} and ${result.saturationRps.toLocaleString()} req/s`
    )
    lines.push(
      `Reason: ${result.saturationReason === `queue_latency` ? `queue latency exceeded threshold` : `achieved ratio dropped below threshold`}`
    )
    lines.push(
      `Queue P99 at saturation: ${result.saturationQueueP99Ms.toFixed(0)}ms`
    )
  } else {
    lines.push(
      `No saturation up to ${result.sustainableRps.toLocaleString()} req/s (max tested)`
    )
  }

  lines.push(``)
  lines.push(`Step-by-step results:`)
  lines.push(
    `| Target RPS | Achieved RPS | Ratio | Queue P99 | Total P99 | Status |`
  )
  lines.push(
    `|------------|--------------|-------|-----------|-----------|--------|`
  )

  for (const step of result.steps) {
    const status = step.saturated ? `⚠️ SAT` : `✓ OK`
    lines.push(
      `| ${step.targetRps.toLocaleString().padStart(10)} | ${step.achievedRps.toFixed(0).padStart(12)} | ${(step.achievedRatio * 100).toFixed(0).padStart(4)}% | ${step.queueP99Ms.toFixed(1).padStart(9)}ms | ${step.totalP99Ms.toFixed(1).padStart(9)}ms | ${status} |`
    )
  }

  return lines.join(`\n`)
}

/**
 * Generate markdown report for saturation results.
 */
export function formatSaturationMarkdown(
  results: Array<{ clientName: string; result: SaturationResult }>
): string {
  const lines: Array<string> = []

  lines.push(`### Saturation Test Results`)
  lines.push(``)
  lines.push(
    `Automatically finds the sustainable RPS by ramping load until queue latency exceeds threshold.`
  )
  lines.push(``)

  for (const { clientName, result } of results) {
    lines.push(`#### ${clientName} - ${result.operation}`)
    lines.push(``)

    if (result.saturationRps > 0) {
      lines.push(
        `**Saturates between:** ${result.sustainableRps.toLocaleString()} and ${result.saturationRps.toLocaleString()} req/s`
      )
      const reason =
        result.saturationReason === `queue_latency`
          ? `queue latency exceeded threshold`
          : `achieved ratio dropped`
      lines.push(`**Reason:** ${reason}`)
    } else {
      lines.push(
        `**No saturation** up to ${result.sustainableRps.toLocaleString()} req/s`
      )
    }
    lines.push(``)

    lines.push(`<details>`)
    lines.push(`<summary>Step-by-step breakdown</summary>`)
    lines.push(``)
    lines.push(`| Target | Achieved | Queue P99 | Total P99 | Status |`)
    lines.push(`|--------|----------|-----------|-----------|--------|`)

    for (const step of result.steps) {
      const status = step.saturated ? `Saturated` : `OK`
      lines.push(
        `| ${step.targetRps.toLocaleString()} | ${step.achievedRps.toFixed(0)} (${(step.achievedRatio * 100).toFixed(0)}%) | ${step.queueP99Ms.toFixed(1)}ms | ${step.totalP99Ms.toFixed(1)}ms | ${status} |`
      )
    }

    lines.push(``)
    lines.push(`</details>`)
    lines.push(``)
  }

  return lines.join(`\n`)
}

// =============================================================================
// Saturation Runner Options
// =============================================================================

export interface SaturationRunnerOptions {
  /** Path to client adapter executable, or "ts" for built-in TypeScript adapter */
  clientAdapter: string
  /** Arguments to pass to client adapter */
  clientArgs?: Array<string>
  /** Operations to test */
  operations?: Array<`append` | `roundtrip`>
  /** Configuration for the saturation search */
  config?: Partial<SaturationConfig>
  /** Verbose output */
  verbose?: boolean
  /** Port for reference server (0 for random) */
  serverPort?: number
  /** Output format */
  format?: `console` | `json` | `markdown`
}

export interface SaturationSummary {
  adapter: string
  adapterVersion: string
  serverUrl: string
  timestamp: string
  duration: number
  results: Array<SaturationResult>
  config: SaturationConfig
}

// =============================================================================
// Client Adapter for Saturation Tests
// =============================================================================

class SaturationClientAdapter {
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

  async send(command: TestCommand, timeoutMs = 120000): Promise<TestResult> {
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

  async runOpenLoop(
    operation: BenchmarkOpenLoopOp
  ): Promise<OpenLoopMetrics | null> {
    const result = await this.send({
      type: `benchmark`,
      iterationId: `saturation-${randomUUID()}`,
      operation,
    })

    if (result.type === `benchmark` && result.openLoop) {
      return result.openLoop
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
// Saturation Test Runner
// =============================================================================

/**
 * Run a single saturation step at the given RPS.
 */
async function runSaturationStep(
  client: SaturationClientAdapter,
  serverUrl: string,
  operation: `append` | `roundtrip`,
  targetRps: number,
  config: SaturationConfig,
  basePath: string
): Promise<{ metrics: OpenLoopMetrics; step: SaturationStep } | null> {
  const maxConcurrency = Math.ceil(targetRps * config.concurrencyMultiplier)

  const openLoopOp: BenchmarkOpenLoopOp = {
    op: `open_loop`,
    innerOp: operation,
    // Use consistent path - for append, use the pre-created stream
    path:
      operation === `append`
        ? `${basePath}/saturation-append`
        : `${basePath}/saturation-${operation}-${targetRps}`,
    size: 100,
    targetRps,
    durationMs: config.durationMs,
    warmupMs: config.warmupMs,
    maxConcurrency,
    live: operation === `roundtrip` ? `long-poll` : undefined,
  }

  const metrics = await client.runOpenLoop(openLoopOp)
  if (!metrics) {
    return null
  }

  const achievedRatio = metrics.achievedRps / metrics.targetRps
  const satCheck = isSaturated(metrics, config)

  const step: SaturationStep = {
    targetRps: metrics.targetRps,
    achievedRps: metrics.achievedRps,
    achievedRatio,
    queueP99Ms: metrics.queueLatency.p99,
    totalP99Ms: metrics.totalLatency.p99,
    totalP50Ms: metrics.totalLatency.median,
    saturated: satCheck.saturated,
  }

  return { metrics, step }
}

/**
 * Find the saturation point for an operation by ramping up load.
 */
async function findSaturationPoint(
  client: SaturationClientAdapter,
  serverUrl: string,
  operation: `append` | `roundtrip`,
  config: SaturationConfig,
  log: (message: string) => void
): Promise<SaturationResult> {
  const basePath = `/saturation-${randomUUID()}`
  const steps: Array<SaturationStep> = []
  let currentRps = config.startRps
  let sustainableRps = 0
  let saturationRps = 0
  let saturationQueueP99Ms = 0
  let saturationReason: SaturationResult[`saturationReason`]

  // Pre-create a stream for append tests
  if (operation === `append`) {
    const streamUrl = `${serverUrl}${basePath}/saturation-append`
    await DurableStream.create({
      url: streamUrl,
      contentType: `application/octet-stream`,
    })
  }

  log(`\nFinding saturation point for ${operation}...`)
  log(
    `Config: start=${config.startRps} max=${config.maxRps} multiplier=${config.stepMultiplier}x`
  )
  log(
    `Thresholds: queue_p99<${config.queueP99ThresholdMs}ms achieved>${config.achievedRatioThreshold * 100}%`
  )
  log(``)

  let running = true
  while (running) {
    log(`  Testing ${currentRps} req/s...`)

    const result = await runSaturationStep(
      client,
      serverUrl,
      operation,
      currentRps,
      config,
      basePath
    )

    if (!result) {
      log(`    ✗ No metrics returned`)
      break
    }

    const { step } = result
    steps.push(step)

    const achievedPct = (step.achievedRatio * 100).toFixed(1)
    const statusIcon = step.saturated ? `⚠️` : `✓`
    log(
      `    ${statusIcon} Achieved: ${step.achievedRps.toFixed(0)} (${achievedPct}%) | Queue P99: ${step.queueP99Ms.toFixed(2)}ms | Total P99: ${step.totalP99Ms.toFixed(2)}ms`
    )

    if (step.saturated) {
      // If we saturated on the first step, back off and try lower
      if (sustainableRps === 0 && currentRps > 50) {
        const lowerRps = Math.floor(currentRps / config.stepMultiplier)
        log(`    → Backing off to ${lowerRps} req/s (saturated on first step)`)
        currentRps = lowerRps
        steps.pop() // Remove the saturated step, we'll try again lower
        continue
      }

      saturationRps = currentRps
      saturationQueueP99Ms = step.queueP99Ms

      // Determine reason
      if (step.queueP99Ms > config.queueP99ThresholdMs) {
        saturationReason = `queue_latency`
        log(
          `    → Saturated: queue latency exceeded ${config.queueP99ThresholdMs}ms threshold`
        )
      } else {
        saturationReason = `achieved_ratio`
        log(
          `    → Saturated: achieved ratio below ${config.achievedRatioThreshold * 100}% threshold`
        )
      }

      running = false
    } else {
      sustainableRps = currentRps
      currentRps = Math.ceil(currentRps * config.stepMultiplier)

      if (currentRps > config.maxRps) {
        log(`    → Reached max RPS limit (${config.maxRps})`)
        sustainableRps = config.maxRps
        saturationReason = `max_rps_reached`
        running = false
      }
    }
  }

  return {
    operation,
    sustainableRps,
    saturationRps,
    saturationQueueP99Ms,
    steps,
    saturationReason,
  }
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Run saturation tests for specified operations.
 *
 * Ramps up load until queue latency explodes or achieved RPS falls behind target,
 * then reports the sustainable limit for each operation.
 */
export async function runSaturationTests(
  options: SaturationRunnerOptions
): Promise<SaturationSummary> {
  const startTime = Date.now()
  const results: Array<SaturationResult> = []
  const config: SaturationConfig = {
    ...defaultSaturationConfig,
    ...options.config,
  }

  // When format is json or markdown, progress goes to stderr
  const log = (message: string): void => {
    if (options.format === `json` || options.format === `markdown`) {
      process.stderr.write(message + `\n`)
    } else {
      console.log(message)
    }
  }

  const operations = options.operations ?? [`append`, `roundtrip`]

  log(`\n${`=`.repeat(60)}`)
  log(`SATURATION FINDER`)
  log(`${`=`.repeat(60)}`)
  log(`Finding sustainable RPS for: ${operations.join(`, `)}`)
  log(``)

  // Start reference server
  const server = new DurableStreamTestServer({ port: options.serverPort ?? 0 })
  await server.start()
  const serverUrl = server.url

  log(`Reference server started at ${serverUrl}`)

  // Resolve client adapter path
  let adapterPath = options.clientAdapter
  let adapterArgs = options.clientArgs ?? []

  if (adapterPath === `ts` || adapterPath === `typescript`) {
    const isCompiledDist = import.meta.url.includes(`/dist/`)

    if (isCompiledDist) {
      adapterPath = `node`
      adapterArgs = [
        new URL(`./adapters/typescript-adapter.js`, import.meta.url).pathname,
      ]
    } else {
      adapterPath = `npx`
      adapterArgs = [
        `tsx`,
        new URL(`./adapters/typescript-adapter.ts`, import.meta.url).pathname,
      ]
    }
  }

  // Start client adapter
  const client = new SaturationClientAdapter(adapterPath, adapterArgs)

  let adapterName = `unknown`
  let adapterVersion = `0.0.0`

  try {
    // Initialize client
    const initResult = await client.init(serverUrl)
    if (!initResult.success) {
      throw new Error(`Failed to initialize client adapter`)
    }

    if (initResult.type === `init`) {
      adapterName = initResult.clientName
      adapterVersion = initResult.clientVersion

      log(`Client: ${adapterName} v${adapterVersion}`)
    }

    // Run saturation test for each operation
    for (const operation of operations) {
      const result = await findSaturationPoint(
        client,
        serverUrl,
        operation,
        config,
        log
      )
      results.push(result)

      log(``)
      log(formatSaturationResult(result))
    }
  } finally {
    await client.shutdown()
    await server.stop()
  }

  const summary: SaturationSummary = {
    adapter: adapterName,
    adapterVersion,
    serverUrl,
    timestamp: new Date().toISOString(),
    duration: Date.now() - startTime,
    results,
    config,
  }

  // Output results
  switch (options.format) {
    case `json`:
      console.log(JSON.stringify(summary, null, 2))
      break
    case `markdown`:
      console.log(
        formatSaturationMarkdown(
          results.map((result) => ({ clientName: adapterName, result }))
        )
      )
      break
    default:
      log(`\n${`=`.repeat(60)}`)
      log(`SUMMARY`)
      log(`${`=`.repeat(60)}`)
      for (const result of results) {
        if (result.saturationRps > 0) {
          log(
            `${result.operation}: saturates between ${result.sustainableRps} and ${result.saturationRps} req/s`
          )
        } else {
          log(
            `${result.operation}: no saturation up to ${result.sustainableRps} req/s`
          )
        }
      }
      log(`Duration: ${((Date.now() - startTime) / 1000).toFixed(2)}s`)
      log(`${`=`.repeat(60)}\n`)
  }

  return summary
}
