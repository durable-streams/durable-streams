/**
 * Render CC JSONL entries for the terminal viewer.
 * Mimics Claude Code's display: user messages get a highlighted background,
 * assistant messages start with a bullet point.
 */

// ANSI escape codes
const RESET = `\x1b[0m`
const BG_USER = `\x1b[48;5;236m` // dark gray background for user messages
const BOLD = `\x1b[1m`
const DIM = `\x1b[2m`
const BLUE = `\x1b[34m`

function extractTextContent(message: { content?: unknown }): string {
  const content = message.content
  if (typeof content === `string`) return content
  if (Array.isArray(content)) {
    const parts: Array<string> = []
    for (const block of content) {
      if (block.type === `text` && typeof block.text === `string`) {
        parts.push(block.text)
      } else if (block.type === `tool_use`) {
        const toolName = block.name ?? `tool`
        const input = block.input ?? {}
        let detail = ``
        if (typeof input === `object` && input !== null) {
          const inp = input as Record<string, unknown>
          if (`command` in inp) detail = `: ${String(inp.command).slice(0, 80)}`
          else if (`file_path` in inp) detail = ` ${String(inp.file_path)}`
          else if (`pattern` in inp) detail = ` "${String(inp.pattern)}"`
          else if (`prompt` in inp)
            detail = ` "${String(inp.prompt).slice(0, 60)}"`
          else if (`description` in inp)
            detail = `: "${String(inp.description)}"`
        }
        parts.push(`  ${BLUE}\u25B6 ${toolName}${detail}${RESET}`)
      }
      // Skip "thinking" blocks
    }
    return parts.join(`\n`)
  }
  return ``
}

/**
 * Render user text with a highlighted background (like CC does).
 */
function renderUserText(text: string): string {
  // Apply background to each line
  const lines = text.split(`\n`)
  return lines.map((line) => `${BG_USER} ${line} ${RESET}`).join(`\n`)
}

/**
 * Render a single CC JSONL entry to a terminal string.
 * Returns null if the entry should be skipped.
 */
export function renderEntry(entry: Record<string, unknown>): string | null {
  const type = entry.type as string | undefined
  const subtype = entry.subtype as string | undefined

  // Skip bookkeeping entries
  if (type === `file-history-snapshot`) return null
  if (type === `last-prompt`) return null

  // System entries
  if (type === `system`) {
    if (subtype === `compact_boundary`) {
      return `\n${DIM}── Session compacted ──${RESET}\n`
    }
    if (subtype === `turn_duration`) {
      const ms = entry.durationMs as number | undefined
      const count = entry.messageCount as number | undefined
      if (ms && count) {
        return `${DIM}  (turn: ${(ms / 1000).toFixed(1)}s, ${count} messages)${RESET}\n`
      }
      return null
    }
    return null
  }

  // User messages
  if (type === `user`) {
    const isCompact = entry.isCompactSummary as boolean | undefined
    const message = entry.message as { content?: unknown } | undefined
    if (!message) return null

    if (isCompact) {
      const text = extractTextContent(message)
      const lines = text.split(`\n`)
      const preview = lines.slice(0, 5).join(`\n`)
      const more =
        lines.length > 5
          ? `\n${DIM}  (full summary: ${lines.length} lines)${RESET}`
          : ``
      return `\n${DIM}── Compacted context ──${RESET}\n${DIM}${preview}${RESET}${more}\n`
    }

    const text = extractTextContent(message)
    if (!text) return null
    return `\n${renderUserText(text)}\n`
  }

  // Assistant messages
  if (!type || type === `assistant`) {
    const message = entry.message as
      | { role?: string; content?: unknown }
      | undefined
    if (!message || message.role !== `assistant`) return null
    const text = extractTextContent(message)
    if (!text) return null
    return `\n${BOLD}\u25CF${RESET} ${text}\n`
  }

  // Progress / agent progress
  if (type === `progress` || type === `agent_progress`) {
    return null // Skip for now
  }

  // Unknown types — skip silently
  return null
}
