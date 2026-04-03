import { spawn } from "node:child_process"
import type {
  AgentAdapter,
  AgentConnection,
  MessageClassification,
  ResumeOptions,
  SpawnOptions,
} from "./types.js"
import type { ClientIntent, StreamEnvelope } from "../types.js"
import type {
  CodexApprovalPolicy,
  CodexSandboxMode,
} from "../protocol/codex.js"

function parseJsonLines(
  chunk: Buffer,
  currentBuffer: string,
  onMessage: (raw: object) => void
): string {
  let buffer = currentBuffer + chunk.toString(`utf8`)
  const lines = buffer.split(`\n`)
  buffer = lines.pop() ?? ``

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }

    try {
      onMessage(JSON.parse(trimmed) as object)
    } catch {
      // Ignore partial or malformed lines.
    }
  }

  return buffer
}

function isResponseMessage(
  raw: Record<string, unknown>
): raw is Record<string, unknown> & { id: string | number } {
  return (
    raw.id != null && !(`method` in raw) && (`result` in raw || `error` in raw)
  )
}

function extractThreadId(raw: object): string | null {
  const message = raw as Record<string, unknown>

  const params = message.params as Record<string, unknown> | undefined
  const notificationThread =
    (params?.thread as Record<string, unknown> | undefined)?.id ??
    params?.threadId
  if (typeof notificationThread === `string`) {
    return notificationThread
  }

  const result = message.result as Record<string, unknown> | undefined
  const responseThread =
    (result?.thread as Record<string, unknown> | undefined)?.id ??
    result?.threadId
  if (typeof responseThread === `string`) {
    return responseThread
  }

  return null
}

function extractTurnId(raw: object): string | null {
  const message = raw as Record<string, unknown>

  const params = message.params as Record<string, unknown> | undefined
  const notificationTurn =
    (params?.turn as Record<string, unknown> | undefined)?.id ?? params?.turnId
  if (typeof notificationTurn === `string`) {
    return notificationTurn
  }

  const result = message.result as Record<string, unknown> | undefined
  const responseTurn =
    (result?.turn as Record<string, unknown> | undefined)?.id ?? result?.turnId
  if (typeof responseTurn === `string`) {
    return responseTurn
  }

  return null
}

function mapApprovalPolicy(
  permissionMode: string | undefined
): `untrusted` | `on-failure` | `on-request` | `never` | undefined {
  switch (permissionMode) {
    case `untrusted`:
      return `untrusted`
    case `on-failure`:
    case `onFailure`:
      return `on-failure`
    case `on-request`:
    case `onRequest`:
      return `on-request`
    case `never`:
      return `never`
    case `plan`:
      return `never`
    case `auto`:
    case `default`:
    case `acceptEdits`:
    case `bypassPermissions`:
    case `dontAsk`:
      return `on-request`
    default:
      return undefined
  }
}

function resolveApprovalPolicy(
  permissionMode: string | undefined,
  explicitApprovalPolicy: CodexApprovalPolicy | undefined
): CodexApprovalPolicy | undefined {
  return explicitApprovalPolicy ?? mapApprovalPolicy(permissionMode)
}

function resolveSandboxMode(
  sandboxMode: CodexSandboxMode | undefined
): CodexSandboxMode | null {
  return sandboxMode ?? null
}

function requiresExperimentalApi(
  approvalPolicy: CodexApprovalPolicy | undefined,
  experimentalFeatures: Record<string, boolean> | undefined
): boolean {
  return (
    (typeof approvalPolicy === `object` && `granular` in approvalPolicy) ||
    Boolean(
      experimentalFeatures && Object.keys(experimentalFeatures).length > 0
    )
  )
}

function mapCommandDecision(
  response: object,
  subtype: `success` | `cancelled`
):
  | `accept`
  | `acceptForSession`
  | `decline`
  | `cancel`
  | Record<string, unknown> {
  if (subtype === `cancelled`) {
    return `cancel`
  }

  const value = response as Record<string, unknown>
  if (typeof value.decision === `string`) {
    return value.decision as
      | `accept`
      | `acceptForSession`
      | `decline`
      | `cancel`
  }

  switch (value.behavior) {
    case `allow`:
      return `accept`
    case `allow_for_session`:
    case `allowForSession`:
      return `acceptForSession`
    case `deny`:
      return `decline`
    case `cancel`:
      return `cancel`
    default:
      return `accept`
  }
}

function mapFileDecision(
  response: object,
  subtype: `success` | `cancelled`
): `accept` | `acceptForSession` | `decline` | `cancel` {
  if (subtype === `cancelled`) {
    return `cancel`
  }

  const value = response as Record<string, unknown>
  if (typeof value.decision === `string`) {
    return value.decision as
      | `accept`
      | `acceptForSession`
      | `decline`
      | `cancel`
  }

  switch (value.behavior) {
    case `allow_for_session`:
    case `allowForSession`:
      return `acceptForSession`
    case `deny`:
      return `decline`
    case `cancel`:
      return `cancel`
    case `allow`:
    default:
      return `accept`
  }
}

export class CodexAdapter implements AgentAdapter {
  readonly agentType = `codex` as const

  #nextRequestId = 1
  #currentThreadId: string | null = null
  #currentTurnId: string | null = null
  #lastTurnId: string | null = null
  #pendingServerRequests = new Map<string | number, string>()

  async spawn(options: SpawnOptions): Promise<AgentConnection> {
    this.#currentThreadId = options.resume ?? null
    this.#currentTurnId = null
    this.#lastTurnId = null
    this.#pendingServerRequests.clear()

    const featureArgs = Object.entries(
      options.experimentalFeatures ?? {}
    ).flatMap(([name, enabled]) =>
      enabled ? [`--enable`, name] : [`--disable`, name]
    )

    return await new Promise<AgentConnection>((resolve, reject) => {
      const child = spawn(
        `codex`,
        [`app-server`, `--listen`, `stdio://`, ...featureArgs],
        {
          cwd: options.cwd,
          env: { ...process.env, ...options.env },
          stdio: [`pipe`, `pipe`, `pipe`],
        }
      )

      let resolved = false
      let buffer = ``
      let messageHandler: ((raw: object) => void) | null = null
      let exitHandler: ((code: number | null) => void) | null = null
      const pendingResponses = new Map<
        string | number,
        {
          resolve: (raw: object) => void
          reject: (error: Error) => void
        }
      >()
      const bufferedMessages: Array<object> = []

      const emit = (raw: object): void => {
        if (!messageHandler) {
          bufferedMessages.push(raw)
          return
        }

        messageHandler(raw)
      }

      const rejectPending = (error: Error): void => {
        for (const pending of pendingResponses.values()) {
          pending.reject(error)
        }
        pendingResponses.clear()
      }

      const writeJson = (raw: object): void => {
        if (!child.stdin.writable) {
          throw new Error(`Codex app-server stdin is not writable`)
        }

        child.stdin.write(`${JSON.stringify(raw)}\n`)
      }

      const sendRequest = (method: string, params: object): Promise<object> => {
        const id = `client-${this.#nextRequestId++}`

        return awaitResponse(id, () => {
          writeJson({
            jsonrpc: `2.0`,
            id,
            method,
            params,
          })
        })
      }

      const awaitResponse = (
        id: string | number,
        send: () => void
      ): Promise<object> =>
        new Promise((resolveRequest, rejectRequest) => {
          pendingResponses.set(id, {
            resolve: resolveRequest,
            reject: rejectRequest,
          })

          try {
            send()
          } catch (error) {
            pendingResponses.delete(id)
            rejectRequest(error as Error)
          }
        })

      child.once(`error`, (error) => {
        rejectPending(error)

        if (!resolved) {
          reject(error)
          return
        }

        exitHandler?.(null)
      })

      child.once(`exit`, (code) => {
        rejectPending(new Error(`Codex app-server exited`))
        exitHandler?.(code)
      })

      child.stdout.on(`data`, (chunk: Buffer) => {
        buffer = parseJsonLines(chunk, buffer, (raw) => {
          const message = raw as Record<string, unknown>
          const method =
            typeof message.method === `string` ? message.method : undefined

          if (method === `thread/started`) {
            this.#currentThreadId = extractThreadId(raw)
          }

          if (method === `turn/started`) {
            this.#currentTurnId = extractTurnId(raw)
            this.#lastTurnId = this.#currentTurnId
          }

          if (method === `turn/completed`) {
            this.#lastTurnId = extractTurnId(raw) ?? this.#lastTurnId
            this.#currentTurnId = null
          }

          if (method === `serverRequest/resolved`) {
            const params = message.params as Record<string, unknown> | undefined
            const requestId = params?.requestId
            if (
              typeof requestId === `string` ||
              typeof requestId === `number`
            ) {
              this.#pendingServerRequests.delete(requestId)
            }
          }

          if (method && message.id != null) {
            this.#pendingServerRequests.set(
              message.id as string | number,
              method
            )
          }

          if (isResponseMessage(message)) {
            const pending = pendingResponses.get(message.id)
            if (pending) {
              pendingResponses.delete(message.id)

              if (`error` in message) {
                const errorPayload =
                  (message.error as Record<string, unknown> | undefined)
                    ?.message ?? `Codex app-server request failed`
                pending.reject(new Error(String(errorPayload)))
              } else {
                const threadId = extractThreadId(raw)
                if (threadId) {
                  this.#currentThreadId = threadId
                }

                pending.resolve(raw)
              }
            }
          }

          emit(raw)
        })
      })

      const connection: AgentConnection = {
        onMessage(handler) {
          messageHandler = handler
          for (const raw of bufferedMessages.splice(0)) {
            handler(raw)
          }
        },
        send(raw) {
          writeJson(raw)
        },
        kill() {
          child.kill()
        },
        on(_event, handler) {
          exitHandler = handler
        },
      }

      void (async () => {
        try {
          const explicitApprovalPolicy = resolveApprovalPolicy(
            options.permissionMode,
            options.approvalPolicy
          )

          await sendRequest(`initialize`, {
            clientInfo: {
              name: `durable-streams-coding-agents`,
              title: `Durable Streams Coding Agents`,
              version: `0.1.0`,
            },
            capabilities: requiresExperimentalApi(
              explicitApprovalPolicy,
              options.experimentalFeatures
            )
              ? {
                  experimentalApi: true,
                }
              : null,
          })

          const baseParams = {
            model: options.model ?? null,
            cwd: options.cwd,
            approvalPolicy: explicitApprovalPolicy,
            sandbox: resolveSandboxMode(options.sandboxMode),
            developerInstructions: options.developerInstructions ?? null,
            persistExtendedHistory: false,
          }

          if (options.resume) {
            await sendRequest(`thread/resume`, {
              ...baseParams,
              threadId: options.resume,
            })
          } else {
            await sendRequest(`thread/start`, {
              ...baseParams,
              ephemeral: false,
              experimentalRawEvents: false,
            })
          }

          resolved = true
          resolve(connection)
        } catch (error) {
          child.kill()
          reject(error)
        }
      })()
    })
  }

  parseDirection(raw: object): MessageClassification {
    const message = raw as Record<string, unknown>
    const method =
      typeof message.method === `string` ? message.method : undefined

    if (method && message.id != null) {
      this.#pendingServerRequests.set(message.id as string | number, method)
      return { type: `request`, id: message.id as string | number }
    }

    if (
      message.id != null &&
      !method &&
      (`result` in message || `error` in message)
    ) {
      return { type: `response`, id: message.id as string | number }
    }

    return { type: `notification` }
  }

  isTurnComplete(raw: object): boolean {
    const message = raw as Record<string, unknown>
    return message.method === `turn/completed`
  }

  translateClientIntent(raw: ClientIntent): object {
    if (raw.type === `user_message`) {
      return {
        jsonrpc: `2.0`,
        id: `client-${this.#nextRequestId++}`,
        method: `turn/start`,
        params: {
          threadId: this.#currentThreadId ?? ``,
          input: [
            {
              type: `text`,
              text: raw.text,
              text_elements: [],
            },
          ],
        },
      }
    }

    if (raw.type === `control_response`) {
      const requestId = raw.response.request_id
      const requestMethod = this.#pendingServerRequests.get(requestId)
      this.#pendingServerRequests.delete(requestId)

      if (requestMethod === `item/commandExecution/requestApproval`) {
        return {
          jsonrpc: `2.0`,
          id: requestId,
          result: {
            decision: mapCommandDecision(
              raw.response.response,
              raw.response.subtype
            ),
          },
        }
      }

      if (requestMethod === `item/fileChange/requestApproval`) {
        return {
          jsonrpc: `2.0`,
          id: requestId,
          result: {
            decision: mapFileDecision(
              raw.response.response,
              raw.response.subtype
            ),
          },
        }
      }

      if (requestMethod === `item/permissions/requestApproval`) {
        const response = raw.response.response as Record<string, unknown>
        return {
          jsonrpc: `2.0`,
          id: requestId,
          result: {
            permissions: (response.permissions as object | undefined) ?? {},
            scope:
              (response.scope as string | undefined) === `session`
                ? `session`
                : `turn`,
          },
        }
      }

      if (requestMethod === `item/tool/requestUserInput`) {
        const response = raw.response.response as Record<string, unknown>
        return {
          jsonrpc: `2.0`,
          id: requestId,
          result: {
            answers:
              (response.answers as Record<string, unknown> | undefined) ?? {},
          },
        }
      }

      if (requestMethod === `item/tool/call`) {
        const response = raw.response.response as Record<string, unknown>
        return {
          jsonrpc: `2.0`,
          id: requestId,
          result: {
            contentItems:
              (response.contentItems as Array<object> | undefined) ?? [],
            success:
              typeof response.success === `boolean` ? response.success : true,
          },
        }
      }

      return {
        jsonrpc: `2.0`,
        id: requestId,
        result: raw.response.response,
      }
    }

    return {
      jsonrpc: `2.0`,
      id: `client-${this.#nextRequestId++}`,
      method: `turn/interrupt`,
      params: {
        threadId: this.#currentThreadId ?? ``,
        turnId: this.#currentTurnId ?? this.#lastTurnId ?? ``,
      },
    }
  }

  prepareResume(
    history: Array<StreamEnvelope>,
    _options: ResumeOptions
  ): Promise<{ resumeId: string }> {
    for (const envelope of [...history].reverse()) {
      if (envelope.direction !== `agent`) {
        continue
      }

      const threadId = extractThreadId(envelope.raw)
      if (threadId) {
        return Promise.resolve({ resumeId: threadId })
      }
    }

    throw new Error(`Could not find a Codex thread id in stream history`)
  }
}
