import { randomUUID } from "node:crypto"
import {
  DurableStream,
  FetchError,
  IdempotentProducer,
} from "@durable-streams/client"
import type { AgentAdapter } from "./adapters/types.js"
import type {
  AgentEnvelope,
  AgentType,
  BridgeDebugHooks,
  BridgeEnvelope,
  BridgeForwardSource,
  ClientIntent,
  ControlResponseIntent,
  Session,
  StreamEnvelope,
  UserEnvelope,
} from "./types.js"

export interface BridgeOptions {
  adapter: AgentAdapter
  streamUrl: string
  cwd: string
  contentType?: string
  model?: string
  permissionMode?: string
  verbose?: boolean
  rewritePaths?: Record<string, string>
  resume?: boolean
  debugHooks?: BridgeDebugHooks
}

function getStreamSessionId(streamUrl: string): string {
  const slug = new URL(streamUrl).pathname.split(`/`).filter(Boolean).at(-1)
  return slug ?? `default`
}

function createBridgeEnvelope(
  agent: AgentType,
  type: BridgeEnvelope[`type`]
): BridgeEnvelope {
  return {
    agent,
    direction: `bridge`,
    timestamp: Date.now(),
    type,
  }
}

function createAgentEnvelope(agent: AgentType, raw: object): AgentEnvelope {
  return {
    agent,
    direction: `agent`,
    timestamp: Date.now(),
    raw,
  }
}

function isClientIntent(raw: object): raw is ClientIntent {
  const type = (raw as Record<string, unknown>).type
  return (
    type === `user_message` ||
    type === `control_response` ||
    type === `interrupt`
  )
}

async function createOrConnectStream(
  streamUrl: string,
  contentType: string,
  resume: boolean
): Promise<DurableStream> {
  if (resume) {
    return DurableStream.connect({ url: streamUrl, contentType })
  }

  try {
    return await DurableStream.create({ url: streamUrl, contentType })
  } catch (error) {
    if (error instanceof FetchError && error.status === 409) {
      return new DurableStream({ url: streamUrl, contentType })
    }

    throw error
  }
}

export async function startBridge(options: BridgeOptions): Promise<Session> {
  const {
    adapter,
    streamUrl,
    cwd,
    contentType = `application/json`,
    model,
    permissionMode,
    verbose,
    rewritePaths,
    resume = false,
    debugHooks,
  } = options

  const stream = await createOrConnectStream(streamUrl, contentType, resume)
  const historyResponse = await stream.stream<StreamEnvelope>({
    json: true,
    live: false,
  })
  const history = await historyResponse.json()
  const resumeOffset = historyResponse.offset
  const hasHistory = history.length > 0

  if (resume && !hasHistory) {
    throw new Error(`Cannot resume an empty session stream: ${streamUrl}`)
  }

  const shouldResume = resume || hasHistory
  const sessionId = getStreamSessionId(streamUrl)
  const producer = new IdempotentProducer(
    stream,
    `bridge-${sessionId}-${randomUUID()}`,
    {
      autoClaim: true,
    }
  )

  let resumeId: string | undefined
  if (shouldResume && hasHistory) {
    const prepared = await adapter.prepareResume(history, { cwd, rewritePaths })
    resumeId = prepared.resumeId
  }

  let connection
  try {
    connection = await adapter.spawn({
      cwd,
      model,
      permissionMode,
      verbose,
      resume: resumeId,
    })
  } catch (error) {
    await producer.detach()
    throw error
  }

  const pendingAgentRequestIds = new Set<string | number>()
  const promptQueue: Array<object> = []
  const abortController = new AbortController()
  const controlEventType = shouldResume ? `session_resumed` : `session_started`

  let turnInProgress = false
  let sessionEndedWritten = false
  let shutdownPromise: Promise<void> | null = null
  let agentExited = false
  let debugSequence = 0

  const writeJson = (value: object): void => {
    producer.append(JSON.stringify(value))
  }

  const sendToAgent = (raw: object, source: BridgeForwardSource): void => {
    debugHooks?.onForwardToAgent?.({
      sequence: ++debugSequence,
      timestamp: Date.now(),
      source,
      raw,
    })
    connection.send(raw)
  }

  const writeSessionEnded = (): void => {
    if (sessionEndedWritten) {
      return
    }

    sessionEndedWritten = true
    writeJson(createBridgeEnvelope(adapter.agentType, `session_ended`))
  }

  const processQueue = (): void => {
    if (
      turnInProgress ||
      promptQueue.length === 0 ||
      shutdownPromise !== null
    ) {
      return
    }

    turnInProgress = true
    sendToAgent(promptQueue.shift() as object, `queued_prompt`)
  }

  connection.onMessage((raw) => {
    debugHooks?.onAgentMessage?.({
      sequence: ++debugSequence,
      timestamp: Date.now(),
      raw,
    })
    writeJson(createAgentEnvelope(adapter.agentType, raw))

    const classification = adapter.parseDirection(raw)
    if (classification.type === `request` && classification.id != null) {
      pendingAgentRequestIds.add(classification.id)
    }

    if (adapter.isTurnComplete(raw)) {
      turnInProgress = false
      processQueue()
    }
  })

  writeJson(createBridgeEnvelope(adapter.agentType, controlEventType))

  const liveRelayPromise = (async () => {
    try {
      const liveStream = await stream.stream<StreamEnvelope>({
        offset: resumeOffset,
        live: `sse`,
        json: true,
        signal: abortController.signal,
      })

      for await (const item of liveStream.jsonStream()) {
        const envelope = item
        if (
          envelope.direction !== `user` ||
          envelope.agent !== adapter.agentType
        ) {
          continue
        }

        const userEnvelope = envelope as UserEnvelope
        const raw = userEnvelope.raw

        if (!isClientIntent(raw)) {
          continue
        }

        if (raw.type === `user_message`) {
          promptQueue.push(adapter.translateClientIntent(raw))
          processQueue()
          continue
        }

        if (raw.type === `control_response`) {
          const requestId = raw.response.request_id
          if (!pendingAgentRequestIds.has(requestId)) {
            continue
          }

          pendingAgentRequestIds.delete(requestId)
          sendToAgent(adapter.translateClientIntent(raw), `client_response`)
          continue
        }

        for (const requestId of pendingAgentRequestIds) {
          const cancellation: ControlResponseIntent = {
            type: `control_response`,
            response: {
              request_id: requestId,
              subtype: `cancelled`,
              response: {},
            },
          }

          writeJson({
            agent: adapter.agentType,
            direction: `user`,
            timestamp: Date.now(),
            user: userEnvelope.user,
            raw: cancellation,
          } satisfies UserEnvelope)

          sendToAgent(
            adapter.translateClientIntent(cancellation),
            `interrupt_synthesized_response`
          )
        }

        pendingAgentRequestIds.clear()
        sendToAgent(adapter.translateClientIntent(raw), `interrupt`)
      }
    } catch (error) {
      if (
        abortController.signal.aborted ||
        (error as Error).name === `AbortError` ||
        (error as Error).message === `Stream request was aborted`
      ) {
        return
      }

      if ((error as Error).name !== `AbortError`) {
        console.error(`coding-agents bridge relay failed`, error)
      }
    }
  })()

  const shutdown = async (killConnection: boolean): Promise<void> => {
    if (shutdownPromise) {
      return shutdownPromise
    }

    shutdownPromise = (async () => {
      abortController.abort()
      writeSessionEnded()

      if (killConnection && !agentExited) {
        connection.kill()
      }

      await liveRelayPromise
      await producer.flush()
      await producer.detach()
    })()

    return shutdownPromise
  }

  connection.on(`exit`, () => {
    agentExited = true
    void shutdown(false)
  })

  return {
    sessionId,
    streamUrl,
    close() {
      return shutdown(true)
    },
  }
}
