import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { execSync } from "node:child_process"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { DurableStream, FetchError } from "@durable-streams/client"
import { normalize, denormalize } from "./index.js"
import {
  discoverSessions,
  findClaudeSession,
  rewriteNativeLines,
  writeClaudeSession,
  writeCodexSession,
} from "./sessions.js"
import type { HeadersRecord } from "@durable-streams/client"
import type { AgentType, NormalizedEvent } from "./types.js"

let globalHeaders: HeadersRecord = {}

function parseArgs(argv: Array<string>): {
  command: string
  args: Record<string, string | boolean>
  positional: Array<string>
} {
  const command = argv[0] ?? `help`
  const args: Record<string, string | boolean> = {}
  const positional: Array<string> = []

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg.startsWith(`--`)) {
      const key = arg.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith(`--`)) {
        args[key] = next
        i++
      } else {
        args[key] = true
      }
    } else {
      positional.push(arg)
    }
  }

  return { command, args, positional }
}

function detectAgent(): AgentType | null {
  if (process.env.CLAUDE_CODE_SESSION_ID) return `claude`
  return null
}

async function createOrConnectStream(
  url: string,
  contentType: string
): Promise<DurableStream> {
  try {
    return await DurableStream.create({
      url,
      contentType,
      headers: globalHeaders,
    })
  } catch (error) {
    if (error instanceof FetchError && error.status === 409) {
      return new DurableStream({
        url,
        contentType,
        headers: globalHeaders,
      })
    }
    throw error
  }
}

async function getStreamItemCount(url: string): Promise<number> {
  try {
    const resolvedHeaders: Record<string, string> = {}
    for (const [key, value] of Object.entries(globalHeaders)) {
      if (typeof value === `string`) {
        resolvedHeaders[key] = value
      } else if (typeof value === `function`) {
        resolvedHeaders[key] = await (value as () => Promise<string>)()
      }
    }

    const response = await fetch(url, {
      method: `HEAD`,
      headers: resolvedHeaders,
    })
    if (!response.ok) return 0
    const totalSize = response.headers.get(`stream-total-size`)
    return totalSize ? parseInt(totalSize, 10) : 0
  } catch {
    return 0
  }
}

async function pushLines(
  streamUrl: string,
  _producerId: string,
  lines: Array<string>
): Promise<number> {
  // Delta logic: only push new lines that don't already exist in the stream.
  // Previously this was important because each share reused the same stream URL
  // (based on session ID), so re-exporting needed to avoid duplicates.
  // Now each share gets a unique URL ({sessionId}/{entryCount}-{uuid}), so the
  // stream is always empty on first push and this check is effectively a no-op.
  // Kept as defensive behavior in case someone calls pushLines() with an
  // already-populated stream URL.
  const existingCount = await getStreamItemCount(streamUrl)
  if (existingCount >= lines.length) {
    return 0 // already up to date
  }

  const newLines = lines.slice(existingCount)
  if (newLines.length === 0) return 0

  // Use auto-batching: fire-and-forget appends, then await all promises.
  // The DS client batches concurrent appends into single HTTP requests
  // automatically (wraps JSON items in arrays, server flattens them).
  const stream = await createOrConnectStream(streamUrl, `application/json`)
  const promises = newLines.map((line) => stream.append(line))
  await Promise.all(promises)

  return newLines.length
}

async function streamExists(url: string): Promise<boolean> {
  try {
    const stream = new DurableStream({ url, contentType: `application/json`, headers: globalHeaders })
    const response = await stream.stream({ json: true, live: false })
    const items = await response.json()
    return items.length > 0
  } catch {
    return false
  }
}

async function readStream<T>(url: string): Promise<Array<T>> {
  const stream = new DurableStream({ url, contentType: `application/json`, headers: globalHeaders })
  const response = await stream.stream<T>({ json: true, live: false })
  return response.json()
}

function extractSessionMeta(
  lines: Array<string>,
  agent: AgentType
): { sessionId: string; cwd: string } {
  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>

      if (agent === `claude`) {
        if (obj.sessionId && obj.cwd) {
          return {
            sessionId: String(obj.sessionId),
            cwd: String(obj.cwd),
          }
        }
      }

      if (agent === `codex` && obj.type === `session_meta`) {
        const payload = obj.payload as Record<string, unknown>
        return {
          sessionId: String(payload.id ?? ``),
          cwd: String(payload.cwd ?? ``),
        }
      }
    } catch {
      continue
    }
  }

  return { sessionId: ``, cwd: `` }
}

async function exportSession(
  args: Record<string, string | boolean>,
  positional: Array<string>
): Promise<void> {
  const server =
    (args.server as string) ?? positional[0] ?? process.env.ASP_SERVER
  if (!server) {
    console.error(
      `Usage: asp export --server <url> [--agent claude|codex] [--session <id>]`
    )
    console.error(`  Or set the ASP_SERVER environment variable.`)
    process.exit(1)
  }

  let agent = (args.agent as AgentType) ?? detectAgent()
  const sessionId = args.session as string | undefined

  const sessions = await discoverSessions(agent ?? undefined)

  let session = sessionId
    ? sessions.find((s) => s.sessionId === sessionId)
    : sessions.find((s) => s.active) ?? sessions[sessions.length - 1]

  // Fallback: search for JSONL file directly when session ID is provided
  // but not found via metadata (e.g., older or continued sessions)
  if (!session && sessionId && (!agent || agent === `claude`)) {
    session = (await findClaudeSession(sessionId)) ?? undefined
  }

  if (!session) {
    console.error(`Session not found: ${sessionId ?? `(none)`}`)
    if (sessions.length > 0) {
      console.error(`Available sessions:`)
      for (const s of sessions) {
        console.error(
          `  ${s.agent} ${s.sessionId} ${s.active ? `(active)` : ``} ${s.cwd ?? ``}`
        )
      }
    }
    process.exit(1)
  }

  agent = session.agent

  console.error(`Exporting ${agent} session: ${session.sessionId}`)
  console.error(`  Path: ${session.path}`)

  const content = readFileSync(session.path, `utf8`)
  const rawLines = content.split(`\n`).filter((l) => l.trim())

  // 1. Push normalized stream
  const events = normalize(rawLines, agent)

  // Each share gets a unique ID: {entryCount}-{uuid}
  // Entry count gives monotonic ordering/size; uuid guarantees uniqueness
  // even if the user shares the same state multiple times.
  const shareId = `${events.length}-${randomUUID()}`
  const baseUrl = `${server.replace(/\/$/, ``)}/asp/${session.sessionId}/${shareId}`

  const normalizedLines = events.map((e) => JSON.stringify(e))

  console.error(`  Share ID: ${shareId}`)
  console.error(`  Normalized: ${events.length} events`)
  const newNormalized = await pushLines(
    baseUrl,
    `asp-normalized-${session.sessionId}-${shareId}`,
    normalizedLines
  )
  console.error(
    newNormalized > 0
      ? `  Pushed ${newNormalized} normalized events`
      : `  Normalized stream up to date`
  )

  // 2. Push native stream (raw JSONL for same-agent resume)
  const nativeUrl = `${baseUrl}/native/${agent}`
  const newNative = await pushLines(
    nativeUrl,
    `asp-native-${session.sessionId}-${shareId}`,
    rawLines
  )
  console.error(
    newNative > 0
      ? `  Pushed ${newNative} native ${agent} lines`
      : `  Native ${agent} stream up to date`
  )

  // Optionally shorten the URL via a shortener service
  const shortener =
    (args.shortener as string) ?? process.env.ASP_SHORTENER
  const token =
    (args.token as string) ??
    process.env.ASP_TOKEN ??
    process.env.DS_TOKEN

  if (shortener) {
    const shortUrl = await createShortUrl(shortener, {
      fullUrl: baseUrl,
      sessionId: session.sessionId,
      entryCount: events.length,
      agent,
      token: token ?? ``,
    })
    if (shortUrl) {
      console.error(`  Short URL: ${shortUrl}`)
      console.log(shortUrl)
      return
    }
    console.error(`  Shortener failed, printing full URL`)
  }

  console.log(baseUrl)
}

async function createShortUrl(
  shortener: string,
  payload: {
    fullUrl: string
    sessionId: string
    entryCount: number
    agent: AgentType
    token: string
  }
): Promise<string | null> {
  try {
    const endpoint = `${shortener.replace(/\/$/, ``)}/api/create`
    const response = await fetch(endpoint, {
      method: `POST`,
      headers: { "content-type": `application/json` },
      body: JSON.stringify(payload),
    })
    if (!response.ok) {
      const text = await response.text()
      console.error(`  Shortener error (${response.status}): ${text}`)
      return null
    }
    const data = (await response.json()) as { shortUrl: string }
    return data.shortUrl
  } catch (error) {
    console.error(
      `  Shortener request failed: ${error instanceof Error ? error.message : error}`
    )
    return null
  }
}

async function resolveShortUrl(url: string): Promise<string | null> {
  // Short URLs are registered on a shortener service and return JSON
  // with the actual DS URL when fetched with Accept: application/json.
  try {
    const response = await fetch(url, {
      headers: { accept: `application/json` },
    })
    if (!response.ok) return null
    const contentType = response.headers.get(`content-type`) ?? ``
    if (!contentType.includes(`application/json`)) return null
    const data = (await response.json()) as { fullUrl?: string }
    return data.fullUrl ?? null
  } catch {
    return null
  }
}

async function importSession(
  args: Record<string, string | boolean>,
  positional: Array<string>
): Promise<void> {
  const inputUrl = positional[0]
  if (!inputUrl) {
    console.error(
      `Usage: asp import <stream-url> --agent claude|codex [--cwd <dir>] [--resume]`
    )
    process.exit(1)
  }

  const agent = args.agent as AgentType
  if (!agent || (agent !== `claude` && agent !== `codex`)) {
    console.error(`--agent is required (claude or codex)`)
    process.exit(1)
  }

  // Try resolving as a short URL first. If the URL returns JSON with a
  // fullUrl field, use that; otherwise treat the input as a direct DS URL.
  let streamUrl = inputUrl
  const resolved = await resolveShortUrl(inputUrl)
  if (resolved) {
    streamUrl = resolved
    console.error(`Resolved short URL → ${streamUrl}`)
  }

  const cwd = (args.cwd as string) ?? process.cwd()
  const shouldResume = args.resume === true
  const newSessionId = randomUUID()

  console.error(`Importing from: ${streamUrl}`)
  console.error(`  Target agent: ${agent}`)
  console.error(`  CWD: ${cwd}`)

  // Try native stream first (same-agent, lossless)
  const nativeUrl = `${streamUrl}/native/${agent}`
  const hasNative = await streamExists(nativeUrl)

  let sessionPath: string

  if (hasNative) {
    console.error(`  Found native ${agent} stream — using lossless resume`)
    const nativeLines = (await readStream<string>(nativeUrl)).map((item) =>
      typeof item === `string` ? item : JSON.stringify(item)
    )

    const meta = extractSessionMeta(nativeLines, agent)
    const rewrittenLines = rewriteNativeLines(
      nativeLines,
      agent,
      newSessionId,
      cwd,
      meta.sessionId,
      meta.cwd
    )

    console.error(
      `  Rewritten ${rewrittenLines.length} lines (${meta.sessionId} → ${newSessionId})`
    )

    if (agent === `claude`) {
      sessionPath = writeClaudeSession(newSessionId, cwd, rewrittenLines)
    } else {
      sessionPath = writeCodexSession(newSessionId, rewrittenLines)
    }
  } else {
    console.error(`  No native ${agent} stream — using normalized (cross-agent)`)
    const events = await readStream<NormalizedEvent>(streamUrl)
    console.error(`  Read ${events.length} normalized events`)

    const lines = denormalize(events, agent, { sessionId: newSessionId, cwd })
    console.error(`  Denormalized: ${lines.length} lines`)

    if (agent === `claude`) {
      sessionPath = writeClaudeSession(newSessionId, cwd, lines)
    } else {
      sessionPath = writeCodexSession(newSessionId, lines)
    }
  }

  console.error(`  Wrote: ${sessionPath}`)

  if (agent === `claude`) {
    console.log(`Session ID: ${newSessionId}`)
    console.log(`Resume with: claude --resume ${newSessionId}`)
  } else {
    console.log(`Thread ID: ${newSessionId}`)
    console.log(`Resume with: codex resume ${newSessionId}`)
  }

  if (shouldResume) {
    const cmd =
      agent === `claude`
        ? `claude --resume ${newSessionId}`
        : `codex resume ${newSessionId}`
    console.error(`  Launching ${agent}...`)
    execSync(cmd, { stdio: `inherit`, cwd })
  }
}

function installSkills(args: Record<string, string | boolean>): void {
  // Locate the skills directory bundled with the package
  const cliDir = dirname(fileURLToPath(import.meta.url))
  // When running from dist/, skills is two levels up; when running from src/,
  // it's one level up. Check both.
  const candidates = [
    join(cliDir, `..`, `skills`),
    join(cliDir, `..`, `..`, `skills`),
  ]
  const skillsSource = candidates.find((p) => existsSync(p))
  if (!skillsSource) {
    console.error(`Could not find skills directory`)
    process.exit(1)
  }

  const targets: Array<{ agent: string; path: string }> = []
  const claudeOnly = args.claude === true
  const codexOnly = args.codex === true
  const installClaude = !codexOnly
  const installCodex = !claudeOnly

  if (installClaude) {
    targets.push({
      agent: `claude`,
      path: join(homedir(), `.claude`, `skills`),
    })
  }
  if (installCodex) {
    targets.push({
      agent: `codex`,
      path: join(homedir(), `.codex`, `skills`),
    })
  }

  for (const target of targets) {
    mkdirSync(target.path, { recursive: true })
    const skillTarget = join(target.path, `share`)
    const skillSource = join(skillsSource, `share`)

    if (existsSync(skillTarget)) {
      console.log(`  ${target.agent}: share skill already exists, skipping`)
      continue
    }

    try {
      symlinkSync(skillSource, skillTarget)
      console.log(`  ${target.agent}: share skill linked → ${skillSource}`)
    } catch (error) {
      console.error(
        `  ${target.agent}: failed to link skill: ${
          error instanceof Error ? error.message : error
        }`
      )
    }
  }

  console.log(
    `\nSkills installed. Use the "share" skill from within an agent session.`
  )
}

function showHelp(): void {
  console.log(`asp - Agent Session Protocol CLI

Usage:
  asp export --server <url> [--agent claude|codex] [--session <id>] [--token <token>] [--shortener <url>]
  asp import <stream-or-short-url> --agent claude|codex [--cwd <dir>] [--resume] [--token <token>]
  asp install-skills [--claude] [--codex]

Commands:
  export           Export an agent session to Durable Streams
                   Pushes both a normalized stream and a native (raw) stream.
                   Optionally registers a short URL via --shortener.
  import           Import a session from Durable Streams
                   Accepts either a full DS URL or a short URL (auto-resolved).
                   Prefers native stream for same-agent (lossless) resume.
                   Falls back to normalized stream for cross-agent resume.
  install-skills   Symlink the share skill into Claude Code and/or Codex
                   skill directories so it can be invoked from within a session.

Options:
  --server <url>     Durable Streams server URL (export)
  --agent <type>     Agent type: claude or codex
  --session <id>     Session/thread ID (defaults to active/most recent)
  --cwd <dir>        Working directory for imported session (defaults to current)
  --resume           After importing, immediately resume the session in the target agent
  --token <token>    Auth token for the DS server (or set ASP_TOKEN / DS_TOKEN env var)
  --shortener <url>  URL of an asp-shortener instance; registers a short URL for the export

Environment variables:
  ASP_SERVER         Default Durable Streams server URL
  ASP_TOKEN          Auth token (same as --token)
  ASP_SHORTENER      Default shortener URL (same as --shortener)`)
}

async function main(): Promise<void> {
  const { command, args, positional } = parseArgs(process.argv.slice(2))

  const token =
    (args.token as string) ?? process.env.ASP_TOKEN ?? process.env.DS_TOKEN
  if (token) {
    globalHeaders = { Authorization: `Bearer ${token}` }
  }

  switch (command) {
    case `export`:
      await exportSession(args, positional)
      break
    case `import`:
      await importSession(args, positional)
      break
    case `install-skills`:
      installSkills(args)
      break
    case `help`:
    case `--help`:
    case `-h`:
      showHelp()
      break
    default:
      console.error(`Unknown command: ${command}`)
      showHelp()
      process.exit(1)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
