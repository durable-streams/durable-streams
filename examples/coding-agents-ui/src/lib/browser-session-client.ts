import { DurableStream } from "@durable-streams/client"
import type {
  AgentType,
  ClientIntent,
  ControlResponseIntent,
  StreamEnvelope,
  User,
  UserEnvelope,
} from "@durable-streams/coding-agents"

export interface BrowserSessionClient {
  prompt: (text: string) => void
  respond: (requestId: string | number, response: object) => void
  cancelApproval: (requestId: string | number) => void
  interrupt: () => void
  close: () => Promise<void>
}

export function createBrowserSessionClient(options: {
  agent: AgentType
  streamUrl: string
  user: User
}): BrowserSessionClient {
  const absoluteUrl = new URL(
    options.streamUrl,
    window.location.href
  ).toString()
  const stream = new DurableStream({
    url: absoluteUrl,
    contentType: `application/json`,
  })

  const appendEnvelope = (raw: ClientIntent): void => {
    void stream.append(
      JSON.stringify({
        agent: options.agent,
        direction: `user`,
        timestamp: Date.now(),
        user: options.user,
        raw,
      } satisfies UserEnvelope)
    )
  }

  return {
    prompt(text) {
      appendEnvelope({
        type: `user_message`,
        text,
      })
    },

    respond(requestId, response) {
      appendEnvelope({
        type: `control_response`,
        response: {
          request_id: requestId,
          subtype: `success`,
          response,
        },
      } satisfies ControlResponseIntent)
    },

    cancelApproval(requestId) {
      appendEnvelope({
        type: `control_response`,
        response: {
          request_id: requestId,
          subtype: `cancelled`,
          response: {},
        },
      } satisfies ControlResponseIntent)
    },

    interrupt() {
      appendEnvelope({ type: `interrupt` })
    },

    async close() {},
  }
}

export async function streamSessionHistory(options: {
  streamUrl: string
  onEnvelope: (envelope: StreamEnvelope) => void
  signal: AbortSignal
}): Promise<void> {
  const absoluteUrl = new URL(
    options.streamUrl,
    window.location.href
  ).toString()
  const stream = new DurableStream({
    url: absoluteUrl,
    contentType: `application/json`,
  })
  const response = await stream.stream<StreamEnvelope>({
    json: true,
    live: `sse`,
    signal: options.signal,
  })

  for await (const item of response.jsonStream()) {
    options.onEnvelope(item)
  }
}
