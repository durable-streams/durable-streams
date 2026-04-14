import type { AgentType } from "./types.js"

export interface ToolMapping {
  normalized: string
  originalTool: string
  originalAgent: AgentType
}

const CLAUDE_TO_NORMALIZED: Record<string, string> = {
  Bash: `terminal`,
  Read: `file_read`,
  Edit: `file_edit`,
  Write: `file_write`,
  Glob: `file_search`,
  Grep: `content_search`,
  WebSearch: `web_search`,
  WebFetch: `web_fetch`,
  Agent: `sub_agent`,
}

const NORMALIZED_TO_CLAUDE: Record<string, string> = {
  terminal: `Bash`,
  file_read: `Read`,
  file_edit: `Edit`,
  file_write: `Write`,
  file_search: `Glob`,
  content_search: `Grep`,
  web_search: `WebSearch`,
  web_fetch: `WebFetch`,
  sub_agent: `Agent`,
}

const NORMALIZED_TO_CODEX: Record<string, string> = {
  terminal: `exec_command`,
  file_read: `exec_command`,
  file_edit: `apply_patch`,
  file_write: `apply_patch`,
  file_search: `exec_command`,
  content_search: `exec_command`,
  web_search: `web_search`,
  web_fetch: `web_search`,
}

function classifyCodexExecCommand(args: string): string {
  const cmd = args.trim()

  if (/^(cat|head|tail|less|more)\s/.test(cmd)) {
    return `file_read`
  }

  if (/^nl\s/.test(cmd)) {
    return `file_read`
  }

  if (/^rg\s.*--files/.test(cmd)) {
    return `file_search`
  }

  if (/^(find|fd)\s/.test(cmd)) {
    return `file_search`
  }

  if (/^ls\s/.test(cmd)) {
    return `file_search`
  }

  if (/^(rg|grep|ag|ack)\s/.test(cmd)) {
    return `content_search`
  }

  return `terminal`
}

export function normalizeToolName(
  tool: string,
  agent: AgentType,
  input?: Record<string, unknown>
): ToolMapping {
  if (agent === `claude`) {
    const normalized = CLAUDE_TO_NORMALIZED[tool]
    if (normalized) {
      return { normalized, originalTool: tool, originalAgent: agent }
    }

    return { normalized: tool, originalTool: tool, originalAgent: agent }
  }

  if (agent === `codex`) {
    if (tool === `exec_command`) {
      const cmd =
        typeof input?.cmd === `string`
          ? input.cmd
          : typeof input?.command === `string`
            ? input.command
            : ``
      const classified = classifyCodexExecCommand(cmd)
      return { normalized: classified, originalTool: tool, originalAgent: agent }
    }

    if (tool === `apply_patch`) {
      const patchInput =
        typeof input?.input === `string` ? input.input : ``
      const isNewFile = patchInput.includes(`*** Add File:`)
      return {
        normalized: isNewFile ? `file_write` : `file_edit`,
        originalTool: tool,
        originalAgent: agent,
      }
    }

    if (tool === `web_search`) {
      const action = input?.action as Record<string, unknown> | undefined
      if (action?.type === `open_page`) {
        return {
          normalized: `web_fetch`,
          originalTool: tool,
          originalAgent: agent,
        }
      }
      return { normalized: `web_search`, originalTool: tool, originalAgent: agent }
    }

    return { normalized: tool, originalTool: tool, originalAgent: agent }
  }

  return { normalized: tool, originalTool: tool, originalAgent: agent }
}

export function denormalizeToolName(
  normalizedTool: string,
  targetAgent: AgentType
): string {
  if (targetAgent === `claude`) {
    return NORMALIZED_TO_CLAUDE[normalizedTool] ?? normalizedTool
  }

  if (targetAgent === `codex`) {
    return NORMALIZED_TO_CODEX[normalizedTool] ?? normalizedTool
  }

  return normalizedTool
}
