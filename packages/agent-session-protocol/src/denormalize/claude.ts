import { randomUUID } from "node:crypto"
import { denormalizeToolName } from "../tools.js"
import type { DenormalizeOptions, NormalizedEvent } from "../types.js"

function transformInputForClaude(
  claudeTool: string,
  input: Record<string, unknown>
): Record<string, unknown> {
  if (claudeTool === `Read` && !input.file_path) {
    const cmd = (input.cmd as string) ?? (input.command as string) ?? ``
    const catMatch = cmd.match(/^(?:cat|head|tail|nl)\s+(.+)$/)
    if (catMatch) {
      return { file_path: catMatch[1]!.trim() }
    }
  }

  if (claudeTool === `Bash` && !input.command) {
    if (typeof input.cmd === `string`) {
      return { command: input.cmd, ...input }
    }
  }

  if (claudeTool === `Grep` && !input.pattern) {
    const cmd = (input.cmd as string) ?? ``
    const rgMatch = cmd.match(
      /^(?:rg|grep)\s+(?:-\S+\s+)*"?([^"]+)"?\s+(.+)$/
    )
    if (rgMatch) {
      return { pattern: rgMatch[1]!, path: rgMatch[2]!.trim() }
    }
  }

  if (claudeTool === `Glob` && !input.pattern) {
    const cmd = (input.cmd as string) ?? ``
    const findMatch = cmd.match(
      /^(?:find|fd)\s+(\S+)\s+.*-name\s+"?([^"]+)"?/
    )
    if (findMatch) {
      return { pattern: findMatch[2]!, path: findMatch[1]! }
    }
  }

  return input
}

function describeToolCall(
  normalizedTool: string,
  input: Record<string, unknown>
): string {
  if (normalizedTool === `file_edit` || normalizedTool === `file_write`) {
    const raw = typeof input.raw === `string` ? input.raw : ``
    const pathMatch = raw.match(/\*\*\* (?:Update|Add) File:\s*(\S+)/)
    const path = pathMatch ? pathMatch[1] : `file`
    return `echo "Applied edit to ${path}"`
  }

  if (input.cmd) return String(input.cmd)
  if (input.command) return String(input.command)
  if (input.file_path) return `cat ${String(input.file_path)}`
  return `echo "${normalizedTool}"`
}

function makeMsgId(): string {
  return `msg_01${randomUUID().replace(/-/g, ``).slice(0, 20)}`
}

function makeReqId(): string {
  return `req_01${randomUUID().replace(/-/g, ``).slice(0, 20)}`
}

function makeToolId(): string {
  return `toolu_01${randomUUID().replace(/-/g, ``).slice(0, 20)}`
}

interface ClaudeContentBlock {
  type: string
  [key: string]: unknown
}

interface PendingAssistant {
  content: Array<ClaudeContentBlock>
  ts: number
}

function toIso(ts: number): string {
  return new Date(ts).toISOString()
}

function createBaseFields(
  sessionId: string,
  cwd: string,
  ts: number,
  parentUuid: string | null,
  gitBranch?: string
): { fields: Record<string, unknown>; uuid: string } {
  const uuid = randomUUID()
  return {
    uuid,
    fields: {
      parentUuid,
      uuid,
      timestamp: toIso(ts),
      sessionId,
      cwd,
      userType: `external`,
      entrypoint: `cli`,
      ...(gitBranch ? { gitBranch } : {}),
    },
  }
}

export function denormalizeClaude(
  events: Array<NormalizedEvent>,
  options: DenormalizeOptions = {}
): Array<string> {
  const sessionId = options.sessionId ?? randomUUID()
  const cwd = options.cwd ?? process.cwd()
  const lines: Array<string> = []

  let pending: PendingAssistant | null = null
  let lastUuid: string | null = null
  const callIdMap = new Map<string, string>()

  // Extract git branch and model from session_init if available
  let gitBranch: string | undefined
  let model: string | undefined
  const initEvent = events.find((e) => e.type === `session_init`)
  if (initEvent?.type === `session_init`) {
    gitBranch = initEvent.git?.branch
    model = initEvent.model
  }

  function emit(ts: number, obj: Record<string, unknown>): void {
    const base = createBaseFields(sessionId, cwd, ts, lastUuid, gitBranch)
    lines.push(JSON.stringify({ isSidechain: false, ...obj, ...base.fields }))
    lastUuid = base.uuid
  }

  function flushPending(): void {
    if (!pending || pending.content.length === 0) return

    const hasToolUse = pending.content.some((b) => b.type === `tool_use`)
    const hasText = pending.content.some((b) => b.type === `text`)

    if (hasToolUse && !hasText) {
      pending.content.unshift({ type: `text`, text: `Continuing...` })
    }

    emit(pending.ts, {
      type: `assistant`,
      message: {
        model: model ?? `claude-sonnet-4-20250514`,
        id: makeMsgId(),
        type: `message`,
        role: `assistant`,
        content: pending.content,
        stop_reason: hasToolUse ? `tool_use` : `end_turn`,
        stop_sequence: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      requestId: makeReqId(),
    })
    pending = null
  }

  function ensurePending(ts: number): PendingAssistant {
    if (!pending) {
      pending = { content: [], ts }
    }
    return pending
  }

  for (const event of events) {
    switch (event.type) {
      case `session_init`: {
        emit(event.ts, {
          type: `system`,
          subtype: `init`,
          sessionId: options.sessionId ?? event.sessionId,
          cwd: options.cwd ?? event.cwd,
          model: model ?? `claude-sonnet-4-20250514`,
          permissionMode: `default`,
        })
        break
      }

      case `user_message`: {
        flushPending()
        emit(event.ts, {
          promptId: randomUUID(),
          type: `user`,
          message: {
            role: `user`,
            content: event.text,
          },
          permissionMode: `default`,
        })
        break
      }

      case `thinking`: {
        if (event.text) {
          const p = ensurePending(event.ts)
          p.content.push({
            type: `thinking`,
            thinking: event.text,
            signature: ``,
          })
        }
        break
      }

      case `assistant_message`: {
        const p = ensurePending(event.ts)
        p.content.push({
          type: `text`,
          text: event.text,
        })
        break
      }

      case `tool_call`: {
        const p = ensurePending(event.ts)

        let callId: string
        if (event.callId.startsWith(`toolu_`)) {
          callId = event.callId
        } else {
          callId = makeToolId()
          callIdMap.set(event.callId, callId)
        }

        const isFromAnotherAgent =
          event.originalAgent && event.originalAgent !== `claude`
        const claudeTool = isFromAnotherAgent
          ? `Bash`
          : denormalizeToolName(event.tool, `claude`)
        const input = isFromAnotherAgent
          ? { command: describeToolCall(event.tool, event.input) }
          : transformInputForClaude(claudeTool, event.input)

        p.content.push({
          type: `tool_use`,
          id: callId,
          name: claudeTool,
          input,
        })
        break
      }

      case `tool_result`: {
        flushPending()
        const resultCallId = callIdMap.get(event.callId) ?? event.callId
        emit(event.ts, {
          type: `user`,
          message: {
            role: `user`,
            content: [
              {
                type: `tool_result`,
                tool_use_id: resultCallId,
                content: event.output,
                ...(event.isError ? { is_error: true } : {}),
              },
            ],
          },
        })
        break
      }

      case `turn_complete`: {
        flushPending()
        emit(event.ts, {
          type: `system`,
          subtype: `turn_duration`,
          durationMs: event.durationMs ?? 0,
          messageCount: 0,
        })
        break
      }

      case `compaction`: {
        flushPending()
        emit(event.ts, {
          type: `system`,
          subtype: `compact_boundary`,
        })
        break
      }

      case `error`: {
        emit(event.ts, {
          type: `system`,
          subtype: `api_error`,
          level: `error`,
          error: {
            error: {
              type: event.code,
              message: event.message,
            },
          },
          retryAttempt: event.retryAttempt,
          maxRetries: event.maxRetries,
        })
        break
      }

      case `permission_request`:
      case `permission_response`:
      case `turn_aborted`:
      case `session_end`:
        break
    }
  }

  flushPending()
  return lines
}
