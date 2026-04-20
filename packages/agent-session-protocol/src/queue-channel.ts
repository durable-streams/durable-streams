/**
 * queue-channel — a Claude Code channel MCP server that pushes prompts
 * from a Durable Stream into the running Claude Code session.
 *
 * How it's wired up:
 *
 *   1. `asp install-channel` registers this binary in ~/.claude.json so
 *      CC spawns it as a stdio subprocess at startup.
 *
 *   2. User starts CC with `--dangerously-load-development-channels
 *      server:queue`. CC treats our subprocess as a channel and listens
 *      for `notifications/claude/channel` events from us.
 *
 *   3. This subprocess boots idle: it has no DS subscription yet. It
 *      watches ~/.sesh/active-collab.json.
 *
 *   4. `asp export --live` writes that file on startup with the
 *      session's DS base URL, token, and queue stream path. We pick
 *      the file up via fs.watch, open an SSE subscription to the
 *      prompt-queue DS stream, and start forwarding each prompt as a
 *      channel notification so Claude takes a turn automatically.
 *
 *   5. When `asp export --live` exits it deletes the config file. We
 *      see that and close the subscription back to idle.
 */

import { existsSync, mkdirSync, readFileSync, watch } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { DurableStream } from "@durable-streams/client"
import type { HeadersRecord } from "@durable-streams/client"

const CONFIG_DIR = join(homedir(), `.sesh`)
const CONFIG_PATH = join(CONFIG_DIR, `active-collab.json`)

interface CollabConfig {
  sessionId: string
  dsBase: string
  dsToken?: string
  queueUrl: string
  // PID of the `asp export --live` watcher that wrote this file. Used for
  // staleness detection: if the watcher process is gone, the config is
  // stale and we shouldn't subscribe to its (possibly reused) queue URL.
  pid?: number
}

/**
 * Return true if a process with this pid is alive on this machine. Uses
 * signal 0 (the standard liveness probe — doesn't actually deliver a
 * signal, just checks permissions and existence).
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

interface QueuedPrompt {
  v?: number
  ts?: number
  type?: string
  text: string
  user?: { name?: string }
}

function log(...args: Array<unknown>): void {
  // stderr is the only channel we can use — stdout is CC's MCP transport.
  console.error(`[queue-channel]`, ...args)
}

async function main(): Promise<void> {
  const mcp = new Server(
    { name: `queue`, version: `0.0.1` },
    {
      capabilities: { experimental: { "claude/channel": {} } },
      instructions:
        `Prompts from remote collaborators arrive as ` +
        `<channel source="queue" user="..."> events. Treat each prompt ` +
        `as if the user had typed it in the terminal — answer in the ` +
        `normal conversation flow. The "user" attribute is a display ` +
        `name you can reference when attributing work.`,
    }
  )

  await mcp.connect(new StdioServerTransport())
  log(`connected; watching ${CONFIG_PATH}`)

  // Ensure the directory exists so fs.watch doesn't fail when the dir is
  // missing. The file inside may or may not exist at any given moment.
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true })
  }

  let activeCloser: (() => void) | null = null
  let activeSessionId: string | null = null

  async function apply(): Promise<void> {
    // Close any existing subscription first. Switching sessions mid-CC
    // is unusual but possible — a user could /share --stop and start a
    // new live share in the same CC session.
    if (activeCloser) {
      activeCloser()
      activeCloser = null
      log(`closed previous subscription (session ${activeSessionId})`)
      activeSessionId = null
    }

    if (!existsSync(CONFIG_PATH)) {
      log(`idle (no config)`)
      return
    }

    let config: CollabConfig
    try {
      config = JSON.parse(readFileSync(CONFIG_PATH, `utf8`)) as CollabConfig
    } catch (error) {
      log(
        `failed to read config:`,
        error instanceof Error ? error.message : error
      )
      return
    }

    if (!config.queueUrl) {
      log(`config missing queueUrl`)
      return
    }

    // Staleness check: if the config includes a pid and that process is
    // gone, a previous watcher died without cleanup. Don't subscribe —
    // we'd be delivering prompts from a session that no one is still
    // sharing. The user will see us stay idle until the next
    // /share live writes a fresh config.
    if (typeof config.pid === `number` && !isPidAlive(config.pid)) {
      log(
        `stale config (pid ${config.pid} not alive) — ignoring. ` +
          `Remove ${CONFIG_PATH} or run /share live again to refresh.`
      )
      return
    }

    const headers: HeadersRecord = config.dsToken
      ? { Authorization: `Bearer ${config.dsToken}` }
      : {}

    // Subscribe from the current tail (not offset=-1 / from beginning) so
    // we only deliver prompts submitted AFTER we start watching. Replaying
    // the whole history on every CC startup would flood the new session
    // with prompts that were already handled by the previous CC process.
    log(`fetching current tail offset for ${config.queueUrl}`)
    let tailOffset: string
    try {
      const headRes = await fetch(config.queueUrl, { method: `HEAD`, headers })
      if (!headRes.ok && headRes.status !== 204) {
        throw new Error(`HEAD ${config.queueUrl} → ${headRes.status}`)
      }
      tailOffset = headRes.headers.get(`stream-next-offset`) ?? `-1`
    } catch (error) {
      log(
        `failed to fetch tail offset, falling back to beginning:`,
        error instanceof Error ? error.message : error
      )
      tailOffset = `-1`
    }

    log(
      `subscribing to ${config.queueUrl} from offset ${tailOffset} (session ${config.sessionId})`
    )
    try {
      const stream = new DurableStream({
        url: config.queueUrl,
        contentType: `application/json`,
        headers,
      })
      const response = await stream.stream<QueuedPrompt>({
        json: true,
        live: `sse`,
        offset: tailOffset,
      })

      activeCloser = response.subscribeJson(async (batch) => {
        for (const prompt of batch.items) {
          if (typeof prompt.text !== `string` || !prompt.text.trim()) continue
          const userName = prompt.user?.name ?? `anonymous`
          try {
            await mcp.notification({
              method: `notifications/claude/channel`,
              params: {
                content: prompt.text,
                meta: {
                  user: userName,
                  ts: String(prompt.ts ?? Date.now()),
                },
              },
            })
            log(
              `delivered prompt from ${userName} (${prompt.text.length} chars)`
            )
          } catch (error) {
            log(
              `failed to deliver prompt:`,
              error instanceof Error ? error.message : error
            )
          }
        }
      })
      activeSessionId = config.sessionId
      log(`subscription established`)
    } catch (error) {
      log(
        `failed to open subscription:`,
        error instanceof Error ? error.message : error
      )
    }
  }

  // Initial read in case the config already exists (e.g., CC was restarted
  // while a live share was still active).
  await apply()

  // Watch the parent directory because fs.watch on a non-existent file
  // errors out; watching the dir and filtering by filename works whether
  // the file is present or not.
  const watcher = watch(CONFIG_DIR, (_event, filename) => {
    if (filename === `active-collab.json`) {
      void apply().catch((error) => {
        log(`apply() threw:`, error instanceof Error ? error.message : error)
      })
    }
  })

  const shutdown = (): void => {
    log(`shutting down`)
    try {
      activeCloser?.()
      watcher.close()
    } finally {
      process.exit(0)
    }
  }

  process.on(`SIGTERM`, shutdown)
  process.on(`SIGINT`, shutdown)
  process.stdin.on(`close`, shutdown)
}

main().catch((error) => {
  log(`fatal:`, error instanceof Error ? error.message : error)
  process.exit(1)
})
