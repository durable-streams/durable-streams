import { createStateSchema } from "@durable-streams/state"
import type { CollectionDefinition, StateSchema } from "@durable-streams/state"
import type {
  ApprovalResponseRow,
  DebugEventRow,
  MessagePartRow,
  MessageRow,
  ParticipantRow,
  PermissionRequestRow,
  SessionEventRow,
  SessionRow,
  ToolCallRow,
  TurnRow,
} from "./agent-db-types.js"

function permissiveObjectSchema<T extends object>(): {
  "~standard": {
    version: 1
    vendor: string
    validate: (
      value: unknown
    ) => { value: T } | { issues: Array<{ message: string }> }
  }
} {
  return {
    "~standard": {
      version: 1 as const,
      vendor: `durable-streams`,
      validate: (value: unknown) => {
        if (typeof value !== `object` || value === null) {
          return {
            issues: [{ message: `Expected an object value` }],
          }
        }

        return { value: value as T }
      },
    },
  }
}

type AgentDBStateDefinition = {
  sessions: CollectionDefinition<SessionRow>
  participants: CollectionDefinition<ParticipantRow>
  messages: CollectionDefinition<MessageRow>
  message_parts: CollectionDefinition<MessagePartRow>
  turns: CollectionDefinition<TurnRow>
  tool_calls: CollectionDefinition<ToolCallRow>
  permission_requests: CollectionDefinition<PermissionRequestRow>
  approval_responses: CollectionDefinition<ApprovalResponseRow>
  session_events: CollectionDefinition<SessionEventRow>
  debug_events: CollectionDefinition<DebugEventRow>
}

export type AgentDBStateSchema = StateSchema<AgentDBStateDefinition>

export function createAgentDBSchema(): AgentDBStateSchema {
  return createStateSchema({
    sessions: {
      schema: permissiveObjectSchema<SessionRow>(),
      type: `agentdb/session`,
      primaryKey: `id`,
    },
    participants: {
      schema: permissiveObjectSchema<ParticipantRow>(),
      type: `agentdb/participant`,
      primaryKey: `id`,
    },
    messages: {
      schema: permissiveObjectSchema<MessageRow>(),
      type: `agentdb/message`,
      primaryKey: `id`,
    },
    message_parts: {
      schema: permissiveObjectSchema<MessagePartRow>(),
      type: `agentdb/message-part`,
      primaryKey: `id`,
    },
    turns: {
      schema: permissiveObjectSchema<TurnRow>(),
      type: `agentdb/turn`,
      primaryKey: `id`,
    },
    tool_calls: {
      schema: permissiveObjectSchema<ToolCallRow>(),
      type: `agentdb/tool-call`,
      primaryKey: `id`,
    },
    permission_requests: {
      schema: permissiveObjectSchema<PermissionRequestRow>(),
      type: `agentdb/permission-request`,
      primaryKey: `id`,
    },
    approval_responses: {
      schema: permissiveObjectSchema<ApprovalResponseRow>(),
      type: `agentdb/approval-response`,
      primaryKey: `id`,
    },
    session_events: {
      schema: permissiveObjectSchema<SessionEventRow>(),
      type: `agentdb/session-event`,
      primaryKey: `id`,
    },
    debug_events: {
      schema: permissiveObjectSchema<DebugEventRow>(),
      type: `agentdb/debug-event`,
      primaryKey: `id`,
    },
  })
}
