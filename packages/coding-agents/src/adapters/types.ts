import type { AgentType, ClientIntent, StreamEnvelope, User } from "../types.js"
import type {
  CodexApprovalPolicy,
  CodexSandboxMode,
} from "../protocol/codex.js"

export interface SpawnOptions {
  cwd: string
  rewritePaths?: Record<string, string>
  model?: string
  permissionMode?: string
  approvalPolicy?: CodexApprovalPolicy
  experimentalFeatures?: Record<string, boolean>
  sandboxMode?: CodexSandboxMode
  developerInstructions?: string
  verbose?: boolean
  resume?: string
  forceSeedWorkspace?: boolean
  resumeTranscriptSourcePath?: string
  env?: Record<string, string>
}

export interface AgentConnection {
  onMessage: (handler: (raw: object) => void) => void
  send: (raw: object) => void
  close?: () => void
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

export interface PreparedResume {
  resumeId: string
  forceSeedWorkspace?: boolean
  resumeTranscriptSourcePath?: string
}

export interface AgentAdapter {
  readonly agentType: AgentType

  spawn: (options: SpawnOptions) => Promise<AgentConnection>

  isReadyMessage?: (raw: object) => boolean

  parseDirection: (raw: object) => MessageClassification

  isTurnComplete: (raw: object) => boolean

  translateClientIntent: (raw: ClientIntent, user?: User) => object

  prepareResume: (
    history: Array<StreamEnvelope>,
    options: ResumeOptions
  ) => Promise<PreparedResume>
}
