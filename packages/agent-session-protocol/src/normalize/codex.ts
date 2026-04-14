import { normalizeToolName } from "../tools.js"
import type { NormalizedEvent, NormalizeOptions } from "../types.js"

interface CodexEntry {
  timestamp?: string
  type: string
  payload?: Record<string, unknown>
}

function parseTimestamp(entry: CodexEntry): number {
  if (entry.timestamp) {
    const ms = Date.parse(entry.timestamp)
    if (Number.isFinite(ms)) return ms
  }
  return Date.now()
}

function findLastCompactionIndex(entries: Array<CodexEntry>): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!
    if (entry.type === `compacted`) {
      return i
    }
  }
  return 0
}

function parseArguments(args: unknown): Record<string, unknown> {
  if (typeof args === `string`) {
    try {
      return JSON.parse(args) as Record<string, unknown>
    } catch {
      return { raw: args }
    }
  }
  if (args && typeof args === `object`) {
    return args as Record<string, unknown>
  }
  return {}
}

export function normalizeCodex(
  lines: Array<string>,
  options: NormalizeOptions = {}
): Array<NormalizedEvent> {
  const { fromCompaction = true } = options

  const entries: Array<CodexEntry> = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      entries.push(JSON.parse(trimmed) as CodexEntry)
    } catch {
      // skip malformed lines
    }
  }

  const startIndex = fromCompaction ? findLastCompactionIndex(entries) : 0
  const events: Array<NormalizedEvent> = []

  for (let i = startIndex; i < entries.length; i++) {
    const entry = entries[i]!
    const ts = parseTimestamp(entry)
    const payload = entry.payload ?? {}

    if (entry.type === `session_meta`) {
      const git = payload.git as Record<string, unknown> | null | undefined
      events.push({
        v: 1,
        ts,
        type: `session_init`,
        sessionId: String(payload.id ?? ``),
        cwd: String(payload.cwd ?? ``),
        model: undefined,
        agent: `codex`,
        agentVersion: payload.cli_version
          ? String(payload.cli_version)
          : undefined,
        git: git
          ? {
              branch: git.branch ? String(git.branch) : undefined,
              commit: git.commit_hash ? String(git.commit_hash) : undefined,
              remote: git.repository_url
                ? String(git.repository_url)
                : undefined,
            }
          : undefined,
      })
      continue
    }

    if (entry.type === `compacted`) {
      events.push({ v: 1, ts, type: `compaction` })
      continue
    }

    if (entry.type === `event_msg`) {
      const msgType = payload.type as string | undefined

      if (msgType === `turn_aborted`) {
        events.push({
          v: 1,
          ts,
          type: `turn_aborted`,
          reason: String(payload.reason ?? `interrupted`),
        })
        continue
      }

      if (msgType === `context_compacted`) {
        events.push({ v: 1, ts, type: `compaction` })
        continue
      }

      // skip: token_count, agent_reasoning, agent_message, user_message (mirrors)
      continue
    }

    if (entry.type === `response_item`) {
      const itemType = payload.type as string | undefined

      if (itemType === `message`) {
        const role = payload.role as string | undefined
        const content = payload.content as
          | Array<Record<string, unknown>>
          | undefined

        if (role === `user`) {
          const text = content
            ?.filter((c) => typeof c.text === `string`)
            .map((c) => c.text as string)
            .join(`\n`)
          if (text) {
            events.push({ v: 1, ts, type: `user_message`, text })
          }
          continue
        }

        if (role === `assistant`) {
          const text = content
            ?.filter((c) => typeof c.text === `string`)
            .map((c) => c.text as string)
            .join(`\n`)
          if (text) {
            events.push({
              v: 1,
              ts,
              type: `assistant_message`,
              text,
              phase:
                payload.phase === `commentary`
                  ? `commentary`
                  : payload.phase === `final_answer`
                    ? `final`
                    : undefined,
            })
          }
          continue
        }

        // skip developer messages (system instructions)
        continue
      }

      if (itemType === `function_call`) {
        const args = parseArguments(payload.arguments)
        const mapping = normalizeToolName(
          String(payload.name ?? ``),
          `codex`,
          args
        )

        events.push({
          v: 1,
          ts,
          type: `tool_call`,
          callId: String(payload.call_id ?? ``),
          tool: mapping.normalized,
          originalTool: mapping.originalTool,
          originalAgent: `codex`,
          input: args,
        })
        continue
      }

      if (itemType === `function_call_output`) {
        events.push({
          v: 1,
          ts,
          type: `tool_result`,
          callId: String(payload.call_id ?? ``),
          output: String(payload.output ?? ``),
          isError: false,
        })
        continue
      }

      if (itemType === `custom_tool_call`) {
        const mapping = normalizeToolName(
          String(payload.name ?? ``),
          `codex`,
          { input: payload.input }
        )

        events.push({
          v: 1,
          ts,
          type: `tool_call`,
          callId: String(payload.call_id ?? ``),
          tool: mapping.normalized,
          originalTool: mapping.originalTool,
          originalAgent: `codex`,
          input:
            typeof payload.input === `string`
              ? { raw: payload.input }
              : ((payload.input as Record<string, unknown>) ?? {}),
        })
        continue
      }

      if (itemType === `custom_tool_call_output`) {
        let output = String(payload.output ?? ``)
        let isError = false

        try {
          const parsed = JSON.parse(output) as Record<string, unknown>
          if (typeof parsed.output === `string`) {
            output = parsed.output
          }
          const meta = parsed.metadata as Record<string, unknown> | undefined
          if (meta && typeof meta.exit_code === `number` && meta.exit_code !== 0) {
            isError = true
          }
        } catch {
          // use raw output
        }

        events.push({
          v: 1,
          ts,
          type: `tool_result`,
          callId: String(payload.call_id ?? ``),
          output,
          isError,
        })
        continue
      }

      if (itemType === `reasoning`) {
        const summaryArr = payload.summary as
          | Array<Record<string, unknown>>
          | undefined
        const summaryText =
          summaryArr
            ?.map((s) => (typeof s.text === `string` ? s.text : ``))
            .filter(Boolean)
            .join(` `) ?? `(thinking)`

        events.push({
          v: 1,
          ts,
          type: `thinking`,
          summary: summaryText || `(thinking)`,
          text: null,
        })
        continue
      }

      if (itemType === `web_search_call`) {
        const action = payload.action as Record<string, unknown> | undefined
        const mapping = normalizeToolName(`web_search`, `codex`, {
          action,
        })

        events.push({
          v: 1,
          ts,
          type: `tool_call`,
          callId: `web-${i}`,
          tool: mapping.normalized,
          originalTool: `web_search`,
          originalAgent: `codex`,
          input: action ? { url: action.url } : {},
        })
        continue
      }

      // skip other response_item types
      continue
    }

    // skip: turn_context, etc.
  }

  return events
}
