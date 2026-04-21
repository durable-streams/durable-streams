import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
  watch,
  writeFileSync,
} from "node:fs"
import { randomUUID } from "node:crypto"
import { execSync } from "node:child_process"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { DurableStream, FetchError } from "@durable-streams/client"
import {
  discoverSessions,
  findClaudeSession,
  rewriteNativeLines,
  writeClaudeSession,
  writeCodexSession,
} from "./sessions.js"
import { SkillInvocationFilter } from "./filter-skill-invocations.js"
import { denormalize, normalize } from "./index.js"
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
    const stream = new DurableStream({
      url,
      contentType: `application/json`,
      headers: globalHeaders,
    })
    const response = await stream.stream({ json: true, live: false })
    const items = await response.json()
    return items.length > 0
  } catch {
    return false
  }
}

async function readStream<T>(url: string): Promise<Array<T>> {
  const stream = new DurableStream({
    url,
    contentType: `application/json`,
    headers: globalHeaders,
  })
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
    (args.server as string | undefined) ??
    positional[0] ??
    process.env.ASP_SERVER
  if (!server) {
    console.error(
      `Usage: asp export --server <url> [--agent claude|codex] [--session <id>]`
    )
    console.error(`  Or set the ASP_SERVER environment variable.`)
    process.exit(1)
  }

  let agent: AgentType | undefined =
    (args.agent as AgentType | undefined) ?? detectAgent() ?? undefined
  const sessionId = args.session as string | undefined

  const sessions = await discoverSessions(agent)

  let session = sessionId
    ? sessions.find((s) => s.sessionId === sessionId)
    : (sessions.find((s) => s.active) ?? sessions[sessions.length - 1])

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
  const live = args.live === true

  console.error(
    `Exporting ${agent} session ${live ? `(live)` : `(snapshot)`}: ${session.sessionId}`
  )
  console.error(`  Path: ${session.path}`)

  const content = readFileSync(session.path, `utf8`)
  const unfilteredLines = content.split(`\n`).filter((l) => l.trim())
  // Strip out /share skill-invocation rounds so resumed sessions don't
  // show the share plumbing at the tail. Filter is stateful so that
  // skill-execution machinery spanning the initial snapshot and later
  // incremental live-watcher batches is handled as one contiguous round.
  const skillFilter = new SkillInvocationFilter(agent)
  const rawLines = skillFilter.feed(unfilteredLines)
  const events = normalize(rawLines, agent)

  // URL pattern:
  //  - snapshot: /asp/{sessionId}/{entryCount}-{uuid}      (unique per share)
  //  - live:     /asp/{sessionId}/live                     (one per session)
  const shareId = live ? `live` : `${events.length}-${randomUUID()}`
  const baseUrl = `${server.replace(/\/$/, ``)}/asp/${session.sessionId}/${shareId}`
  const nativeUrl = `${baseUrl}/native/${agent}`

  const normalizedLines = events.map((e) => JSON.stringify(e))

  if (!live) {
    console.error(`  Share ID: ${shareId}`)
  }
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
    (args.shortener as string | undefined) ?? process.env.ASP_SHORTENER
  const token =
    (args.token as string | undefined) ??
    process.env.ASP_TOKEN ??
    process.env.DS_TOKEN

  let outputUrl = baseUrl
  if (shortener) {
    const shortUrl = await createShortUrl(shortener, {
      fullUrl: baseUrl,
      sessionId: session.sessionId,
      entryCount: events.length,
      agent,
      token: token ?? ``,
      live,
    })
    if (shortUrl) {
      console.error(`  Short URL: ${shortUrl}`)
      outputUrl = shortUrl
    } else {
      console.error(`  Shortener failed, using full URL`)
    }
  }

  if (!live) {
    console.log(outputUrl)
    return
  }

  // Live mode: print the URL now, then watch the source file forever
  console.log(outputUrl)
  console.error(``)
  console.error(`Watching ${session.path}`)
  console.error(`Press Ctrl-C to stop sharing.`)

  // Create the prompt queue stream now so viewers can POST to it. Without
  // this the first POST from the viewer would 404.
  const queueUrl = `${baseUrl}/prompts`
  try {
    await createOrConnectStream(queueUrl, `application/json`)
    console.error(`  Queue stream ready: ${queueUrl}`)
  } catch (error) {
    console.error(
      `  Failed to create queue stream (collab disabled):`,
      error instanceof Error ? error.message : error
    )
  }

  // Publish the collab config file so the queue-channel MCP subprocess
  // (already running under CC if the user started claude with
  // --dangerously-load-development-channels server:queue) can pick up
  // the session's queue URL and start forwarding prompts.
  const collabPath = writeCollabConfig({
    sessionId: session.sessionId,
    dsBase: server,
    queueUrl,
    token,
  })
  console.error(`  Collab config: ${collabPath}`)

  try {
    await watchAndPushLive({
      sourcePath: session.path,
      nativeUrl,
      normalizedUrl: baseUrl,
      agent,
      skillFilter,
    })
  } finally {
    removeCollabConfig()
  }
}

interface WatchOptions {
  sourcePath: string
  nativeUrl: string
  normalizedUrl: string
  agent: AgentType
  // Shared across the initial export and the watcher so a skill round
  // that spans the boundary (invocation in the snapshot, machinery in
  // later batches) is stripped as a single contiguous round.
  skillFilter: SkillInvocationFilter
}

/**
 * Read bytes [start, end) from the source file.
 */
function readByteRange(
  path: string,
  start: number,
  end: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (end <= start) {
      resolve(``)
      return
    }
    const chunks: Array<Buffer> = []
    const stream = createReadStream(path, {
      start,
      end: end - 1, // createReadStream end is inclusive
      encoding: `utf8`,
    })
    stream.on(`data`, (chunk) => {
      chunks.push(typeof chunk === `string` ? Buffer.from(chunk) : chunk)
    })
    stream.on(`end`, () => resolve(Buffer.concat(chunks).toString(`utf8`)))
    stream.on(`error`, reject)
  })
}

async function watchAndPushLive(opts: WatchOptions): Promise<void> {
  let lastByteOffset = statSync(opts.sourcePath).size
  // Buffer for a trailing partial line (no \n yet) — held until next tick.
  let partialLineBuffer = ``
  let busy = false
  let pending = false
  let stopping = false

  const nativeStream = await createOrConnectStream(
    opts.nativeUrl,
    `application/json`
  )
  const normalizedStream = await createOrConnectStream(
    opts.normalizedUrl,
    `application/json`
  )

  async function processChanges(): Promise<void> {
    if (stopping) return
    if (busy) {
      pending = true
      return
    }
    busy = true
    try {
      const stat = statSync(opts.sourcePath)
      // File was truncated/replaced — re-read from start
      if (stat.size < lastByteOffset) {
        lastByteOffset = 0
        partialLineBuffer = ``
      }
      if (stat.size === lastByteOffset) return

      // Read only the new bytes since the last tick
      const newBytes = await readByteRange(
        opts.sourcePath,
        lastByteOffset,
        stat.size
      )
      lastByteOffset = stat.size

      // Combine with any partial line carried over from last tick
      const combined = partialLineBuffer + newBytes
      const lastNewlineIdx = combined.lastIndexOf(`\n`)
      let completeChunk: string
      if (lastNewlineIdx === -1) {
        // No newline at all — entire chunk is partial
        partialLineBuffer = combined
        completeChunk = ``
      } else {
        completeChunk = combined.slice(0, lastNewlineIdx)
        partialLineBuffer = combined.slice(lastNewlineIdx + 1)
      }

      const unfilteredNewLines = completeChunk
        .split(`\n`)
        .filter((l) => l.trim())
      if (unfilteredNewLines.length === 0) return

      // Run the batch through the stateful skill-invocation filter.
      // State is shared with the initial export, so a /share round that
      // straddles the snapshot boundary is stripped as a single round.
      const newRawLines = opts.skillFilter.feed(unfilteredNewLines)
      if (newRawLines.length === 0) return

      // Push new native lines as-is
      await Promise.all(newRawLines.map((line) => nativeStream.append(line)))

      // Incrementally normalize ONLY the new lines.
      // - fromCompaction: false → don't try to find a compaction boundary
      //   (we want to process every new line as a continuation)
      // - filter out synthetic session_init that the normalizer auto-injects
      //   when no system/init is present in the input (we already emitted one
      //   on the first push)
      const newEvents = normalize(newRawLines, opts.agent, {
        fromCompaction: false,
      }).filter((e) => e.type !== `session_init`)

      if (newEvents.length > 0) {
        await Promise.all(
          newEvents.map((event) =>
            normalizedStream.append(JSON.stringify(event))
          )
        )
      }

      const ts = new Date().toISOString().slice(11, 19)
      console.error(
        `[${ts}] +${newRawLines.length} native, +${newEvents.length} normalized`
      )
    } catch (error) {
      console.error(
        `  Watcher error: ${error instanceof Error ? error.message : error}`
      )
    } finally {
      busy = false
      // eslint can't see that `stopping` is reassigned inside the SIGINT
      // handler closure below, so it thinks `!stopping` is always true.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (pending && !stopping) {
        pending = false
        void processChanges()
      }
    }
  }

  const watcher = watch(opts.sourcePath, () => {
    void processChanges()
  })

  // Also poll periodically as a safety net (fs.watch can miss events on macOS/NFS)
  const pollInterval = setInterval(() => {
    void processChanges()
  }, 2000)

  await new Promise<void>((resolve) => {
    const handleSignal = async (): Promise<void> => {
      stopping = true
      clearInterval(pollInterval)
      watcher.close()
      console.error(``)
      console.error(`Stopping live share — emitting session_end`)
      try {
        const endEvent: NormalizedEvent = {
          v: 1,
          ts: Date.now(),
          type: `session_end`,
        }
        await normalizedStream.append(JSON.stringify(endEvent))
      } catch (error) {
        console.error(
          `  Failed to emit session_end: ${
            error instanceof Error ? error.message : error
          }`
        )
      }
      resolve()
    }

    process.once(`SIGINT`, () => void handleSignal())
    process.once(`SIGTERM`, () => void handleSignal())
  })
}

async function createShortUrl(
  shortener: string,
  payload: {
    fullUrl: string
    sessionId: string
    entryCount: number
    agent: AgentType
    token: string
    live?: boolean
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

  const agentArg = args.agent as string | undefined
  if (agentArg !== `claude` && agentArg !== `codex`) {
    console.error(`--agent is required (claude or codex)`)
    process.exit(1)
  }
  const agent: AgentType = agentArg

  // Try resolving as a short URL first. If the URL returns JSON with a
  // fullUrl field, use that; otherwise treat the input as a direct DS URL.
  let streamUrl = inputUrl
  const resolved = await resolveShortUrl(inputUrl)
  if (resolved) {
    streamUrl = resolved
    console.error(`Resolved short URL → ${streamUrl}`)
  }

  const cwd = (args.cwd as string | undefined) ?? process.cwd()
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
    console.error(
      `  No native ${agent} stream — using normalized (cross-agent)`
    )
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

/**
 * Install the queue-channel MCP server into Claude Code's global MCP
 * config (~/.claude.json). Safe to run repeatedly; overwrites the
 * existing `queue` entry. The MCP subprocess sits idle until a live
 * share writes ~/.sesh/active-collab.json, so global registration
 * doesn't do anything risky by default.
 */
function installChannel(): void {
  const queueBinPath = fileURLToPath(
    new URL(`../bin/queue-channel.mjs`, import.meta.url)
  )

  if (!existsSync(queueBinPath)) {
    console.error(`Channel binary not found at ${queueBinPath}`)
    console.error(
      `Make sure the agent-session-protocol package is built (pnpm build).`
    )
    process.exit(1)
  }

  const claudeConfigPath = join(homedir(), `.claude.json`)
  interface ClaudeConfig {
    mcpServers?: Record<string, unknown>
    [key: string]: unknown
  }
  let config: ClaudeConfig = {}
  if (existsSync(claudeConfigPath)) {
    try {
      config = JSON.parse(
        readFileSync(claudeConfigPath, `utf8`)
      ) as ClaudeConfig
    } catch (error) {
      console.error(
        `Failed to parse ${claudeConfigPath}:`,
        error instanceof Error ? error.message : error
      )
      process.exit(1)
    }
  }

  config.mcpServers ??= {}
  config.mcpServers[`queue`] = {
    command: `node`,
    args: [queueBinPath],
  }

  writeFileSync(claudeConfigPath, JSON.stringify(config, null, 2) + `\n`)
  console.log(`Registered queue channel in ${claudeConfigPath}`)
  console.log(`  command: node ${queueBinPath}`)
  console.log(``)
  console.log(
    `To enable live-collaboration for new CC sessions, start claude with:`
  )
  console.log(``)
  console.log(`  claude --dangerously-load-development-channels server:queue`)
  console.log(``)
  console.log(
    `You can alias this in your shell. Once CC is running with channels,`
  )
  console.log(
    `every \`/share live\` in that session enables remote prompt submission`
  )
  console.log(`from the share URL — no CC restart needed.`)
}

/**
 * Write the per-session collab config so the queue-channel MCP
 * subprocess (already running under CC) picks up the session's DS
 * queue URL and auth token. The subprocess watches
 * ~/.sesh/active-collab.json via fs.watch.
 */
function writeCollabConfig(opts: {
  sessionId: string
  dsBase: string
  queueUrl: string
  token: string | undefined
}): string {
  const dir = join(homedir(), `.sesh`)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `active-collab.json`)
  const payload = {
    sessionId: opts.sessionId,
    dsBase: opts.dsBase,
    queueUrl: opts.queueUrl,
    dsToken: opts.token,
    // Include the watcher's PID so a new CC session's queue-channel MCP
    // can detect stale configs (previous watcher crashed or was killed
    // without running its SIGINT handler) and refuse to use them.
    pid: process.pid,
  }
  writeFileSync(path, JSON.stringify(payload, null, 2) + `\n`)
  return path
}

function removeCollabConfig(): void {
  const path = join(homedir(), `.sesh`, `active-collab.json`)
  if (existsSync(path)) {
    try {
      unlinkSync(path)
    } catch {
      // best-effort on shutdown
    }
  }
}

function showHelp(): void {
  console.log(`asp - Agent Session Protocol CLI

Usage:
  asp export --server <url> [--agent claude|codex] [--session <id>] [--token <token>] [--shortener <url>] [--live]
  asp import <stream-or-short-url> --agent claude|codex [--cwd <dir>] [--resume] [--token <token>]
  asp install-skills [--claude] [--codex]
  asp install-channel

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
  install-channel  Register the queue-channel MCP server in ~/.claude.json so
                   Claude Code can inject prompts from live-share viewers.
                   One-time setup; after this, start claude with
                   --dangerously-load-development-channels server:queue.

Options:
  --server <url>     Durable Streams server URL (export)
  --agent <type>     Agent type: claude or codex
  --session <id>     Session/thread ID (defaults to active/most recent)
  --cwd <dir>        Working directory for imported session (defaults to current)
  --resume           After importing, immediately resume the session in the target agent
  --token <token>    Auth token for the DS server (or set ASP_TOKEN / DS_TOKEN env var)
  --shortener <url>  URL of an asp-shortener instance; registers a short URL for the export
  --live             Live mode: keep watching the source session and stream updates
                     to the same URL until Ctrl-C. Re-running --live for the same
                     session reuses the existing live URL.

Environment variables:
  ASP_SERVER         Default Durable Streams server URL
  ASP_TOKEN          Auth token (same as --token)
  ASP_SHORTENER      Default shortener URL (same as --shortener)`)
}

async function main(): Promise<void> {
  const { command, args, positional } = parseArgs(process.argv.slice(2))

  const token =
    (args.token as string | undefined) ??
    process.env.ASP_TOKEN ??
    process.env.DS_TOKEN
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
    case `install-channel`:
      installChannel()
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
