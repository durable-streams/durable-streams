/**
 * Pull recent traces from Jaeger and print aggregates.
 *
 * Usage:
 *   pnpm exec tsx scripts/analyze-traces.mts                # default: last 5m, service=darix-server
 *   pnpm exec tsx scripts/analyze-traces.mts --lookback 15m
 *   pnpm exec tsx scripts/analyze-traces.mts --operation darix.spawn
 *   pnpm exec tsx scripts/analyze-traces.mts --slow         # show top-5 slowest traces as waterfalls
 */

interface JaegerSpan {
  traceID: string
  spanID: string
  operationName: string
  references: Array<{
    refType: string
    traceID: string
    spanID: string
  }>
  startTime: number // microseconds since epoch
  duration: number // microseconds
  tags: Array<{ key: string; type: string; value: unknown }>
  processID: string
}

interface JaegerTrace {
  traceID: string
  spans: Array<JaegerSpan>
  processes: Record<string, { serviceName: string }>
}

interface JaegerResponse {
  data: Array<JaegerTrace>
}

const args = new Map<string, string>()
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i]!
  if (arg.startsWith(`--`)) {
    const next = process.argv[i + 1]
    if (next && !next.startsWith(`--`)) {
      args.set(arg.slice(2), next)
      i += 1
    } else {
      args.set(arg.slice(2), `true`)
    }
  }
}

const JAEGER_URL = args.get(`jaeger`) ?? `http://localhost:16686`
const SERVICE = args.get(`service`) ?? `darix-server`
const LOOKBACK = args.get(`lookback`) ?? `5m`
const OPERATION = args.get(`operation`)
const LIMIT = Number(args.get(`limit`) ?? `200`)
const SHOW_SLOW = args.has(`slow`)
const TOP_N = Number(args.get(`top`) ?? `5`)

function parseLookbackUs(text: string): number {
  const m = /^(\d+)(ms|s|m|h)$/.exec(text)
  if (!m) throw new Error(`bad --lookback ${text}`)
  const n = Number(m[1])
  const unit = m[2]
  const msPerUnit: Record<string, number> = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
  }
  return n * msPerUnit[unit!]! * 1_000
}

async function fetchTraces(): Promise<Array<JaegerTrace>> {
  const now = Date.now() * 1_000
  const lookbackUs = parseLookbackUs(LOOKBACK)
  const params = new URLSearchParams({
    service: SERVICE,
    start: String(now - lookbackUs),
    end: String(now),
    limit: String(LIMIT),
  })
  if (OPERATION) params.set(`operation`, OPERATION)
  const url = `${JAEGER_URL}/api/traces?${params.toString()}`
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(
      `Jaeger query failed: ${res.status} ${await res.text()} (url=${url})`
    )
  }
  const body = (await res.json()) as JaegerResponse
  return body.data
}

function quantile(sorted: Array<number>, q: number): number {
  if (sorted.length === 0) return 0
  const pos = (sorted.length - 1) * q
  const base = Math.floor(pos)
  const rest = pos - base
  if (sorted[base + 1] !== undefined) {
    return sorted[base]! + rest * (sorted[base + 1]! - sorted[base]!)
  }
  return sorted[base]!
}

function fmtUs(us: number): string {
  if (us < 1_000) return `${us.toFixed(0)}µs`
  if (us < 1_000_000) return `${(us / 1_000).toFixed(1)}ms`
  return `${(us / 1_000_000).toFixed(2)}s`
}

function aggregateByOp(
  traces: Array<JaegerTrace>
): Array<{
  op: string
  count: number
  total: number
  p50: number
  p95: number
  p99: number
  max: number
}> {
  const byOp = new Map<string, Array<number>>()
  for (const tr of traces) {
    for (const sp of tr.spans) {
      const arr = byOp.get(sp.operationName) ?? []
      arr.push(sp.duration)
      byOp.set(sp.operationName, arr)
    }
  }
  const rows = Array.from(byOp.entries()).map(([op, durs]) => {
    const sorted = [...durs].sort((a, b) => a - b)
    return {
      op,
      count: durs.length,
      total: durs.reduce((a, b) => a + b, 0),
      p50: quantile(sorted, 0.5),
      p95: quantile(sorted, 0.95),
      p99: quantile(sorted, 0.99),
      max: sorted[sorted.length - 1] ?? 0,
    }
  })
  rows.sort((a, b) => b.total - a.total)
  return rows
}

function printAggregates(
  rows: ReturnType<typeof aggregateByOp>,
  totalTraces: number
): void {
  console.log(
    `\nAggregates across ${totalTraces} traces (sorted by total time, µs → ms):\n`
  )
  const w = (s: string | number, n: number): string => String(s).padStart(n)
  const wl = (s: string | number, n: number): string => String(s).padEnd(n)
  console.log(
    `${wl(`operation`, 40)}  ${w(`count`, 7)}  ${w(`p50`, 9)}  ${w(`p95`, 9)}  ${w(`p99`, 9)}  ${w(`max`, 9)}  ${w(`total`, 10)}`
  )
  console.log(`${`-`.repeat(40)}  ${`-`.repeat(7)}  ${`-`.repeat(9)}  ${`-`.repeat(9)}  ${`-`.repeat(9)}  ${`-`.repeat(9)}  ${`-`.repeat(10)}`)
  for (const r of rows) {
    console.log(
      `${wl(r.op, 40)}  ${w(r.count, 7)}  ${w(fmtUs(r.p50), 9)}  ${w(fmtUs(r.p95), 9)}  ${w(fmtUs(r.p99), 9)}  ${w(fmtUs(r.max), 9)}  ${w(fmtUs(r.total), 10)}`
    )
  }
}

function printWaterfall(trace: JaegerTrace): void {
  const spans = [...trace.spans].sort((a, b) => a.startTime - b.startTime)
  const root = spans[0]
  if (!root) return
  const t0 = root.startTime
  const rootDur = root.duration

  const byParent = new Map<string, Array<JaegerSpan>>()
  for (const sp of spans) {
    const parentRef = sp.references.find((r) => r.refType === `CHILD_OF`)
    const key = parentRef?.spanID ?? `__root__`
    const arr = byParent.get(key) ?? []
    arr.push(sp)
    byParent.set(key, arr)
  }

  console.log(
    `\nTrace ${trace.traceID.slice(0, 16)}...  (root=${root.operationName} ${fmtUs(rootDur)})`
  )
  const WIDTH = 60
  const walk = (span: JaegerSpan, depth: number): void => {
    const offsetUs = span.startTime - t0
    const barStart = Math.floor((offsetUs / rootDur) * WIDTH)
    const barLen = Math.max(1, Math.floor((span.duration / rootDur) * WIDTH))
    const bar =
      ` `.repeat(Math.min(barStart, WIDTH)) +
      `█`.repeat(Math.min(barLen, WIDTH - barStart))
    const name = `${`  `.repeat(depth)}${span.operationName}`
    console.log(
      `  ${name.padEnd(42)} ${fmtUs(span.duration).padStart(8)}  ${bar.padEnd(WIDTH)}`
    )
    const children = byParent.get(span.spanID) ?? []
    children.sort((a, b) => a.startTime - b.startTime)
    for (const c of children) walk(c, depth + 1)
  }
  walk(root, 0)
}

async function main(): Promise<void> {
  const traces = await fetchTraces()
  if (traces.length === 0) {
    console.log(
      `No traces for service=${SERVICE} in lookback=${LOOKBACK}. Is Jaeger running? Is darix sending?`
    )
    return
  }
  const rows = aggregateByOp(traces)
  printAggregates(rows, traces.length)

  if (SHOW_SLOW) {
    const sorted = [...traces].sort((a, b) => {
      const ad = a.spans[0]?.duration ?? 0
      const bd = b.spans[0]?.duration ?? 0
      return bd - ad
    })
    console.log(`\n${`=`.repeat(80)}\nTop ${TOP_N} slowest traces:`)
    for (const t of sorted.slice(0, TOP_N)) printWaterfall(t)
  } else {
    console.log(
      `\n(pass --slow to print top-${TOP_N} slowest traces as waterfalls)`
    )
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
