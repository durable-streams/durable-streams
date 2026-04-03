import { ClaudeAdapter } from "./adapters/claude.js"
import { CodexAdapter } from "./adapters/codex.js"
import { startBridge } from "./bridge.js"
import type { Session, SessionOptions } from "./types.js"

export { startBridge } from "./bridge.js"
export type { BridgeOptions } from "./bridge.js"

export async function createSession(options: SessionOptions): Promise<Session> {
  const { agent, ...rest } = options
  const adapter = agent === `claude` ? new ClaudeAdapter() : new CodexAdapter()
  return startBridge({
    adapter,
    ...rest,
  })
}

export { ClaudeAdapter } from "./adapters/claude.js"
export { CodexAdapter } from "./adapters/codex.js"
export type {
  CodexApprovalPolicy,
  ClaudeAssistantContentBlock,
  ClaudeAssistantMessage,
  ClaudeContentBlockDeltaEvent,
  ClaudeControlRequestMessage,
  ClaudeControlResponseMessage,
  ClaudeHookResponseSystemMessage,
  ClaudeHookStartedSystemMessage,
  ClaudeInitSystemMessage,
  ClaudeRateLimitEventMessage,
  ClaudeResultMessage,
  ClaudeStatusMessage,
  ClaudeStreamEventMessage,
  ClaudeSystemMessage,
  ClaudeToolProgressMessage,
  ClaudeUserMessage,
  ClaudeWireMessage,
  CodexAgentMessageDeltaNotification,
  CodexAppServerClientRequest,
  CodexAppServerMessage,
  CodexAppServerNotification,
  CodexAppServerResponse,
  CodexAppServerServerRequest,
  CodexCommandExecutionApprovalRequest,
  CodexExecEvent,
  CodexExecItem,
  CodexExecTurnCompletedEvent,
  CodexFileChangeApprovalRequest,
  CodexInitializeCapabilities,
  CodexInitializeRequest,
  CodexItemCompletedNotification,
  CodexJsonRpcError,
  CodexJsonRpcNotification,
  CodexJsonRpcRequest,
  CodexJsonRpcResult,
  CodexPermissionsApprovalRequest,
  CodexRequestId,
  CodexSandboxMode,
  CodexThreadItem,
  CodexThreadResumeRequest,
  CodexThreadStartRequest,
  CodexTurnCompletedNotification,
  CodexTurnInterruptRequest,
  CodexTurnStartRequest,
} from "./protocol/index.js"

export type {
  AgentAdapter,
  AgentConnection,
  MessageClassification,
  ResumeOptions,
  SpawnOptions,
} from "./adapters/types.js"

export type {
  AgentEnvelope,
  AgentType,
  BridgeAgentDebugEvent,
  BridgeDebugHooks,
  BridgeEnvelope,
  BridgeEventType,
  BridgeForwardDebugEvent,
  BridgeForwardSource,
  ClientEvent,
  ClientIntent,
  ClientOptions,
  ControlResponseIntent,
  ControlResponsePayload,
  InterruptIntent,
  NormalizedAgentStreamEvent,
  Session,
  SessionOptions,
  StreamClient,
  StreamEnvelope,
  User,
  UserEnvelope,
  UserMessageIntent,
} from "./types.js"
