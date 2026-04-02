import type { AssistantMessageEvent, NormalizedEvent } from "./types.js"

const SKIP_TYPES = new Set([
  `keep_alive`,
  `user`,
  `rate_limit_event`,
  `streamlined_text`,
  `streamlined_tool_use_summary`,
])

function normalizeAssistantBlock(
  block: Record<string, unknown>
): AssistantMessageEvent[`content`][number] {
  const blockType = block.type as string | undefined

  if (blockType === `thinking`) {
    return {
      type: `thinking`,
      text: (block.thinking as string | undefined) ?? ``,
    }
  }

  if (blockType === `tool_use`) {
    return {
      type: `tool_use`,
      id: String(block.id ?? ``),
      name: String(block.name ?? ``),
      input: (block.input as object | undefined) ?? {},
    }
  }

  if (blockType === `tool_result`) {
    const content = block.content
    let output = ``

    if (typeof content === `string`) {
      output = content
    } else if (Array.isArray(content)) {
      output = content
        .map((part) => {
          if (
            part &&
            typeof part === `object` &&
            `text` in part &&
            typeof part.text === `string`
          ) {
            return part.text
          }
          return JSON.stringify(part)
        })
        .join(``)
    } else if (content != null) {
      output = JSON.stringify(content)
    }

    return {
      type: `tool_result`,
      toolUseId: String(block.tool_use_id ?? ``),
      output,
      isError: block.is_error === true,
    }
  }

  return {
    type: `text`,
    text: (block.text as string | undefined) ?? ``,
  }
}

export function normalizeClaude(raw: object): NormalizedEvent | null {
  const message = raw as Record<string, unknown>
  const type = message.type as string | undefined

  if (!type || SKIP_TYPES.has(type)) {
    return null
  }

  switch (type) {
    case `system`:
      return {
        type: `session_init`,
        sessionId: message.session_id as string | undefined,
        model: message.model as string | undefined,
        permissionMode: message.permission_mode as string | undefined,
      }

    case `assistant`: {
      const assistant = message.message as Record<string, unknown> | undefined
      const content =
        (assistant?.content as Array<Record<string, unknown>> | undefined) ?? []

      return {
        type: `assistant_message`,
        content: content.map((block) => normalizeAssistantBlock(block)),
      }
    }

    case `stream_event`: {
      const event = message.event as Record<string, unknown> | undefined
      if (!event) {
        return { type: `unknown`, rawType: type, raw }
      }

      if (event.type === `content_block_delta`) {
        const delta = event.delta as Record<string, unknown> | undefined
        const deltaType = delta?.type as string | undefined

        if (deltaType === `text_delta`) {
          return {
            type: `stream_delta`,
            delta: {
              kind: `text`,
              text: (delta?.text as string | undefined) ?? ``,
            },
          }
        }

        if (deltaType === `thinking_delta`) {
          return {
            type: `stream_delta`,
            delta: {
              kind: `thinking`,
              text: (delta?.thinking as string | undefined) ?? ``,
            },
          }
        }

        if (deltaType === `input_json_delta`) {
          return {
            type: `stream_delta`,
            delta: {
              kind: `tool_input`,
              text: (delta?.partial_json as string | undefined) ?? ``,
            },
          }
        }
      }

      return null
    }

    case `control_request`: {
      const request = message.request as Record<string, unknown> | undefined
      if (request?.subtype === `can_use_tool`) {
        return {
          type: `permission_request`,
          id: String(message.request_id ?? ``),
          tool: String(request.tool_name ?? ``),
          input: (request.input as object | undefined) ?? {},
        }
      }

      return {
        type: `unknown`,
        rawType: `control_request:${String(request?.subtype ?? `unknown`)}`,
        raw,
      }
    }

    case `result`: {
      const usage = message.usage as Record<string, number> | undefined
      const subtype = message.subtype as string | undefined
      const event: NormalizedEvent = {
        type: `turn_complete`,
        success: subtype === `success`,
      }

      if (usage || message.cost_usd != null) {
        event.cost = {
          inputTokens: usage?.input_tokens,
          outputTokens: usage?.output_tokens,
          totalCost:
            typeof message.cost_usd === `number` ? message.cost_usd : undefined,
        }
      }

      return event
    }

    case `tool_progress`:
      return {
        type: `tool_progress`,
        toolUseId: String(message.tool_use_id ?? ``),
        elapsed:
          typeof message.elapsed === `number` ? message.elapsed : Number.NaN,
      }

    case `status`:
    case `status_change`:
      return {
        type: `status_change`,
        status: String(message.status ?? message.subtype ?? ``),
      }

    default:
      return { type: `unknown`, rawType: type, raw }
  }
}
