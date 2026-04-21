/**
 * Filter out "export/share" skill invocations and their subsequent
 * execution turns from a session's raw JSONL lines.
 *
 * When a user invokes /share (or any skill in SHARE_SKILL_NAMES), the
 * session file ends up with:
 *   1. A user-message invocation entry (the slash command itself).
 *   2. A user-message skill-body injection (CC injects the SKILL.md content
 *      as user input so the model can act on it).
 *   3. An attachment entry or two (command_permissions, etc. for CC).
 *   4. One or more assistant turns that execute the skill.
 *
 * None of this is meaningful *content* of the shared session — it's all
 * plumbing about the share itself. When a viewer or a resuming agent
 * sees it, it's noise at best and confusing at worst (Codex in
 * particular renders the entire SKILL.md back in the resumed session).
 *
 * This filter strips the whole round, from the invocation up to (but
 * not including) the next real user turn. Anything that comes after a
 * /share round (e.g. the user continuing to chat in live-share mode)
 * is preserved.
 *
 * The filter is stateful so it works across incremental batches: the
 * live-share watcher feeds lines in chunks as the JSONL file grows,
 * and the skill invocation may appear in one batch while its
 * machinery arrives in subsequent batches.
 */

import type { AgentType } from "./types.js"

/**
 * Skills whose invocations should be filtered out. Only "share/export"
 * skills — never filter general slash commands like /compact, /clear,
 * or unrelated user-defined skills.
 */
const SHARE_SKILL_NAMES = new Set([`share`])

export class SkillInvocationFilter {
  private inSkillRound = false

  constructor(private readonly agent: AgentType) {}

  feed(lines: Array<string>): Array<string> {
    const out: Array<string> = []
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) {
        out.push(line)
        continue
      }
      let entry: Record<string, unknown>
      try {
        entry = JSON.parse(trimmed) as Record<string, unknown>
      } catch {
        // Malformed line — pass through unchanged; the downstream
        // normalizer will skip it too.
        out.push(line)
        continue
      }

      if (this.isInvocation(entry)) {
        this.inSkillRound = true
        continue
      }

      if (this.inSkillRound) {
        if (this.isMachinery(entry)) continue
        // A non-machinery, non-invocation entry — the skill round is
        // over. Fall through to include this entry.
        this.inSkillRound = false
      }

      out.push(line)
    }
    return out
  }

  private isInvocation(entry: Record<string, unknown>): boolean {
    return this.agent === `claude`
      ? isClaudeSkillInvocation(entry)
      : isCodexSkillInvocation(entry)
  }

  private isMachinery(entry: Record<string, unknown>): boolean {
    return this.agent === `claude`
      ? isClaudeSkillMachinery(entry)
      : isCodexSkillMachinery(entry)
  }
}

/**
 * Convenience wrapper for one-shot filtering of a complete session
 * (snapshot exports). For live/streaming exports, instantiate a
 * SkillInvocationFilter and feed incremental batches through it to
 * preserve skill-round state across batches.
 */
export function filterSkillInvocations(
  lines: Array<string>,
  agent: AgentType
): Array<string> {
  return new SkillInvocationFilter(agent).feed(lines)
}

// ---------------------------------------------------------------------
// Claude Code detection
// ---------------------------------------------------------------------

function isClaudeSkillInvocation(entry: Record<string, unknown>): boolean {
  if (entry.type !== `user`) return false
  const message = entry.message as { content?: unknown } | undefined
  const content = message?.content
  if (typeof content !== `string`) return false
  // CC writes slash-command invocations as a user message with literal
  // <command-name>/skill-name</command-name> tags in the content string.
  const match = content.match(/<command-name>\/?([^<\s]+)<\/command-name>/)
  if (!match) return false
  return SHARE_SKILL_NAMES.has(match[1]!.trim())
}

function isClaudeSkillMachinery(entry: Record<string, unknown>): boolean {
  const type = entry.type
  // Attachments (command_permissions, etc.) emitted during skill run.
  if (type !== `user` && type !== `assistant`) return true

  // Assistant turns during skill execution (including tool calls and
  // their results woven between assistant blocks).
  if (type === `assistant`) return true
  const message = entry.message as
    | { role?: string; content?: unknown }
    | undefined
  if (message?.role === `assistant`) return true

  // At this point `type` is necessarily `"user"` (we returned true for
  // every other case above). User turns that are skill-body injections
  // (CC feeds the SKILL.md content to the model as a user message so
  // it can act on the skill's instructions) are machinery.
  const content = message?.content
  if (Array.isArray(content)) {
    for (const block of content) {
      const b = block as Record<string, unknown>
      if (b.type === `text` && typeof b.text === `string`) {
        if (b.text.startsWith(`Base directory for this skill:`)) return true
      }
    }
  }

  return false
}

// ---------------------------------------------------------------------
// Codex detection
// ---------------------------------------------------------------------

function extractCodexUserText(payload: Record<string, unknown>): string {
  const content = payload.content
  if (typeof content === `string`) return content
  if (!Array.isArray(content)) return ``
  let text = ``
  for (const block of content) {
    const b = block as Record<string, unknown>
    if (typeof b.text === `string`) text += b.text
  }
  return text
}

function codexSkillBodyMatch(text: string): string | null {
  // Codex injects the SKILL.md content as user text with the
  // "Base directory for this skill: <path>" preamble on the first
  // line, where <path> ends with "/skills/<skill-name>".
  const m = text.match(
    /Base directory for this skill:\s*\S*?\/skills\/([a-zA-Z0-9_-]+)/
  )
  return m ? m[1]! : null
}

function isCodexSkillInvocation(entry: Record<string, unknown>): boolean {
  if (entry.type !== `response_item` && entry.type !== `event_msg`) return false
  const payload = entry.payload as Record<string, unknown> | undefined
  if (!payload) return false

  // response_item form
  if (entry.type === `response_item`) {
    if (payload.type !== `message`) return false
    if (payload.role !== `user`) return false
    const text = extractCodexUserText(payload)
    const name = codexSkillBodyMatch(text)
    return name !== null && SHARE_SKILL_NAMES.has(name)
  }

  // event_msg form (Codex mirrors user_message as an event_msg too)
  if (payload.type === `user_message`) {
    const text = typeof payload.message === `string` ? payload.message : ``
    const name = codexSkillBodyMatch(text)
    return name !== null && SHARE_SKILL_NAMES.has(name)
  }

  return false
}

function isCodexSkillMachinery(entry: Record<string, unknown>): boolean {
  if (entry.type === `session_meta`) return false

  // event_msg mirrors response_item, so filter the whole class during
  // a skill round (with one exception — see user_message check below).
  if (entry.type === `event_msg`) {
    const payload = entry.payload as Record<string, unknown> | undefined
    if (payload?.type === `user_message`) {
      const text = typeof payload.message === `string` ? payload.message : ``
      if (codexSkillBodyMatch(text) !== null) return true
      return false // real user turn
    }
    return true
  }

  if (entry.type === `response_item`) {
    const payload = entry.payload as Record<string, unknown> | undefined
    if (!payload) return true
    if (payload.type === `message` && payload.role === `user`) {
      const text = extractCodexUserText(payload)
      if (codexSkillBodyMatch(text) !== null) return true
      return false // real user turn — stop filtering
    }
    return true
  }

  return false
}
