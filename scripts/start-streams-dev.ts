import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Session } from "node:inspector/promises"
import { DurableStreamTestServer } from "@durable-streams/server"

const HOST = process.env.STREAMS_HOST ?? `127.0.0.1`
const PORT = Number(process.env.STREAMS_PORT ?? 0)
const DATA_DIR = process.env.STREAMS_DATA_DIR
const CPU_PROF = process.env.STREAMS_CPU_PROF === `1`
const PROF_DIR = process.env.STREAMS_PROF_DIR ?? process.cwd()
const PROF_DURATION_MS = Number(process.env.STREAMS_PROF_DURATION_MS ?? 60_000)

if (DATA_DIR) {
  mkdirSync(DATA_DIR, { recursive: true })
}

let profilerSession: Session | null = null
let profilePath: string | null = null
async function flushProfile(): Promise<void> {
  process.stderr.write(`[streams] flushProfile() invoked\n`)
  if (!profilerSession || !profilePath) {
    process.stderr.write(
      `[streams] flushProfile: no session/path (session=${!!profilerSession}, path=${profilePath})\n`
    )
    return
  }
  try {
    process.stderr.write(`[streams] calling Profiler.stop...\n`)
    const result = (await profilerSession.post(`Profiler.stop`)) as {
      profile: unknown
    }
    process.stderr.write(
      `[streams] Profiler.stop returned, profile size=${JSON.stringify(result.profile).length}\n`
    )
    writeFileSync(profilePath, JSON.stringify(result.profile))
    process.stderr.write(`[streams] CPU profile written: ${profilePath}\n`)
  } catch (err) {
    process.stderr.write(`[streams] failed writing CPU profile: ${String(err)}\n`)
    if (err instanceof Error && err.stack) {
      process.stderr.write(`${err.stack}\n`)
    }
  } finally {
    profilerSession?.disconnect()
    profilerSession = null
  }
}

if (CPU_PROF) {
  mkdirSync(PROF_DIR, { recursive: true })
  profilePath = path.join(PROF_DIR, `streams-${Date.now()}.cpuprofile`)
  process.stderr.write(`[streams] mkdir ${PROF_DIR} ok\n`)
  profilerSession = new Session()
  profilerSession.connect()
  await profilerSession.post(`Profiler.enable`)
  await profilerSession.post(`Profiler.start`)
  process.stderr.write(
    `[streams] CPU profiler started → ${profilePath} (auto-flush in ${PROF_DURATION_MS}ms)\n`
  )
  setTimeout(() => {
    process.stderr.write(`[streams] auto-flush timer fired\n`)
    flushProfile().catch((err) => {
      process.stderr.write(`[streams] auto-flush rejected: ${String(err)}\n`)
    })
  }, PROF_DURATION_MS)
}

const server = new DurableStreamTestServer({
  port: PORT,
  host: HOST,
  webhooks: true,
  dataDir: DATA_DIR,
})

const url = await server.start()

process.stdout.write(`STREAMS_URL=${url}\n`)

let stopping: Promise<void> | null = null

async function stop(code: number): Promise<void> {
  if (stopping) {
    await stopping
    process.exit(code)
  }
  stopping = (async () => {
    try {
      await server.stop()
    } catch (err) {
      console.error(`[streams] stop failed:`, err)
    }
    await flushProfile()
  })()
  await stopping
  process.exit(code)
}

process.on(`SIGINT`, () => {
  void stop(0)
})
process.on(`SIGTERM`, () => {
  void stop(0)
})
process.on(`uncaughtException`, (err) => {
  console.error(err)
  void stop(1)
})
process.on(`unhandledRejection`, (err) => {
  console.error(err)
  void stop(1)
})
