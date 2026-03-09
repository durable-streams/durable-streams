import { createStateSchema } from "@durable-streams/state"

export interface TaskEvent {
  id: string
  type:
    | `assigned`
    | `follow_up`
    | `agent_started`
    | `agent_working`
    | `agent_done`
    | `llm_text`
    | `tool_call`
    | `tool_result`
    | `agent_error`
  task?: string
  epoch?: number
  step?: string
  result?: string
  timestamp: number
  text?: string
  messageIndex?: number
  toolName?: string
  toolCallId?: string
  args?: Record<string, unknown>
  isError?: boolean
  inputTokens?: number
  outputTokens?: number
  error?: string
}

const taskEventSchema = {
  "~standard": {
    version: 1 as const,
    vendor: `webhook-agents-ui`,
    validate: (value: unknown) => {
      if (typeof value === `object` && value !== null) {
        return { value: value as TaskEvent }
      }
      return { issues: [{ message: `Expected an object` }] }
    },
  },
}

export const taskStateSchema = createStateSchema({
  events: {
    schema: taskEventSchema,
    type: `event`,
    primaryKey: `id`,
  },
})
