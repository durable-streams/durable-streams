/**
 * Direct microbench of the streams server's `DurableStream.create` path.
 *
 * Starts an isolated DurableStreamTestServer with a fresh data dir, then
 * hammers it with concurrent creates (each a unique path, small JSON body,
 * mirroring the darix.spawn workload) at increasing concurrency levels.
 *
 * Usage:
 *   pnpm exec tsx scripts/bench-streams.ts
 *   BENCH_WINDOW_MS=3000 BENCH_LEVELS="1,4,16,64" pnpm exec tsx scripts/bench-streams.ts
 */
import { mkdirSync, rmSync } from "node:fs"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { fileURLToPath } from "node:url"
import { DurableStream } from "@durable-streams/client"
import { DurableStreamTestServer } from "@durable-streams/server"

// UV_THREADPOOL_SIZE must be set before process boot — pass as env var:
//   UV_THREADPOOL_SIZE=16 pnpm exec tsx scripts/bench-streams.ts

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(SCRIPT_DIR, `..`)
const DATA_DIR = path.resolve(
  REPO_ROOT,
  `.darix-dev`,
  `bench-streams-${Date.now()}`
)
const WINDOW_MS = Number(process.env.BENCH_WINDOW_MS ?? 3000)
const LEVELS = (process.env.BENCH_LEVELS ?? `1,2,4,8,16,32,64`)
  .split(`,`)
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0)

mkdirSync(DATA_DIR, { recursive: true })

const server = new DurableStreamTestServer({
  port: 0,
  host: `127.0.0.1`,
  dataDir: DATA_DIR,
  webhooks: false,
})
const url = await server.start()
console.log(`[bench-streams] server=${url}`)
console.log(`[bench-streams] data=${DATA_DIR}`)
console.log(`[bench-streams] UV_THREADPOOL_SIZE=${process.env.UV_THREADPOOL_SIZE ?? `(default=4)`}`)
console.log(
  `[bench-streams] levels=${LEVELS.join(`,`)} window=${WINDOW_MS}ms`
)

function pct(sorted: Array<number>, p: number): number {
  if (!sorted.length) return 0
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx]!
}

async function oneCreate(): Promise<number> {
  const name = randomBytes(6).toString(`hex`)
  const t0 = performance.now()
  await DurableStream.create({
    url: `${url}/bench/${name}`,
    contentType: `application/json`,
    body: JSON.stringify({
      type: `burst`,
      args: {
        x: Math.random() * 1000,
        y: Math.random() * 1000,
        generation: 0,
        parentAngle: null,
        demoId: `bench`,
        palette: `neon`,
        effect: `sparkle`,
      },
    }),
  })
  return performance.now() - t0
}

async function runLevel(
  concurrency: number,
  windowMs: number
): Promise<{
  count: number
  rps: number
  p50: number
  p95: number
  p99: number
  errors: number
}> {
  const latencies: Array<number> = []
  let errors = 0
  let stop = false
  const stopAt = performance.now() + windowMs

  const worker = async (): Promise<void> => {
    while (!stop && performance.now() < stopAt) {
      try {
        const lat = await oneCreate()
        latencies.push(lat)
      } catch {
        errors += 1
      }
    }
  }

  const start = performance.now()
  const workers = Array.from({ length: concurrency }, () => worker())
  await Promise.all(workers)
  stop = true
  const elapsed = (performance.now() - start) / 1000
  const sorted = latencies.slice().sort((a, b) => a - b)

  return {
    count: latencies.length,
    rps: latencies.length / elapsed,
    p50: pct(sorted, 50),
    p95: pct(sorted, 95),
    p99: pct(sorted, 99),
    errors,
  }
}

function fmt(n: number, d = 1): string {
  return n.toFixed(d).padStart(8)
}

try {
  console.log(
    `\n${`conc`.padStart(4)}  ${`count`.padStart(6)}  ${`rps`.padStart(8)}  ${`p50ms`.padStart(8)}  ${`p95ms`.padStart(8)}  ${`p99ms`.padStart(8)}  errors`
  )
  console.log(
    `----  ------  --------  --------  --------  --------  ------`
  )

  for (const c of LEVELS) {
    const r = await runLevel(c, WINDOW_MS)
    console.log(
      `${String(c).padStart(4)}  ${String(r.count).padStart(6)}  ${fmt(r.rps)}  ${fmt(r.p50)}  ${fmt(r.p95)}  ${fmt(r.p99)}  ${r.errors}`
    )
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
} finally {
  await server.stop()
  rmSync(DATA_DIR, { recursive: true, force: true })
}
