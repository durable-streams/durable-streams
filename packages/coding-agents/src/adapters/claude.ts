import { spawn } from "node:child_process"
import { basename } from "node:path"
import { WebSocketServer } from "ws"
import type WebSocket from "ws"
import type {
  AgentAdapter,
  AgentConnection,
  MessageClassification,
  ResumeOptions,
  SpawnOptions,
} from "./types.js"
import type { ClientIntent, StreamEnvelope } from "../types.js"

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, `-`) || `project`
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

export class ClaudeAdapter implements AgentAdapter {
  readonly agentType = `claude` as const

  async spawn(options: SpawnOptions): Promise<AgentConnection> {
    const port = await findFreePort()
    const sessionId = options.resume ?? `session-${Date.now()}`
    const sdkUrl = `ws://127.0.0.1:${port}/ws/cli/${sessionId}`

    return await new Promise<AgentConnection>((resolve, reject) => {
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

      if (options.verbose) {
        args.push(`--verbose`)
      }

      if (options.resume) {
        args.push(`--resume`, options.resume)
      }

      args.push(`-p`, ``)

      const child = spawn(`claude`, args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: [`ignore`, `pipe`, `pipe`],
      })

      const wss = new WebSocketServer({ host: `127.0.0.1`, port })
      const timeout = setTimeout(() => {
        safeClose()
        child.kill()
        reject(new Error(`Claude Code did not connect to the bridge in 30s`))
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

  translateClientIntent(raw: ClientIntent): object {
    if (raw.type === `user_message`) {
      return {
        type: `user`,
        message: {
          role: `user`,
          content: raw.text,
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
  ): Promise<{ resumeId: string }> {
    const fs = await import(`node:fs/promises`)
    const os = await import(`node:os`)
    const path = await import(`node:path`)

    let resumeId: string | undefined
    const respondedRequestIds = new Set<string | number>()
    const lines: Array<string> = []

    for (const envelope of history) {
      if (envelope.direction === `bridge`) {
        continue
      }

      if (
        envelope.direction === `agent` &&
        resumeId === undefined &&
        (envelope.raw as Record<string, unknown>).type === `system`
      ) {
        const systemMessage = envelope.raw as Record<string, unknown>
        if (typeof systemMessage.session_id === `string`) {
          resumeId = systemMessage.session_id
        }
      }

      if (envelope.direction === `user`) {
        const raw = envelope.raw
        if (raw.type === `control_response`) {
          const requestId = raw.response.request_id

          if (respondedRequestIds.has(requestId)) {
            continue
          }
          respondedRequestIds.add(requestId)
        }
      }

      let serialized = JSON.stringify(envelope.raw)

      if (options.rewritePaths) {
        for (const [from, to] of Object.entries(options.rewritePaths)) {
          serialized = serialized.replaceAll(from, to)
        }
      }

      lines.push(serialized)
    }

    const finalResumeId = resumeId ?? `resume-${Date.now()}`
    const projectId = sanitizePathSegment(basename(options.cwd))
    const sessionDir = path.join(os.homedir(), `.claude`, `projects`, projectId)
    await fs.mkdir(sessionDir, { recursive: true })
    await fs.writeFile(
      path.join(sessionDir, `${finalResumeId}.jsonl`),
      `${lines.join(`\n`)}${lines.length > 0 ? `\n` : ``}`,
      `utf8`
    )

    return { resumeId: finalResumeId }
  }
}
