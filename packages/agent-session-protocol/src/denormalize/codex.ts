import { randomUUID } from "node:crypto"
import { denormalizeToolName } from "../tools.js"
import type { DenormalizeOptions, NormalizedEvent } from "../types.js"

function toIso(ts: number): string {
  return new Date(ts).toISOString()
}

export function denormalizeCodex(
  events: Array<NormalizedEvent>,
  options: DenormalizeOptions = {}
): Array<string> {
  const sessionId = options.sessionId ?? randomUUID()
  const cwd = options.cwd ?? process.cwd()
  const lines: Array<string> = []

  for (const event of events) {
    const ts = toIso(event.ts)

    switch (event.type) {
      case `session_init`: {
        lines.push(
          JSON.stringify({
            timestamp: ts,
            type: `session_meta`,
            payload: {
              id: options.sessionId ?? event.sessionId ?? sessionId,
              timestamp: ts,
              cwd: options.cwd ?? event.cwd ?? cwd,
              originator: `Codex CLI`,
              cli_version: event.agentVersion ?? `0.99.0`,
              source: `cli`,
              model_provider: `openai`,
              base_instructions: {
                text: `You are a helpful coding assistant.`,
              },
              git: event.git
                ? {
                    commit_hash: event.git.commit ?? null,
                    branch: event.git.branch ?? null,
                    repository_url: event.git.remote ?? null,
                  }
                : null,
            },
          })
        )
        break
      }

      case `user_message`: {
        lines.push(
          JSON.stringify({
            timestamp: ts,
            type: `response_item`,
            payload: {
              type: `message`,
              role: `user`,
              content: [{ type: `input_text`, text: event.text }],
            },
          })
        )
        // Mirror for TUI display
        lines.push(
          JSON.stringify({
            timestamp: ts,
            type: `event_msg`,
            payload: {
              type: `user_message`,
              message: event.text,
              images: [],
              local_images: [],
              text_elements: [],
            },
          })
        )
        break
      }

      case `assistant_message`: {
        lines.push(
          JSON.stringify({
            timestamp: ts,
            type: `response_item`,
            payload: {
              type: `message`,
              role: `assistant`,
              phase: event.phase === `commentary` ? `commentary` : event.phase === `final` ? `final_answer` : undefined,
              content: [{ type: `output_text`, text: event.text }],
            },
          })
        )
        // Mirror for TUI display
        lines.push(
          JSON.stringify({
            timestamp: ts,
            type: `event_msg`,
            payload: {
              type: `agent_message`,
              message: event.text,
            },
          })
        )
        break
      }

      case `thinking`: {
        lines.push(
          JSON.stringify({
            timestamp: ts,
            type: `response_item`,
            payload: {
              type: `reasoning`,
              summary: [
                { type: `summary_text`, text: event.summary },
              ],
              content: null,
              encrypted_content: null,
            },
          })
        )
        // Mirror for TUI display
        lines.push(
          JSON.stringify({
            timestamp: ts,
            type: `event_msg`,
            payload: {
              type: `agent_reasoning`,
              text: event.summary,
            },
          })
        )
        break
      }

      case `tool_call`: {
        const codexTool = denormalizeToolName(event.tool, `codex`)
        const isCustom =
          codexTool === `apply_patch` ||
          (event.originalTool === `apply_patch` &&
            event.originalAgent === `codex`)

        if (isCustom) {
          lines.push(
            JSON.stringify({
              timestamp: ts,
              type: `response_item`,
              payload: {
                type: `custom_tool_call`,
                status: `completed`,
                call_id: event.callId,
                name: codexTool,
                input:
                  typeof event.input.raw === `string`
                    ? event.input.raw
                    : JSON.stringify(event.input),
              },
            })
          )
        } else {
          lines.push(
            JSON.stringify({
              timestamp: ts,
              type: `response_item`,
              payload: {
                type: `function_call`,
                call_id: event.callId,
                name: codexTool,
                arguments: JSON.stringify(event.input),
              },
            })
          )
        }
        break
      }

      case `tool_result`: {
        // Check if the corresponding call was a custom tool
        // We track this by looking backwards for the matching call
        const matchingCall = events.find(
          (e): e is import("../types.js").ToolCallEvent =>
            e.type === `tool_call` && e.callId === event.callId
        )
        const codexTool = matchingCall
          ? denormalizeToolName(matchingCall.tool, `codex`)
          : ``
        const isCustom = codexTool === `apply_patch`

        if (isCustom) {
          lines.push(
            JSON.stringify({
              timestamp: ts,
              type: `response_item`,
              payload: {
                type: `custom_tool_call_output`,
                call_id: event.callId,
                output: JSON.stringify({
                  output: event.output,
                  metadata: {
                    exit_code: event.isError ? 1 : 0,
                    duration_seconds: 0.0,
                  },
                }),
              },
            })
          )
        } else {
          lines.push(
            JSON.stringify({
              timestamp: ts,
              type: `response_item`,
              payload: {
                type: `function_call_output`,
                call_id: event.callId,
                output: event.output,
              },
            })
          )
        }
        break
      }

      case `compaction`: {
        lines.push(
          JSON.stringify({
            timestamp: ts,
            type: `compacted`,
            payload: {
              message: event.summary ?? ``,
              replacement_history: [],
            },
          })
        )
        break
      }

      case `turn_complete`:
      case `turn_aborted`:
      case `error`:
      case `permission_request`:
      case `permission_response`:
      case `session_end`:
        // These are not required for Codex rollout resume
        break
    }
  }

  return lines
}
