import type { Collection, Transaction } from "@tanstack/db"
import type {
  DurableStream,
  DurableStreamOptions,
} from "@durable-streams/client"
import type { AgentType, User } from "./types.js"

export interface SessionRow {
  id: string
  streamId: string
  agent?: string
  model?: string
  cwd?: string
  permissionMode?: string
  status: string
  startedAt?: string
  resumedAt?: string
  endedAt?: string
  lastEventAt?: string
}

export interface ParticipantRow {
  id: string
  sessionId: string
  name?: string
  email?: string
  firstSeenAt?: string
  lastSeenAt?: string
}

export interface MessageRow {
  id: string
  sessionId: string
  turnId?: string
  participantId?: string
  role: string
  provider?: string
  providerMessageId?: string
  kind: string
  syntheticType?: string
  createdAt: string
  completedAt?: string
  status: string
}

export interface MessagePartRow {
  id: string
  messageId: string
  sessionId: string
  partIndex: number
  deltaIndex?: number
  kind: string
  text?: string
  json?: unknown
  providerPartType?: string
  createdAt: string
}

export interface TurnRow {
  id: string
  sessionId: string
  promptMessageId?: string
  status: string
  startedAt?: string
  completedAt?: string
  durationMs?: number
  apiDurationMs?: number
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  reasoningOutputTokens?: number
  costUsd?: number
  stopReason?: string
}

export interface ToolCallRow {
  id: string
  sessionId: string
  turnId?: string
  messageId?: string
  toolName: string
  providerToolType?: string
  status: string
  input?: unknown
  output?: unknown
  error?: string
  startedAt?: string
  completedAt?: string
  durationMs?: number
}

export interface PermissionRequestRow {
  id: string
  sessionId: string
  turnId?: string
  toolCallId?: string
  providerRequestId?: string
  toolName?: string
  input?: unknown
  status: string
  requestedAt: string
  resolvedAt?: string
  resolvedByParticipantId?: string
  effectiveResponseId?: string
}

export interface ApprovalResponseRow {
  id: string
  sessionId: string
  requestId: string
  participantId?: string
  decision: string
  message?: string
  updatedInput?: unknown
  effective: boolean
  ignoredReason?: string
  createdAt: string
}

export interface SessionEventRow {
  id: string
  sessionId: string
  kind: string
  data?: unknown
  createdAt: string
}

export interface DebugEventRow {
  id: string
  sessionId: string
  kind: string
  data?: unknown
  createdAt: string
}

export interface AgentDBCollections {
  sessions: Collection<SessionRow, string>
  participants: Collection<ParticipantRow, string>
  messages: Collection<MessageRow, string>
  message_parts: Collection<MessagePartRow, string>
  turns: Collection<TurnRow, string>
  tool_calls: Collection<ToolCallRow, string>
  permission_requests: Collection<PermissionRequestRow, string>
  approval_responses: Collection<ApprovalResponseRow, string>
  session_events: Collection<SessionEventRow, string>
  debug_events: Collection<DebugEventRow, string>
}

export interface AgentDBPromptParams {
  agent: AgentType
  user: User
  text: string
}

export interface AgentDBRespondParams {
  agent: AgentType
  user: User
  requestId: string | number
  response: object
}

export interface AgentDBCancelParams {
  agent: AgentType
  user: User
  requestId: string | number
}

export interface AgentDBInterruptParams {
  agent: AgentType
  user: User
}

export interface AgentDBActions {
  prompt: (params: AgentDBPromptParams) => Transaction
  respond: (params: AgentDBRespondParams) => Transaction
  cancel: (params: AgentDBCancelParams) => Transaction
  interrupt: (params: AgentDBInterruptParams) => Transaction
}

export interface CreateAgentDBOptions {
  streamOptions: DurableStreamOptions
}

export interface AgentDBUtils {
  awaitTxId: (txid: string, timeout?: number) => Promise<void>
}

export interface AgentDB {
  stream: DurableStream
  collections: AgentDBCollections
  actions: AgentDBActions
  utils: AgentDBUtils
  preload: () => Promise<void>
  close: () => void
}
