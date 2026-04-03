import type { NormalizedEvent } from "./types.js"

function coerceText(value: unknown): string {
  if (typeof value === `string`) {
    return value
  }

  if (Array.isArray(value)) {
    return value
      .map((part) => (typeof part === `string` ? part : JSON.stringify(part)))
      .join(`\n`)
  }

  return ``
}

function normalizeItem(
  item: Record<string, unknown>,
  raw: object
): NormalizedEvent | null {
  const itemType = item.type as string | undefined

  switch (itemType) {
    case `userMessage`:
    case `user_message`:
      return null

    case `agentMessage`:
    case `agent_message`:
      return {
        type: `assistant_message`,
        content: [
          {
            type: `text`,
            text: coerceText(item.text ?? item.content),
          },
        ],
      }

    case `reasoning`:
      return {
        type: `assistant_message`,
        content: [
          {
            type: `thinking`,
            text: coerceText(item.content) || coerceText(item.summary),
          },
        ],
      }

    case `commandExecution`:
    case `command_execution`:
      return {
        type: `tool_call`,
        id: String(item.id ?? ``),
        tool: `terminal`,
        input: {
          command: item.command as string | undefined,
        },
      }

    case `fileChange`:
    case `file_change`: {
      const changes = (item.changes as Array<object> | undefined) ?? []
      if (changes.length === 0) {
        return {
          type: `tool_call`,
          id: String(item.id ?? ``),
          tool: `file_edit`,
          input: {
            path: item.path as string | undefined,
            diff: item.diff as string | undefined,
          },
        }
      }

      return {
        type: `tool_call`,
        id: String(item.id ?? ``),
        tool: `file_edit`,
        input: { changes },
      }
    }

    case `mcpToolCall`:
      return {
        type: `tool_call`,
        id: String(item.id ?? ``),
        tool:
          (item.tool as string | undefined) ??
          (item.name as string | undefined) ??
          ``,
        input: (item.arguments as object | undefined) ?? {},
      }

    case `dynamicToolCall`:
      return {
        type: `tool_call`,
        id: String(item.id ?? ``),
        tool: String(item.tool ?? ``),
        input: (item.arguments as object | undefined) ?? {},
      }

    default:
      return {
        type: `unknown`,
        rawType: `item:${String(itemType ?? `unknown`)}`,
        raw,
      }
  }
}

export function normalizeCodex(raw: object): NormalizedEvent | null {
  const message = raw as Record<string, unknown>
  const method = message.method as string | undefined

  if (method === `thread/started`) {
    const params = message.params as Record<string, unknown> | undefined
    const thread = params?.thread as Record<string, unknown> | undefined
    return {
      type: `session_init`,
      sessionId: thread?.id as string | undefined,
    }
  }

  if (method === `item/agentMessage/delta`) {
    const params = message.params as Record<string, unknown> | undefined
    return {
      type: `stream_delta`,
      delta: {
        kind: `text`,
        text: (params?.delta as string | undefined) ?? ``,
      },
    }
  }

  if (
    method === `item/reasoning/textDelta` ||
    method === `item/reasoning/summaryTextDelta`
  ) {
    const params = message.params as Record<string, unknown> | undefined
    return {
      type: `stream_delta`,
      delta: {
        kind: `thinking`,
        text: (params?.delta as string | undefined) ?? ``,
      },
    }
  }

  if (method === `item/completed`) {
    const params = message.params as Record<string, unknown> | undefined
    const item = params?.item as Record<string, unknown> | undefined
    return normalizeItem(item ?? {}, raw)
  }

  if (
    method === `mcpServer/startupStatus/updated` ||
    method === `turn/started` ||
    method === `item/started` ||
    method === `account/rateLimits/updated` ||
    method === `thread/tokenUsage/updated` ||
    method === `serverRequest/resolved`
  ) {
    return null
  }

  if (method === `thread/status/changed`) {
    const params = message.params as Record<string, unknown> | undefined
    const status = params?.status

    if (typeof status === `string`) {
      return {
        type: `status_change`,
        status,
      }
    }

    if (status && typeof status === `object`) {
      const statusType = (status as Record<string, unknown>).type
      if (typeof statusType === `string`) {
        return {
          type: `status_change`,
          status: statusType,
        }
      }
    }

    return null
  }

  if (method === `turn/completed`) {
    const params = message.params as Record<string, unknown> | undefined
    const turn = params?.turn as Record<string, unknown> | undefined
    return {
      type: `turn_complete`,
      success: (turn?.status as string | undefined) === `completed`,
    }
  }

  if (method === `item/commandExecution/requestApproval`) {
    const params = message.params as Record<string, unknown> | undefined
    return {
      type: `permission_request`,
      id: (message.id as string | number | undefined) ?? ``,
      tool: `terminal`,
      input: {
        command: params?.command as string | undefined,
        cwd: params?.cwd as string | undefined,
      },
    }
  }

  if (method === `item/fileChange/requestApproval`) {
    const params = message.params as Record<string, unknown> | undefined
    return {
      type: `permission_request`,
      id: (message.id as string | number | undefined) ?? ``,
      tool: `file_change`,
      input: {
        reason: params?.reason as string | undefined,
        grantRoot: params?.grantRoot as string | undefined,
      },
    }
  }

  if (method === `item/permissions/requestApproval`) {
    const params = message.params as Record<string, unknown> | undefined
    return {
      type: `permission_request`,
      id: (message.id as string | number | undefined) ?? ``,
      tool: `permissions`,
      input: (params?.permissions as object | undefined) ?? {},
    }
  }

  if (method === `item/tool/requestUserInput`) {
    const params = message.params as Record<string, unknown> | undefined
    const rawQuestions = params?.questions
    const questions = Array.isArray(rawQuestions)
      ? (rawQuestions as Array<Record<string, unknown>>)
      : []
    return {
      type: `permission_request`,
      id: (message.id as string | number | undefined) ?? ``,
      tool: `request_user_input`,
      input: {
        questions,
        question:
          (questions[0]?.question as string | undefined) ??
          (questions[0]?.prompt as string | undefined) ??
          (params?.question as string | undefined),
      },
    }
  }

  if (
    message.id != null &&
    !(`method` in message) &&
    `result` in message &&
    !(`error` in message)
  ) {
    const result = message.result as Record<string, unknown> | undefined
    if (typeof result?.success === `boolean`) {
      return { type: `turn_complete`, success: result.success }
    }

    return null
  }

  if (message.id != null && !(`method` in message) && `error` in message) {
    return { type: `turn_complete`, success: false }
  }

  if (message.type === `approval_request`) {
    return {
      type: `permission_request`,
      id: (message.id as string | number | undefined) ?? ``,
      tool: String(message.tool_name ?? ``),
      input: (message.tool_input as object | undefined) ?? {},
    }
  }

  if (message.type === `item`) {
    const item = message.item as Record<string, unknown> | undefined
    return normalizeItem(item ?? {}, raw)
  }

  const type = message.type as string | undefined
  return {
    type: `unknown`,
    rawType: method ?? type ?? `no_type`,
    raw,
  }
}
