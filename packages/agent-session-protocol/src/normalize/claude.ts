import { normalizeToolName } from "../tools.js"
import type { NormalizedEvent, NormalizeOptions } from "../types.js"

interface ClaudeEntry {
  type?: string
  subtype?: string
  timestamp?: string
  uuid?: string
  sessionId?: string
  cwd?: string
  version?: string
  gitBranch?: string
  message?: {
    role?: string
    model?: string
    content?: unknown
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
    stop_reason?: string
  }
  durationMs?: number
  messageCount?: number
  error?: {
    status?: number
    error?: {
      type?: string
      message?: string
    }
  }
  retryInMs?: number
  retryAttempt?: number
  maxRetries?: number
  level?: string
  request?: {
    subtype?: string
    tool_name?: string
    input?: Record<string, unknown>
  }
  request_id?: string | number
  response?: {
    request_id?: string | number
    subtype?: string
    response?: Record<string, unknown>
  }
  data?: {
    type?: string
  }
  permissionMode?: string
  [key: string]: unknown
}

function parseTimestamp(entry: ClaudeEntry): number {
  if (entry.timestamp) {
    const ms = Date.parse(entry.timestamp)
    if (Number.isFinite(ms)) return ms
  }
  return Date.now()
}

function extractTextFromContent(
  content: unknown
): string {
  if (typeof content === `string`) return content
  if (!Array.isArray(content)) return ``

  return content
    .filter(
      (block: Record<string, unknown>) =>
        block.type === `text` && typeof block.text === `string`
    )
    .map((block: Record<string, unknown>) => block.text as string)
    .join(`\n`)
}

function findLastCompactionIndex(entries: Array<ClaudeEntry>): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!
    if (entry.type === `system` && entry.subtype === `compact_boundary`) {
      return i
    }
  }
  return 0
}

export function normalizeClaude(
  lines: Array<string>,
  options: NormalizeOptions = {}
): Array<NormalizedEvent> {
  const { fromCompaction = true } = options

  const entries: Array<ClaudeEntry> = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      entries.push(JSON.parse(trimmed) as ClaudeEntry)
    } catch {
      // skip malformed lines
    }
  }

  const startIndex = fromCompaction ? findLastCompactionIndex(entries) : 0
  const events: Array<NormalizedEvent> = []

  for (let i = startIndex; i < entries.length; i++) {
    const entry = entries[i]!
    const ts = parseTimestamp(entry)

    if (entry.type === `system`) {
      if (entry.subtype === `init`) {
        events.push({
          v: 1,
          ts,
          type: `session_init`,
          sessionId: entry.sessionId ?? ``,
          cwd: entry.cwd ?? ``,
          model: entry.message?.model ?? (entry as Record<string, unknown>).model as string | undefined,
          agent: `claude`,
          agentVersion: entry.version,
          git: entry.gitBranch
            ? { branch: entry.gitBranch }
            : undefined,
        })
        continue
      }

      if (entry.subtype === `compact_boundary`) {
        events.push({ v: 1, ts, type: `compaction` })
        continue
      }

      if (entry.subtype === `turn_duration`) {
        events.push({
          v: 1,
          ts,
          type: `turn_complete`,
          success: true,
          durationMs: entry.durationMs,
        })
        continue
      }

      if (entry.subtype === `api_error`) {
        events.push({
          v: 1,
          ts,
          type: `error`,
          code: entry.error?.error?.type,
          message:
            entry.error?.error?.message ?? `API error ${entry.error?.status}`,
          retryable: (entry.retryAttempt ?? 0) < (entry.maxRetries ?? 0),
          retryAttempt: entry.retryAttempt,
          maxRetries: entry.maxRetries,
        })
        continue
      }

      // skip other system subtypes
      continue
    }

    if (entry.type === `user`) {
      const content = entry.message?.content

      if (Array.isArray(content)) {
        // Check for tool_result blocks
        for (const block of content) {
          const b = block as Record<string, unknown>
          if (b.type === `tool_result`) {
            const output =
              typeof b.content === `string`
                ? b.content
                : Array.isArray(b.content)
                  ? (b.content as Array<Record<string, unknown>>)
                      .map((p) =>
                        typeof p.text === `string`
                          ? p.text
                          : JSON.stringify(p)
                      )
                      .join(``)
                  : JSON.stringify(b.content ?? ``)

            events.push({
              v: 1,
              ts,
              type: `tool_result`,
              callId: String(b.tool_use_id ?? ``),
              output,
              isError: b.is_error === true,
            })
          }
        }

        // Also extract user text
        const text = extractTextFromContent(content)
        if (text) {
          events.push({ v: 1, ts, type: `user_message`, text })
        }
      } else if (typeof content === `string` && content) {
        events.push({ v: 1, ts, type: `user_message`, text: content })
      }

      continue
    }

    if (entry.type === `assistant` || (!entry.type && entry.message?.role === `assistant`)) {
      const content = entry.message?.content
      if (!Array.isArray(content)) continue

      for (const block of content) {
        const b = block as Record<string, unknown>

        if (b.type === `thinking`) {
          const thinkingText =
            typeof b.thinking === `string` && b.thinking.length > 0
              ? b.thinking
              : null
          events.push({
            v: 1,
            ts,
            type: `thinking`,
            summary: typeof b.thinking === `string` && b.thinking.length > 0
              ? b.thinking.slice(0, 200)
              : `(thinking)`,
            text: thinkingText,
          })
          continue
        }

        if (b.type === `text` && typeof b.text === `string` && b.text) {
          events.push({
            v: 1,
            ts,
            type: `assistant_message`,
            text: b.text,
          })
          continue
        }

        if (b.type === `tool_use`) {
          const mapping = normalizeToolName(
            String(b.name ?? ``),
            `claude`,
            b.input as Record<string, unknown> | undefined
          )

          events.push({
            v: 1,
            ts,
            type: `tool_call`,
            callId: String(b.id ?? ``),
            tool: mapping.normalized,
            originalTool: mapping.originalTool,
            originalAgent: `claude`,
            input: (b.input as Record<string, unknown>) ?? {},
          })
          continue
        }
      }

      // Emit turn_complete if this was the final assistant message
      if (entry.message?.stop_reason === `end_turn` && entry.message.usage) {
        const usage = entry.message.usage
        events.push({
          v: 1,
          ts,
          type: `turn_complete`,
          success: true,
          usage: {
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            cachedInputTokens:
              (usage.cache_read_input_tokens ?? 0) +
              (usage.cache_creation_input_tokens ?? 0),
          },
        })
      }

      continue
    }

    if (entry.type === `result`) {
      events.push({
        v: 1,
        ts,
        type: `turn_complete`,
        success: entry.subtype === `success`,
        usage: entry.message?.usage
          ? {
              inputTokens: entry.message.usage.input_tokens,
              outputTokens: entry.message.usage.output_tokens,
            }
          : undefined,
        durationMs: entry.durationMs,
      })
      continue
    }

    // skip: progress, file-history-snapshot, last-prompt, etc.
  }

  // Inject session_init from first entry metadata if none emitted
  if (!events.some((e) => e.type === `session_init`) && entries.length > 0) {
    const first = entries[startIndex]
    if (first) {
      events.unshift({
        v: 1,
        ts: parseTimestamp(first),
        type: `session_init`,
        sessionId: first.sessionId ?? ``,
        cwd: first.cwd ?? ``,
        agent: `claude`,
        agentVersion: first.version,
        git: first.gitBranch ? { branch: first.gitBranch } : undefined,
      })
    }
  }

  return events
}
