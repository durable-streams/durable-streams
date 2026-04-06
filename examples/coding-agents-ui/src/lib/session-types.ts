import type { AgentType } from "@durable-streams/coding-agents"
import type { CodexSandboxMode } from "@durable-streams/coding-agents/protocol"

export type ExampleApprovalPolicy =
  | `untrusted`
  | `on-failure`
  | `on-request`
  | `never`

export interface SessionRecord {
  id: string
  title: string
  agent: AgentType
  cwd: string
  model?: string
  permissionMode?: string
  approvalPolicy?: ExampleApprovalPolicy
  sandboxMode?: CodexSandboxMode
  developerInstructions?: string
  experimentalFeatures: Array<string>
  debugStream: boolean
  upstreamStreamUrl: string
  createdAt: string
  updatedAt: string
}

export interface SessionSummary extends Omit<
  SessionRecord,
  `upstreamStreamUrl`
> {
  active: boolean
  clientStreamUrl: string
}

export interface CreateSessionPayload {
  title?: string
  agent: AgentType
  cwd: string
  model?: string
  permissionMode?: string
  approvalPolicy?: ExampleApprovalPolicy
  sandboxMode?: CodexSandboxMode
  developerInstructions?: string
  experimentalFeatures?: Array<string>
  debugStream?: boolean
}

export interface SessionControlPayload {
  id: string
  action: `resume` | `restart` | `stop`
}
