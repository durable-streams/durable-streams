/**
 * Open-loop load scheduler for benchmarking.
 *
 * Unlike closed-loop benchmarks (which wait for each request to complete
 * before scheduling the next), open-loop scheduling fires requests on a
 * fixed wall-clock schedule regardless of when prior requests complete.
 *
 * This accurately models real user behavior where:
 * - Users arrive independently, unaware of server state
 * - Multiple requests can overlap during slow periods
 * - Queue wait time is captured in latency measurements
 *
 * Key insight: If a request is SCHEDULED at t=100ms but doesn't START
 * until t=600ms (because the system was busy), the user experienced
 * 500ms of queueing delay. Open-loop captures this; closed-loop hides it.
 */

export interface OpenLoopSample {
  /** When the request was scheduled to start (wall clock ns) */
  scheduledAtNs: bigint
  /** When the request actually started executing (wall clock ns) */
  startedAtNs: bigint
  /** When the request completed (wall clock ns) */
  completedAtNs: bigint
  /** Queue latency: time waiting to start (startedAt - scheduledAt) */
  queueLatencyNs: bigint
  /** Service latency: time executing (completedAt - startedAt) */
  serviceLatencyNs: bigint
  /** Total latency: what users experience (completedAt - scheduledAt) */
  totalLatencyNs: bigint
  /** Whether the request succeeded */
  success: boolean
  /** Error message if failed */
  error?: string
}

export interface OpenLoopResult {
  /** All collected samples */
  samples: Array<OpenLoopSample>
  /** Target requests per second */
  targetRps: number
  /** Actual achieved requests per second (successful only) */
  achievedRps: number
  /** Total requests scheduled (offered load) */
  offeredCount: number
  /** Successfully completed requests */
  completedCount: number
  /** Failed requests */
  failedCount: number
  /** Total duration in milliseconds */
  durationMs: number
}

export interface OpenLoopOptions {
  /** Target requests per second */
  targetRps: number
  /** Duration to run in milliseconds */
  durationMs: number
  /** Maximum concurrent requests (to prevent resource exhaustion) */
  maxConcurrency?: number
  /** Optional warmup duration in milliseconds (not measured) */
  warmupMs?: number
}

/**
 * Sleep for the specified number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}

/**
 * Run an open-loop benchmark.
 *
 * Schedules requests at fixed intervals based on targetRps, regardless of
 * when previous requests complete. Measures latency from SCHEDULED start
 * time, not actual start time.
 *
 * @param operation - Async function to benchmark (each call = one request)
 * @param options - Scheduling options
 * @returns Collected samples and summary statistics
 */
export async function runOpenLoop(
  operation: () => Promise<void>,
  options: OpenLoopOptions
): Promise<OpenLoopResult> {
  const { targetRps, durationMs, maxConcurrency = 1000, warmupMs = 0 } = options

  const periodMs = 1000 / targetRps
  const samples: Array<OpenLoopSample> = []
  const inFlight: Set<Promise<void>> = new Set()

  const runStartTime = process.hrtime.bigint()
  const warmupEndNs = runStartTime + BigInt(warmupMs) * 1_000_000n
  const measureEndNs = runStartTime + BigInt(warmupMs + durationMs) * 1_000_000n

  let seq = 0
  let offeredCount = 0
  let isWarmup = warmupMs > 0

  // Schedule loop
  let running = true
  while (running) {
    const now = process.hrtime.bigint()

    // Check if warmup is complete
    if (isWarmup && now >= warmupEndNs) {
      isWarmup = false
      // Reset sequence for measurement phase
      seq = 0
    }

    // Check if measurement phase is complete
    if (!isWarmup && now >= measureEndNs) {
      running = false
      continue
    }

    // Calculate when this request should be scheduled
    const phaseStartNs = isWarmup ? runStartTime : warmupEndNs
    const scheduledAtNs =
      phaseStartNs + BigInt(Math.floor(seq * periodMs * 1_000_000))
    seq++

    // If we're behind schedule, catch up
    if (scheduledAtNs < now) {
      // Still fire the request, but at current time
      // This happens when maxConcurrency throttles us or system is slow
    }

    // Respect concurrency limit
    while (inFlight.size >= maxConcurrency) {
      // Wait for any request to complete
      await Promise.race(inFlight)
    }

    // Only count and record if in measurement phase
    if (!isWarmup) {
      offeredCount++
    }

    // Fire the request (don't await - that's what makes it open-loop)
    const requestPromise = (async () => {
      const startedAtNs = process.hrtime.bigint()
      let success = true
      let error: string | undefined

      try {
        await operation()
      } catch (err) {
        success = false
        error = err instanceof Error ? err.message : String(err)
      }

      const completedAtNs = process.hrtime.bigint()

      // Only record samples during measurement phase
      if (!isWarmup) {
        samples.push({
          scheduledAtNs,
          startedAtNs,
          completedAtNs,
          queueLatencyNs: startedAtNs - scheduledAtNs,
          serviceLatencyNs: completedAtNs - startedAtNs,
          totalLatencyNs: completedAtNs - scheduledAtNs,
          success,
          error,
        })
      }
    })()

    // Track in-flight requests
    inFlight.add(requestPromise)
    requestPromise.finally(() => inFlight.delete(requestPromise))

    // Sleep until next scheduled time
    const nextScheduledNs =
      (isWarmup ? runStartTime : warmupEndNs) +
      BigInt(Math.floor(seq * periodMs * 1_000_000))
    const sleepMs =
      Number(nextScheduledNs - process.hrtime.bigint()) / 1_000_000

    if (sleepMs > 0) {
      await sleep(sleepMs)
    }
  }

  // Wait for all in-flight requests to complete
  await Promise.allSettled(inFlight)

  const completedCount = samples.filter((s) => s.success).length
  const failedCount = samples.filter((s) => !s.success).length
  const achievedRps = completedCount / (durationMs / 1000)

  return {
    samples,
    targetRps,
    achievedRps,
    offeredCount,
    completedCount,
    failedCount,
    durationMs,
  }
}

/**
 * Calculate statistics from open-loop samples.
 *
 * Returns separate stats for:
 * - Queue latency (time waiting to start)
 * - Service latency (time executing)
 * - Total latency (what users experience)
 */
export interface OpenLoopStats {
  /** Statistics for total latency (scheduledAt to completedAt) */
  total: LatencyStats
  /** Statistics for queue latency (scheduledAt to startedAt) */
  queue: LatencyStats
  /** Statistics for service latency (startedAt to completedAt) */
  service: LatencyStats
  /** Offered vs achieved load */
  load: LoadStats
}

export interface LatencyStats {
  min: number
  max: number
  mean: number
  median: number
  p75: number
  p90: number
  p95: number
  p99: number
  p999: number
  stdDev: number
  sampleCount: number
}

export interface LoadStats {
  targetRps: number
  achievedRps: number
  offeredCount: number
  completedCount: number
  failedCount: number
  successRate: number
}

/**
 * Calculate percentiles from sorted array.
 */
function percentile(sorted: Array<number>, p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.floor((sorted.length - 1) * p)
  return sorted[idx]!
}

/**
 * Calculate latency statistics from nanosecond values.
 */
function calculateLatencyStats(valuesNs: Array<bigint>): LatencyStats {
  if (valuesNs.length === 0) {
    return {
      min: 0,
      max: 0,
      mean: 0,
      median: 0,
      p75: 0,
      p90: 0,
      p95: 0,
      p99: 0,
      p999: 0,
      stdDev: 0,
      sampleCount: 0,
    }
  }

  // Convert to milliseconds
  const samplesMs = valuesNs.map((ns) => Number(ns) / 1_000_000)
  const sorted = [...samplesMs].sort((a, b) => a - b)
  const n = sorted.length

  const min = sorted[0]!
  const max = sorted[n - 1]!
  const mean = samplesMs.reduce((a, b) => a + b, 0) / n

  // Standard deviation
  const squaredDiffs = samplesMs.map((v) => Math.pow(v - mean, 2))
  const variance = squaredDiffs.reduce((a, b) => a + b, 0) / n
  const stdDev = Math.sqrt(variance)

  return {
    min,
    max,
    mean,
    median: percentile(sorted, 0.5),
    p75: percentile(sorted, 0.75),
    p90: percentile(sorted, 0.9),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    p999: percentile(sorted, 0.999),
    stdDev,
    sampleCount: n,
  }
}

/**
 * Calculate comprehensive statistics from open-loop results.
 */
export function calculateOpenLoopStats(result: OpenLoopResult): OpenLoopStats {
  const successfulSamples = result.samples.filter((s) => s.success)

  return {
    total: calculateLatencyStats(
      successfulSamples.map((s) => s.totalLatencyNs)
    ),
    queue: calculateLatencyStats(
      successfulSamples.map((s) => s.queueLatencyNs)
    ),
    service: calculateLatencyStats(
      successfulSamples.map((s) => s.serviceLatencyNs)
    ),
    load: {
      targetRps: result.targetRps,
      achievedRps: result.achievedRps,
      offeredCount: result.offeredCount,
      completedCount: result.completedCount,
      failedCount: result.failedCount,
      successRate:
        result.offeredCount > 0
          ? result.completedCount / result.offeredCount
          : 0,
    },
  }
}

/**
 * Format open-loop stats for display.
 */
export function formatOpenLoopStats(stats: OpenLoopStats): string {
  const lines: Array<string> = []

  const fmtLatency = (l: LatencyStats, label: string) => {
    lines.push(`${label}:`)
    lines.push(
      `  Min: ${l.min.toFixed(2)}ms  Median: ${l.median.toFixed(2)}ms  P95: ${l.p95.toFixed(2)}ms  P99: ${l.p99.toFixed(2)}ms  P99.9: ${l.p999.toFixed(2)}ms  Max: ${l.max.toFixed(2)}ms`
    )
  }

  fmtLatency(stats.total, `Total Latency (user-perceived)`)
  fmtLatency(stats.queue, `Queue Latency (wait time)`)
  fmtLatency(stats.service, `Service Latency (execution time)`)

  lines.push(`Load:`)
  lines.push(
    `  Target: ${stats.load.targetRps} req/s  Achieved: ${stats.load.achievedRps.toFixed(1)} req/s  Success: ${(stats.load.successRate * 100).toFixed(1)}%`
  )
  lines.push(
    `  Offered: ${stats.load.offeredCount}  Completed: ${stats.load.completedCount}  Failed: ${stats.load.failedCount}`
  )

  return lines.join(`\n`)
}
