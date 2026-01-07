/**
 * Performance benchmarks for Durable Streams server implementations
 * Tests latency, message throughput, and byte throughput
 *
 * Success Criteria:
 * - Latency overhead: < 10ms round-trip
 * - Message throughput: 100+ messages/second (small messages)
 * - Byte throughput: 100 MB/s (large messages)
 */

import { writeFileSync } from "node:fs"
import { afterAll, bench, describe } from "vitest"
import { DurableStream } from "@durable-streams/client"

export interface BenchmarkOptions {
  /** Base URL of the server to benchmark */
  baseUrl: string
  /** Environment name (e.g., "production", "local") */
  environment?: string
}

// Store benchmark results
const results: Map<string, { values: Array<number>; unit: string }> = new Map()

function recordResult(name: string, value: number, unit: string) {
  if (!results.has(name)) {
    results.set(name, { values: [], unit })
  }
  results.get(name)!.values.push(value)
}

function calculateStats(values: Array<number>) {
  const sorted = [...values].sort((a, b) => a - b)
  const min = sorted[0]!
  const max = sorted[sorted.length - 1]!
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const p50 = sorted[Math.floor(sorted.length * 0.5)]!
  const p75 = sorted[Math.floor(sorted.length * 0.75)]!
  const p99 = sorted[Math.floor(sorted.length * 0.99)]!
  return { min, max, mean, p50, p75, p99 }
}

function printResults() {
  console.log(`\n=== RESULTS SO FAR ===`)

  const tableData: Record<string, any> = {}

  for (const [name, data] of results.entries()) {
    if (data.values.length === 0) continue
    const stats = calculateStats(data.values)

    tableData[name] = {
      Min: `${stats.min.toFixed(2)} ${data.unit}`,
      Max: `${stats.max.toFixed(2)} ${data.unit}`,
      Mean: `${stats.mean.toFixed(2)} ${data.unit}`,
      P50: `${stats.p50.toFixed(2)} ${data.unit}`,
      P75: `${stats.p75.toFixed(2)} ${data.unit}`,
      P99: `${stats.p99.toFixed(2)} ${data.unit}`,
      Iterations: data.values.length,
    }
  }

  console.table(tableData)
}

/**
 * Run the full benchmark suite against a server
 */
export function runBenchmarks(options: BenchmarkOptions): void {
  const { baseUrl, environment = `unknown` } = options

  afterAll(() => {
    // Calculate statistics and write results
    const statsOutput: Record<string, any> = {}

    for (const [name, data] of results.entries()) {
      const stats = calculateStats(data.values)
      statsOutput[name] = {
        ...stats,
        unit: data.unit,
        iterations: data.values.length,
      }
    }

    const output = {
      environment,
      baseUrl,
      timestamp: new Date().toISOString(),
      results: statsOutput,
    }

    writeFileSync(
      `benchmark-results.json`,
      JSON.stringify(output, null, 2),
      `utf-8`
    )

    console.log(`\n\n=== BENCHMARK RESULTS ===`)
    console.log(`Environment: ${output.environment}`)
    console.log(`Base URL: ${output.baseUrl}`)
    console.log(``)

    const finalTableData: Record<string, any> = {}
    for (const [name, stats] of Object.entries(statsOutput)) {
      finalTableData[name] = {
        Min: `${stats.min.toFixed(2)} ${stats.unit}`,
        Max: `${stats.max.toFixed(2)} ${stats.unit}`,
        Mean: `${stats.mean.toFixed(2)} ${stats.unit}`,
        P50: `${stats.p50.toFixed(2)} ${stats.unit}`,
        P75: `${stats.p75.toFixed(2)} ${stats.unit}`,
        P99: `${stats.p99.toFixed(2)} ${stats.unit}`,
        Iterations: stats.iterations,
      }
    }

    console.table(finalTableData)

    console.log(`\n\nResults saved to benchmark-results.json`)
  })

  // ============================================================================
  // Latency Benchmarks
  // ============================================================================

  describe(`Latency - Round-trip Time`, () => {
    bench(
      `baseline ping (round-trip network latency)`,
      async () => {
        // Measure baseline network latency with a simple HEAD request
        const startTime = performance.now()
        await fetch(`${baseUrl}/health`)
        const endTime = performance.now()

        const pingTime = endTime - startTime
        recordResult(`Baseline Ping`, pingTime, `ms`)
      },
      { iterations: 5, time: 5000 }
    )

    bench(
      `append and receive via long-poll (100 bytes)`,
      async () => {
        const streamPath = `/v1/stream/latency-bench-${Date.now()}-${Math.random()}`
        const stream = await DurableStream.create({
          url: `${baseUrl}${streamPath}`,
          contentType: `application/octet-stream`,
        })

        const message = new Uint8Array(100).fill(42)
        let offset = (await stream.head()).offset

        // Measure baseline ping for this test
        const pingStart = performance.now()
        await fetch(`${baseUrl}/health`)
        const pingEnd = performance.now()
        const pingTime = pingEnd - pingStart

        // Warmup: append and receive once (don't measure)
        const warmupPromise = (async () => {
          const res = await stream.stream({
            offset,
            live: `long-poll`,
          })
          await new Promise<void>((resolve) => {
            const unsubscribe = res.subscribeBytes((chunk) => {
              if (chunk.data.length > 0) {
                offset = chunk.offset
                unsubscribe()
                res.cancel()
                resolve()
              }
              return Promise.resolve()
            })
          })
        })()

        await stream.append(message)
        await warmupPromise

        // Actual measurement: append and receive second time
        const readPromise = (async () => {
          const res = await stream.stream({
            offset,
            live: `long-poll`,
          })
          await new Promise<void>((resolve) => {
            const unsubscribe = res.subscribeBytes((chunk) => {
              if (chunk.data.length > 0) {
                unsubscribe()
                res.cancel()
                resolve()
              }
              return Promise.resolve()
            })
          })
        })()

        const startTime = performance.now()
        await stream.append(message)
        await readPromise
        const endTime = performance.now()

        // Cleanup
        await stream.delete()

        const totalLatency = endTime - startTime
        const overhead = totalLatency - pingTime

        recordResult(`Latency - Total RTT`, totalLatency, `ms`)
        recordResult(`Latency - Ping`, pingTime, `ms`)
        recordResult(`Latency - Overhead`, overhead, `ms`)
      },
      { iterations: 10, time: 15000 }
    )

    afterAll(() => {
      printResults()
    })
  })

  // ============================================================================
  // Message Throughput Benchmarks
  // ============================================================================

  describe(`Message Throughput`, () => {
    bench(
      `small messages (100 bytes)`,
      async () => {
        const streamPath = `/v1/stream/msg-small-${Date.now()}-${Math.random()}`
        const stream = await DurableStream.create({
          url: `${baseUrl}${streamPath}`,
          contentType: `application/octet-stream`,
        })

        const message = new Uint8Array(100).fill(42)
        const messageCount = 1000
        const concurrency = 75

        const startTime = performance.now()

        // Send messages in batches with concurrency
        for (let batch = 0; batch < messageCount / concurrency; batch++) {
          await Promise.all(
            Array.from({ length: concurrency }, () => stream.append(message))
          )
        }

        const endTime = performance.now()
        const elapsedSeconds = (endTime - startTime) / 1000
        const messagesPerSecond = messageCount / elapsedSeconds

        // Cleanup
        await stream.delete()

        recordResult(
          `Throughput - Small Messages`,
          messagesPerSecond,
          `msg/sec`
        )
      },
      { iterations: 3, time: 10000 }
    )

    bench(
      `large messages (1MB)`,
      async () => {
        const streamPath = `/v1/stream/msg-large-${Date.now()}-${Math.random()}`
        const stream = await DurableStream.create({
          url: `${baseUrl}${streamPath}`,
          contentType: `application/octet-stream`,
        })

        const message = new Uint8Array(1024 * 1024).fill(42) // 1MB
        const messageCount = 50
        const concurrency = 15

        const startTime = performance.now()

        // Send messages in batches with concurrency
        for (let batch = 0; batch < messageCount / concurrency; batch++) {
          await Promise.all(
            Array.from({ length: concurrency }, () => stream.append(message))
          )
        }

        const endTime = performance.now()
        const elapsedSeconds = (endTime - startTime) / 1000
        const messagesPerSecond = messageCount / elapsedSeconds

        // Cleanup
        await stream.delete()

        recordResult(
          `Throughput - Large Messages`,
          messagesPerSecond,
          `msg/sec`
        )
      },
      { iterations: 2, time: 10000 }
    )

    afterAll(() => {
      printResults()
    })
  })

  // ============================================================================
  // Byte Throughput Benchmarks
  // ============================================================================

  describe.skip(`Byte Throughput`, () => {
    bench(
      `streaming throughput - appendStream`,
      async () => {
        const streamPath = `/v1/stream/byte-stream-${Date.now()}-${Math.random()}`
        const stream = await DurableStream.create({
          url: `${baseUrl}${streamPath}`,
          contentType: `application/octet-stream`,
        })

        const chunkSize = 64 * 1024 // 64KB chunks
        const chunk = new Uint8Array(chunkSize).fill(42)
        const totalChunks = 100 // Send 100 chunks = ~6.4MB total

        const startTime = performance.now()

        const appends = []
        for (let i = 0; i < totalChunks; i++) {
          appends.push(stream.append(chunk))
        }
        await Promise.all(appends)

        const endTime = performance.now()

        // Read back to verify
        let bytesRead = 0
        const readRes = await stream.stream({ live: false })
        const reader = readRes.bodyStream().getReader()
        let result = await reader.read()
        while (!result.done) {
          bytesRead += result.value.length
          result = await reader.read()
        }

        const elapsedSeconds = (endTime - startTime) / 1000
        const mbPerSecond = bytesRead / (1024 * 1024) / elapsedSeconds

        // Cleanup
        await stream.delete()

        recordResult(
          `Throughput - Streaming (appendStream)`,
          mbPerSecond,
          `MB/sec`
        )
      },
      { iterations: 3, time: 10000 }
    )

    afterAll(() => {
      printResults()
    })
  })
}
