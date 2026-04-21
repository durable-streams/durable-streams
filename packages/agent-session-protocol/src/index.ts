import { normalizeClaude } from "./normalize/claude.js"
import { normalizeCodex } from "./normalize/codex.js"
import { denormalizeClaude } from "./denormalize/claude.js"
import { denormalizeCodex } from "./denormalize/codex.js"
import type {
  AgentType,
  DenormalizeOptions,
  NormalizeOptions,
  NormalizedEvent,
} from "./types.js"

export function normalize(
  lines: Array<string>,
  agent: AgentType,
  options: NormalizeOptions = {}
): Array<NormalizedEvent> {
  switch (agent) {
    case `claude`:
      return normalizeClaude(lines, options)
    case `codex`:
      return normalizeCodex(lines, options)
    default:
      throw new Error(`Unsupported agent: ${agent as string}`)
  }
}

export function denormalize(
  events: Array<NormalizedEvent>,
  agent: AgentType,
  options: DenormalizeOptions = {}
): Array<string> {
  switch (agent) {
    case `claude`:
      return denormalizeClaude(events, options)
    case `codex`:
      return denormalizeCodex(events, options)
    default:
      throw new Error(`Unsupported agent: ${agent as string}`)
  }
}

export {
  discoverSessions,
  findClaudeSession,
  findSessionPath,
  rewriteNativeLines,
  writeClaudeSession,
  writeCodexSession,
} from "./sessions.js"

export {
  filterSkillInvocations,
  SkillInvocationFilter,
} from "./filter-skill-invocations.js"

export type {
  AgentType,
  AssistantMessageEvent,
  CompactionEvent,
  DenormalizeOptions,
  ErrorEvent,
  NormalizedEvent,
  NormalizeOptions,
  PermissionRequestEvent,
  PermissionResponseEvent,
  SessionEndEvent,
  SessionInitEvent,
  ThinkingEvent,
  ToolCallEvent,
  ToolResultEvent,
  TurnAbortedEvent,
  TurnCompleteEvent,
  UserMessageEvent,
} from "./types.js"

export type { DiscoveredSession } from "./sessions.js"
