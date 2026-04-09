import type { NormalizedEvent } from "./normalize/types.js"
import type { CodexApprovalPolicy, CodexSandboxMode } from "./protocol/codex.js"

export type AgentType = `claude` | `codex`

export interface User {
  name: string
  email: string
}

export interface UserMessageIntent {
  type: `user_message`
  text: string
  syntheticKey?: string
  syntheticType?: `approval_response`
}

export interface ControlResponsePayload {
  request_id: string | number
  subtype: `success` | `cancelled`
  response: object
}

export interface ControlResponseIntent {
  type: `control_response`
  response: ControlResponsePayload
}

export interface InterruptIntent {
  type: `interrupt`
}

export type ClientIntent =
  | UserMessageIntent
  | ControlResponseIntent
  | InterruptIntent

export interface AgentEnvelope<TRaw extends object = object> {
  agent: AgentType
  direction: `agent`
  timestamp: number
  raw: TRaw
}

export interface UserEnvelope<TRaw extends object = ClientIntent> {
  agent: AgentType
  direction: `user`
  timestamp: number
  txid?: string
  user: User
  raw: TRaw
}

export type BridgeLifecycleEventType =
  | `session_started`
  | `session_resumed`
  | `session_ended`

export type BridgeDebugEventType =
  | `forwarded_to_agent`
  | `agent_message_received`

export type BridgeEventType = BridgeLifecycleEventType | BridgeDebugEventType

export interface BridgeLifecycleEnvelope {
  agent: AgentType
  direction: `bridge`
  timestamp: number
  type: BridgeLifecycleEventType
}

export interface BridgeForwardDebugEnvelope {
  agent: AgentType
  direction: `bridge`
  timestamp: number
  type: `forwarded_to_agent`
  sequence: number
  source: BridgeForwardSource
  raw: object
}

export interface BridgeAgentDebugEnvelope {
  agent: AgentType
  direction: `bridge`
  timestamp: number
  type: `agent_message_received`
  sequence: number
  raw: object
}

export type BridgeEnvelope =
  | BridgeLifecycleEnvelope
  | BridgeForwardDebugEnvelope
  | BridgeAgentDebugEnvelope

export type StreamEnvelope = AgentEnvelope | UserEnvelope | BridgeEnvelope

export type BridgeForwardSource =
  | `queued_prompt`
  | `client_response`
  | `interrupt`
  | `interrupt_synthesized_response`

export interface BridgeForwardDebugEvent {
  sequence: number
  timestamp: number
  source: BridgeForwardSource
  raw: object
}

export interface BridgeAgentDebugEvent {
  sequence: number
  timestamp: number
  raw: object
}

export interface BridgeDebugHooks {
  /**
   * Advanced diagnostics hook.
   * Intended for tests and bridge-level debugging rather than normal app code.
   */
  onForwardToAgent?: (event: BridgeForwardDebugEvent) => void
  /**
   * Advanced diagnostics hook.
   * Intended for tests and bridge-level debugging rather than normal app code.
   */
  onAgentMessage?: (event: BridgeAgentDebugEvent) => void
}

export interface SessionOptions {
  agent: AgentType
  streamUrl: string
  cwd: string
  contentType?: string
  model?: string
  permissionMode?: string
  approvalPolicy?: CodexApprovalPolicy
  experimentalFeatures?: Record<string, boolean>
  sandboxMode?: CodexSandboxMode
  developerInstructions?: string
  verbose?: boolean
  resume?: boolean
  rewritePaths?: Record<string, string>
  env?: Record<string, string>
  /**
   * Opt-in persisted bridge telemetry.
   * When enabled, extra bridge debug envelopes are appended to the stream.
   */
  debugStream?: boolean
  /**
   * In-memory bridge diagnostics hooks.
   * Useful in tests; most applications should not need this.
   */
  debugHooks?: BridgeDebugHooks
}

export interface Session {
  sessionId: string
  streamUrl: string
  close: () => Promise<void>
}

export interface ClientOptions {
  agent: AgentType
  streamUrl: string
  user: User
  contentType?: string
}

export interface NormalizedAgentStreamEvent {
  direction: `agent`
  envelope: AgentEnvelope
  event: NormalizedEvent
}

export type ClientEvent =
  | NormalizedAgentStreamEvent
  | UserEnvelope
  | BridgeEnvelope

export interface StreamClient {
  prompt: (text: string) => void
  respond: (requestId: string | number, response: object) => void
  cancel: () => void
  events: () => AsyncIterable<ClientEvent>
  close: () => Promise<void>
}
