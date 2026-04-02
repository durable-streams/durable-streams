import { DurableStream, IdempotentProducer } from "@durable-streams/client"
import { normalizeClaude } from "./normalize/claude.js"
import { normalizeCodex } from "./normalize/codex.js"
import type {
  AgentEnvelope,
  ClientEvent,
  ClientIntent,
  ClientOptions,
  NormalizedAgentStreamEvent,
  StreamClient,
  StreamEnvelope,
  UserEnvelope,
} from "./types.js"

function normalizeAgentEnvelope(
  envelope: AgentEnvelope
): NormalizedAgentStreamEvent | null {
  const normalizer =
    envelope.agent === `claude` ? normalizeClaude : normalizeCodex
  const event = normalizer(envelope.raw)

  if (!event) {
    return null
  }

  return {
    direction: `agent`,
    envelope,
    event,
  }
}

export function createClient(options: ClientOptions): StreamClient {
  const { agent, streamUrl, user, contentType = `application/json` } = options

  const stream = new DurableStream({ url: streamUrl, contentType })
  const producer = new IdempotentProducer(
    stream,
    `client-${crypto.randomUUID()}`,
    {
      autoClaim: true,
    }
  )

  const writeIntent = (raw: ClientIntent): void => {
    producer.append(
      JSON.stringify({
        agent,
        direction: `user`,
        timestamp: Date.now(),
        user,
        raw,
      } satisfies UserEnvelope)
    )
  }

  return {
    prompt(text) {
      writeIntent({ type: `user_message`, text })
    },

    respond(requestId, response) {
      writeIntent({
        type: `control_response`,
        response: {
          request_id: requestId,
          subtype: `success`,
          response,
        },
      })
    },

    cancel() {
      writeIntent({ type: `interrupt` })
    },

    async *events(): AsyncIterable<ClientEvent> {
      const response = await stream.stream<StreamEnvelope>({
        live: `sse`,
        json: true,
      })

      for await (const item of response.jsonStream()) {
        const envelope = item

        if (envelope.direction === `agent`) {
          const normalized = normalizeAgentEnvelope(envelope)
          if (normalized) {
            yield normalized
          }
          continue
        }

        if (envelope.direction === `bridge`) {
          yield envelope
          continue
        }

        yield envelope as UserEnvelope
      }
    },

    async close() {
      await producer.flush()
      await producer.detach()
    },
  }
}

export { normalizeClaude } from "./normalize/claude.js"
export { normalizeCodex } from "./normalize/codex.js"
export type {
  AssistantMessageEvent,
  NormalizedEvent,
  PermissionRequestEvent,
  SessionInitEvent,
  StatusChangeEvent,
  StreamDeltaEvent,
  TextContent,
  ThinkingContent,
  ToolCallEvent,
  ToolProgressEvent,
  ToolResultContent,
  ToolResultEvent,
  ToolUseContent,
  TurnCompleteEvent,
  UnknownEvent,
} from "./normalize/types.js"
export type {
  ClientEvent,
  ClientOptions,
  NormalizedAgentStreamEvent,
  StreamClient,
} from "./types.js"
