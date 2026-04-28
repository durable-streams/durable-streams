/**
 * Microbench of the streams server's read path.
 *
 * Creates a stream with N messages, then benchmarks reading from various
 * offsets (start, middle, tail) at increasing concurrency.
 *
 * Usage:
 *   pnpm exec tsx scripts/bench-reads.ts
 *   BENCH_MESSAGES=10000 pnpm exec tsx scripts/bench-reads.ts
 */
import { mkdirSync, rmSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { DurableStream } from "@durable-streams/client"
import { DurableStreamTestServer } from "@durable-streams/server"

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(SCRIPT_DIR, `..`)
const DATA_DIR = path.resolve(
  REPO_ROOT,
  `.darix-dev`,
  `bench-reads-${Date.now()}`
)

const MSG_COUNT = Number(process.env.BENCH_MESSAGES ?? 1000)
const WINDOW_MS = Number(process.env.BENCH_WINDOW_MS ?? 3000)
const LEVELS = (process.env.BENCH_LEVELS ?? `1,4,16,64`)
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
console.log(`[bench-reads] server=${url}`)
console.log(`[bench-reads] data=${DATA_DIR}`)

// --- Seed: create stream and append messages ---
const STREAM_PATH = `/bench/read-target`
const STREAM_URL = `${url}${STREAM_PATH}`
const MSG_BODY = JSON.stringify({ type: `bench`, payload: `x`.repeat(200) })

console.log(`[bench-reads] seeding ${MSG_COUNT} messages...`)
const seedT0 = performance.now()

const handle = await DurableStream.create({
  url: STREAM_URL,
  contentType: `application/json`,
  body: `[${MSG_BODY}]`,
})

for (let i = 1; i < MSG_COUNT; i++) {
  await handle.append(`[${MSG_BODY}]`)
}
const seedMs = performance.now() - seedT0
console.log(
  `[bench-reads] seeded ${MSG_COUNT} messages in ${(seedMs / 1000).toFixed(1)}s`
)

// Read all messages via raw fetch to collect offsets
const offsetStart = `0000000000000000_0000000000000000`
const allResp = await fetch(STREAM_URL)
const allBody = JSON.parse(await allResp.text()) as Array<unknown>
const tailOffset = allResp.headers.get(`stream-next-offset`)!

// Compute frame-aligned offsets using exact frame size
// Frame format: [4-byte BE length][data][newline] = 5 + dataLen per message
const FRAME_SIZE = 5 + Buffer.byteLength(MSG_BODY, `utf8`)
const tailParts = tailOffset.split(`_`)
const makeAlignedOffset = (msgIndex: number): string => {
  const bytePos = msgIndex * FRAME_SIZE
  return `${tailParts[0]}_${String(bytePos).padStart(16, `0`)}`
}

const msg50 = Math.floor(MSG_COUNT * 0.5)
const msg75 = Math.floor(MSG_COUNT * 0.75)
const offset50 = makeAlignedOffset(msg50)
const offset75 = makeAlignedOffset(msg75)

console.log(`[bench-reads] ${allBody.length} messages, tail=${tailOffset}`)
console.log(`[bench-reads] frameSize=${FRAME_SIZE}, offset50=${offset50}, offset75=${offset75}`)
console.log(
  `[bench-reads] levels=${LEVELS.join(`,`)} window=${WINDOW_MS}ms\n`
)

// --- Benchmark helpers ---
function pct(sorted: Array<number>, p: number): number {
  if (!sorted.length) return 0
  const idx = Math.min(
    sorted.length - 1,
    Math.floor((p / 100) * sorted.length)
  )
  return sorted[idx]!
}

async function oneRead(offset: string): Promise<number> {
  const t0 = performance.now()
  const resp = await fetch(`${STREAM_URL}?offset=${encodeURIComponent(offset)}`)
  await resp.arrayBuffer()
  return performance.now() - t0
}

async function runLevel(
  offset: string,
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
  const stopAt = performance.now() + windowMs

  const worker = async (): Promise<void> => {
    while (performance.now() < stopAt) {
      try {
        const lat = await oneRead(offset)
        latencies.push(lat)
      } catch {
        errors += 1
      }
    }
  }

  const start = performance.now()
  await Promise.all(Array.from({ length: concurrency }, () => worker()))
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

function printHeader(): void {
  console.log(
    `${`conc`.padStart(4)}  ${`count`.padStart(6)}  ${`rps`.padStart(8)}  ${`p50ms`.padStart(8)}  ${`p95ms`.padStart(8)}  ${`p99ms`.padStart(8)}  errors`
  )
  console.log(
    `----  ------  --------  --------  --------  --------  ------`
  )
}

function printRow(c: number, r: Awaited<ReturnType<typeof runLevel>>): void {
  console.log(
    `${String(c).padStart(4)}  ${String(r.count).padStart(6)}  ${fmt(r.rps)}  ${fmt(r.p50)}  ${fmt(r.p95)}  ${fmt(r.p99)}  ${r.errors}`
  )
}

try {
  const scenarios = [
    { name: `read-from-start (${allBody.length} msgs returned)`, offset: offsetStart },
    { name: `read-from-50% (~${Math.floor(allBody.length * 0.5)} msgs returned)`, offset: offset50 },
    { name: `read-from-75% (~${Math.floor(allBody.length * 0.25)} msgs returned)`, offset: offset75 },
    { name: `read-at-tail (0 msgs returned)`, offset: tailOffset },
  ]

  for (const scenario of scenarios) {
    console.log(`\n=== ${scenario.name} ===`)
    printHeader()

    for (const c of LEVELS) {
      const r = await runLevel(scenario.offset, c, WINDOW_MS)
      printRow(c, r)
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
  }
} finally {
  await server.stop()
  rmSync(DATA_DIR, { recursive: true, force: true })
}
