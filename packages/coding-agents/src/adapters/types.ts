import type { AgentType, ClientIntent, StreamEnvelope } from "../types.js"
import type {
  CodexApprovalPolicy,
  CodexSandboxMode,
} from "../protocol/codex.js"

export interface SpawnOptions {
  cwd: string
  model?: string
  permissionMode?: string
  approvalPolicy?: CodexApprovalPolicy
  sandboxMode?: CodexSandboxMode
  developerInstructions?: string
  verbose?: boolean
  resume?: string
  env?: Record<string, string>
}

export interface AgentConnection {
  onMessage: (handler: (raw: object) => void) => void
  send: (raw: object) => void
  kill: () => void
  on: (event: `exit`, handler: (code: number | null) => void) => void
}

export interface MessageClassification {
  type: `request` | `response` | `notification`
  id?: string | number
}

export interface ResumeOptions {
  cwd: string
  rewritePaths?: Record<string, string>
}

export interface AgentAdapter {
  readonly agentType: AgentType

  spawn: (options: SpawnOptions) => Promise<AgentConnection>

  parseDirection: (raw: object) => MessageClassification

  isTurnComplete: (raw: object) => boolean

  translateClientIntent: (raw: ClientIntent) => object

  prepareResume: (
    history: Array<StreamEnvelope>,
    options: ResumeOptions
  ) => Promise<{ resumeId: string }>
}
