import { spawn } from "node:child_process"
import { WebSocketServer } from "ws"
import { formatPromptForAgent } from "../prompt-format.js"
import type WebSocket from "ws"
import type {
  AgentAdapter,
  AgentConnection,
  MessageClassification,
  PreparedResume,
  ResumeOptions,
  SpawnOptions,
} from "./types.js"
import type { ClientIntent, StreamEnvelope, User } from "../types.js"

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9.-]/g, `-`) || `project`
}

async function canonicalizeCwd(cwd: string): Promise<string> {
  const fs = await import(`node:fs/promises`)

  try {
    return await fs.realpath(cwd)
  } catch {
    return cwd
  }
}

function getTranscriptPathFromCanonicalCwd(
  cwd: string,
  sessionId: string
): string {
  return [
    process.env.HOME ?? ``,
    `.claude`,
    `projects`,
    sanitizePathSegment(cwd),
    `${sessionId}.jsonl`,
  ].join(`/`)
}

function getSessionSignalsPath(
  sessionId: string,
  suffix: `stop` | `ended`
): string {
  return [
    process.env.HOME ?? ``,
    `.claude`,
    `session-signals`,
    `${sessionId}.${suffix}.json`,
  ].join(`/`)
}

function rewriteTranscriptText(
  transcript: string,
  options: {
    rewritePaths?: Record<string, string>
    fromSessionId?: string
    toSessionId?: string
  }
): string {
  let rewritten = transcript

  if (
    options.fromSessionId &&
    options.toSessionId &&
    options.fromSessionId !== options.toSessionId
  ) {
    rewritten = rewritten.replaceAll(options.fromSessionId, options.toSessionId)
  }

  for (const [from, to] of Object.entries(options.rewritePaths ?? {})) {
    rewritten = rewritten.replaceAll(from, to)
  }

  return rewritten
}

function extractErrorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isMissingClaudeConversationError(error: unknown): boolean {
  return extractErrorDetail(error).includes(
    `No conversation found with session ID`
  )
}

function rawDataToText(data: unknown): string {
  if (typeof data === `string`) {
    return data
  }

  if (data instanceof Buffer) {
    return data.toString(`utf8`)
  }

  if (Array.isArray(data)) {
    return Buffer.concat(
      data.map((chunk) =>
        chunk instanceof Buffer ? chunk : Buffer.from(chunk as ArrayBuffer)
      )
    ).toString(`utf8`)
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString(`utf8`)
  }

  return Buffer.from(String(data)).toString(`utf8`)
}

async function findFreePort(): Promise<number> {
  const net = await import(`node:net`)

  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, `127.0.0.1`, () => {
      const address = server.address()
      if (!address || typeof address === `string`) {
        server.close()
        reject(new Error(`Could not allocate a local port for Claude Code`))
        return
      }

      server.close(() => resolve(address.port))
    })
    server.once(`error`, reject)
  })
}

export function buildClaudeCliArgs(
  sdkUrl: string,
  options: SpawnOptions
): Array<string> {
  const args = [
    `--sdk-url`,
    sdkUrl,
    `--print`,
    `--output-format`,
    `stream-json`,
    `--input-format`,
    `stream-json`,
  ]

  if (options.model) {
    args.push(`--model`, options.model)
  }

  if (options.permissionMode) {
    args.push(`--permission-mode`, options.permissionMode)
  }

  if (options.developerInstructions) {
    args.push(`--append-system-prompt`, options.developerInstructions)
  }

  if (options.verbose) {
    args.push(`--verbose`)
  }

  if (options.resume) {
    args.push(`--resume`, options.resume)
  }

  args.push(`-p`, ``)

  return args
}

export class ClaudeAdapter implements AgentAdapter {
  readonly agentType = `claude` as const

  async spawn(options: SpawnOptions): Promise<AgentConnection> {
    if (options.resume && options.forceSeedWorkspace) {
      const seededResumeId = await this.seedSyntheticResumeSession(
        options,
        options.resume
      )

      return await this.spawnBridgeConnection({
        ...options,
        resume: seededResumeId,
        forceSeedWorkspace: false,
      })
    }

    try {
      return await this.spawnBridgeConnection(options)
    } catch (error) {
      if (!options.resume || !isMissingClaudeConversationError(error)) {
        throw error
      }

      const seededResumeId = await this.seedSyntheticResumeSession(
        options,
        options.resume
      )
      return await this.spawnBridgeConnection({
        ...options,
        resume: seededResumeId,
      })
    }
  }

  protected async spawnBridgeConnection(
    options: SpawnOptions
  ): Promise<AgentConnection> {
    const port = await findFreePort()
    const sessionId = options.resume ?? `session-${Date.now()}`
    const sdkUrl = `ws://127.0.0.1:${port}/ws/cli/${sessionId}`

    return await new Promise<AgentConnection>((resolve, reject) => {
      const args = buildClaudeCliArgs(sdkUrl, options)

      const child = spawn(`claude`, args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: [`ignore`, `pipe`, `pipe`],
      })

      let childStdout = ``
      let childStderr = ``
      child.stdout.on(`data`, (chunk: Buffer) => {
        childStdout += chunk.toString(`utf8`)
      })
      child.stderr.on(`data`, (chunk: Buffer) => {
        childStderr += chunk.toString(`utf8`)
      })

      const wss = new WebSocketServer({ host: `127.0.0.1`, port })
      const timeout = setTimeout(() => {
        safeClose()
        child.kill()
        const detail = childStderr.trim() || childStdout.trim()
        reject(
          new Error(
            detail
              ? `Claude Code did not connect to the bridge in 30s: ${detail}`
              : `Claude Code did not connect to the bridge in 30s`
          )
        )
      }, 30_000)

      let resolved = false
      let closed = false
      let socket: WebSocket | null = null
      let messageHandler: ((raw: object) => void) | null = null
      let exitHandler: ((code: number | null) => void) | null = null

      const safeClose = () => {
        if (closed) {
          return
        }

        closed = true
        clearTimeout(timeout)
        socket?.close()
        wss.close()
      }

      child.once(`error`, (error) => {
        safeClose()
        if (!resolved) {
          reject(error)
          return
        }

        exitHandler?.(null)
      })

      child.once(`exit`, (code) => {
        safeClose()

        if (!resolved) {
          const detail = childStderr.trim() || childStdout.trim()
          reject(
            new Error(
              detail
                ? `Claude Code exited before connecting: ${detail}`
                : `Claude Code exited before connecting${
                    code == null ? `` : ` (exit code ${code})`
                  }`
            )
          )
          return
        }

        exitHandler?.(code)
      })

      wss.once(`connection`, (ws) => {
        resolved = true
        socket = ws
        clearTimeout(timeout)

        let buffer = ``
        ws.on(`message`, (data: unknown) => {
          buffer += rawDataToText(data)
          const lines = buffer.split(`\n`)
          buffer = lines.pop() ?? ``

          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed) {
              continue
            }

            try {
              messageHandler?.(JSON.parse(trimmed) as object)
            } catch {
              // Ignore partial or malformed NDJSON lines.
            }
          }
        })

        const connection: AgentConnection = {
          onMessage(handler) {
            messageHandler = handler
          },
          send(raw) {
            if (socket?.readyState === 1) {
              socket.send(`${JSON.stringify(raw)}\n`)
            }
          },
          close() {
            safeClose()
          },
          kill() {
            safeClose()
            child.kill()
          },
          on(_event, handler) {
            exitHandler = handler
          },
        }

        resolve(connection)
      })
    })
  }

  protected async createSeedSession(options: SpawnOptions): Promise<string> {
    const fs = await import(`node:fs/promises`)
    const connection = await this.spawnBridgeConnection({
      ...options,
      resume: undefined,
      forceSeedWorkspace: false,
      resumeTranscriptSourcePath: undefined,
    })

    return await new Promise<string>((resolve, reject) => {
      let sessionId: string | undefined
      let sawTurnComplete = false
      let settled = false
      let promptSent = false
      let stopping = false
      let forceKillTimeout: NodeJS.Timeout | null = null
      let lastAssistantMessage = ``

      const sendSeedPrompt = (): void => {
        if (promptSent || settled) {
          return
        }

        promptSent = true
        connection.send(
          this.translateClientIntent({
            type: `user_message`,
            text: `Reply with exactly OK and nothing else.`,
          })
        )
      }

      const fail = (error: Error): void => {
        if (settled) {
          return
        }

        settled = true
        clearTimeout(timeout)
        if (forceKillTimeout) {
          clearTimeout(forceKillTimeout)
          forceKillTimeout = null
        }
        connection.kill()
        reject(error)
      }

      const requestStop = async (): Promise<void> => {
        if (settled || stopping) {
          return
        }

        if (typeof sessionId !== `string`) {
          fail(new Error(`Claude seed session never produced a session id`))
          return
        }

        stopping = true

        try {
          const canonicalCwd = await canonicalizeCwd(options.cwd)
          const transcriptPath = getTranscriptPathFromCanonicalCwd(
            canonicalCwd,
            sessionId
          )
          const stopPath = getSessionSignalsPath(sessionId, `stop`)

          await fs.mkdir(stopPath.slice(0, stopPath.lastIndexOf(`/`)), {
            recursive: true,
          })
          await fs.writeFile(
            stopPath,
            JSON.stringify({
              session_id: sessionId,
              transcript_path: transcriptPath,
              cwd: canonicalCwd,
              permission_mode: options.permissionMode ?? `default`,
              hook_event_name: `Stop`,
              stop_hook_active: false,
              last_assistant_message: lastAssistantMessage,
              stopped_at: `${Date.now() / 1000}`,
            }),
            `utf8`
          )
        } catch (error) {
          fail(
            new Error(
              `Failed to write Claude stop signal: ${extractErrorDetail(error)}`
            )
          )
          return
        }

        forceKillTimeout = setTimeout(() => {
          connection.kill()
        }, 10_000)
      }

      const timeout = setTimeout(() => {
        fail(new Error(`Claude seed session timed out`))
      }, 30_000)

      connection.onMessage((raw) => {
        const message = raw as Record<string, unknown>
        if (typeof message.session_id === `string`) {
          sessionId = message.session_id
        }

        if (message.type === `assistant`) {
          const assistantMessage = message.message as
            | Record<string, unknown>
            | undefined
          const content = assistantMessage?.content
          if (Array.isArray(content)) {
            lastAssistantMessage = content
              .flatMap((item) => {
                const part = item as Record<string, unknown>
                return typeof part.text === `string` ? [part.text] : []
              })
              .join(``)
          }
        }

        if (
          !promptSent &&
          message.type === `system` &&
          message.subtype === `init`
        ) {
          sendSeedPrompt()
        }

        if (this.isTurnComplete(raw)) {
          sawTurnComplete = true
          void requestStop()
        }
      })

      connection.on(`exit`, (code) => {
        if (forceKillTimeout) {
          clearTimeout(forceKillTimeout)
          forceKillTimeout = null
        }

        if (settled) {
          if (
            sawTurnComplete &&
            typeof sessionId === `string` &&
            (code === 0 || code === null)
          ) {
            settled = true
            resolve(sessionId)
          }
          return
        }

        clearTimeout(timeout)

        if (!sawTurnComplete || typeof sessionId !== `string`) {
          reject(
            new Error(
              `Claude seed session exited before completing a resumable turn${
                code == null ? `` : ` (exit code ${code})`
              }`
            )
          )
          return
        }

        settled = true
        resolve(sessionId)
      })

      setTimeout(() => {
        sendSeedPrompt()
      }, 100)
    })
  }

  protected async seedSyntheticResumeSession(
    options: SpawnOptions,
    syntheticResumeId: string
  ): Promise<string> {
    const fs = await import(`node:fs/promises`)
    const canonicalCwd = await canonicalizeCwd(options.cwd)

    const sourceTranscriptPath =
      options.resumeTranscriptSourcePath ??
      getTranscriptPathFromCanonicalCwd(canonicalCwd, syntheticResumeId)
    const seededResumeId = await this.createSeedSession(options)
    const seededTranscriptPath = getTranscriptPathFromCanonicalCwd(
      canonicalCwd,
      seededResumeId
    )

    const syntheticTranscript = await fs.readFile(sourceTranscriptPath, `utf8`)
    const rewrittenTranscript = rewriteTranscriptText(syntheticTranscript, {
      rewritePaths: options.rewritePaths,
      fromSessionId: syntheticResumeId,
      toSessionId: seededResumeId,
    })
    await fs.writeFile(seededTranscriptPath, rewrittenTranscript, `utf8`)

    return seededResumeId
  }

  parseDirection(raw: object): MessageClassification {
    const message = raw as Record<string, unknown>
    const type = message.type as string | undefined

    if (type === `control_request`) {
      return { type: `request`, id: message.request_id as string | number }
    }

    if (type === `control_response`) {
      const response = message.response as Record<string, unknown> | undefined
      return {
        type: `response`,
        id: response?.request_id as string | number | undefined,
      }
    }

    return { type: `notification` }
  }

  isTurnComplete(raw: object): boolean {
    return (raw as Record<string, unknown>).type === `result`
  }

  translateClientIntent(raw: ClientIntent, user?: User): object {
    if (raw.type === `user_message`) {
      return {
        type: `user`,
        message: {
          role: `user`,
          content: formatPromptForAgent(raw.text, user),
        },
        parent_tool_use_id: null,
        session_id: ``,
      }
    }

    return raw
  }

  async prepareResume(
    history: Array<StreamEnvelope>,
    options: ResumeOptions
  ): Promise<PreparedResume> {
    const fs = await import(`node:fs/promises`)
    const path = await import(`node:path`)
    const canonicalCwd = await canonicalizeCwd(options.cwd)

    let resumeId: string | undefined
    let sourceCwd: string | undefined
    for (const envelope of history) {
      if (envelope.direction === `bridge`) {
        continue
      }

      if (
        envelope.direction === `agent` &&
        (envelope.raw as Record<string, unknown>).type === `system`
      ) {
        const systemMessage = envelope.raw as Record<string, unknown>
        if (
          resumeId === undefined &&
          typeof systemMessage.session_id === `string`
        ) {
          resumeId = systemMessage.session_id
        }

        if (sourceCwd === undefined && typeof systemMessage.cwd === `string`) {
          sourceCwd = systemMessage.cwd
        }
      }
    }

    const finalResumeId = resumeId ?? `resume-${Date.now()}`
    const shouldForceSeedWorkspace =
      sourceCwd !== undefined &&
      (await canonicalizeCwd(sourceCwd)) !== canonicalCwd
    const sourceTranscriptPath =
      resumeId && sourceCwd
        ? getTranscriptPathFromCanonicalCwd(
            await canonicalizeCwd(sourceCwd),
            resumeId
          )
        : undefined
    const expandedRewritePaths = { ...(options.rewritePaths ?? {}) }

    for (const [from, to] of Object.entries(options.rewritePaths ?? {})) {
      const canonicalFrom = await canonicalizeCwd(from)
      const canonicalTo = await canonicalizeCwd(to)
      expandedRewritePaths[canonicalFrom] = canonicalTo
    }

    if (sourceTranscriptPath && resumeId) {
      const targetTranscriptPath = getTranscriptPathFromCanonicalCwd(
        canonicalCwd,
        finalResumeId
      )

      try {
        const originalTranscript = await fs.readFile(
          sourceTranscriptPath,
          `utf8`
        )
        const rewrittenTranscript = rewriteTranscriptText(originalTranscript, {
          rewritePaths: expandedRewritePaths,
          fromSessionId: resumeId,
          toSessionId: finalResumeId,
        })

        await fs.mkdir(path.dirname(targetTranscriptPath), { recursive: true })
        await fs.writeFile(targetTranscriptPath, rewrittenTranscript, `utf8`)

        return {
          resumeId: finalResumeId,
          forceSeedWorkspace: shouldForceSeedWorkspace,
          resumeTranscriptSourcePath: sourceTranscriptPath,
        }
      } catch {
        // Fall back to stream-history reconstruction when the original Claude
        // transcript is unavailable from disk.
      }
    }

    const lines: Array<string> = []
    const writtenResponses = new Set<string | number>()

    for (const envelope of history) {
      if (envelope.direction === `bridge`) {
        continue
      }

      let rawForTranscript = envelope.raw

      if (envelope.direction === `user`) {
        if (envelope.raw.type === `control_response`) {
          const requestId = envelope.raw.response.request_id

          if (writtenResponses.has(requestId)) {
            continue
          }

          writtenResponses.add(requestId)
        }

        if (envelope.raw.type === `user_message`) {
          rawForTranscript = this.translateClientIntent(
            envelope.raw,
            envelope.user
          )
        }
      }

      if (`session_id` in rawForTranscript) {
        ;(rawForTranscript as Record<string, unknown>).session_id =
          finalResumeId
      }

      const serialized = rewriteTranscriptText(
        JSON.stringify(rawForTranscript),
        {
          rewritePaths: expandedRewritePaths,
        }
      )

      lines.push(serialized)
    }

    const projectId = sanitizePathSegment(canonicalCwd)
    const sessionDir = path.join(
      process.env.HOME ?? ``,
      `.claude`,
      `projects`,
      projectId
    )
    await fs.mkdir(sessionDir, { recursive: true })
    await fs.writeFile(
      path.join(sessionDir, `${finalResumeId}.jsonl`),
      `${lines.join(`\n`)}${lines.length > 0 ? `\n` : ``}`,
      `utf8`
    )

    return {
      resumeId: finalResumeId,
      forceSeedWorkspace: shouldForceSeedWorkspace,
      resumeTranscriptSourcePath: sourceTranscriptPath,
    }
  }
}
