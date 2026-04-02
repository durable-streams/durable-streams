export interface TextContent {
  type: `text`
  text: string
}

export interface ToolUseContent {
  type: `tool_use`
  id: string
  name: string
  input: object
}

export interface ToolResultContent {
  type: `tool_result`
  toolUseId: string
  output: string
  isError?: boolean
}

export interface ThinkingContent {
  type: `thinking`
  text: string
}

export interface AssistantMessageEvent {
  type: `assistant_message`
  content: Array<
    TextContent | ToolUseContent | ToolResultContent | ThinkingContent
  >
}

export interface StreamDeltaEvent {
  type: `stream_delta`
  delta: {
    kind: `text` | `thinking` | `tool_input`
    text: string
  }
}

export interface ToolCallEvent {
  type: `tool_call`
  id: string
  tool: string
  input: object
}

export interface ToolResultEvent {
  type: `tool_result`
  toolCallId: string
  output: string
  isError?: boolean
}

export interface PermissionRequestEvent {
  type: `permission_request`
  id: string | number
  tool: string
  input: object
}

export interface TurnCompleteEvent {
  type: `turn_complete`
  success: boolean
  cost?: {
    inputTokens?: number
    outputTokens?: number
    totalCost?: number
  }
}

export interface ToolProgressEvent {
  type: `tool_progress`
  toolUseId: string
  elapsed: number
}

export interface SessionInitEvent {
  type: `session_init`
  sessionId?: string
  model?: string
  permissionMode?: string
}

export interface StatusChangeEvent {
  type: `status_change`
  status: string
}

export interface UnknownEvent {
  type: `unknown`
  rawType: string
  raw: object
}

export type NormalizedEvent =
  | AssistantMessageEvent
  | StreamDeltaEvent
  | ToolCallEvent
  | ToolResultEvent
  | PermissionRequestEvent
  | TurnCompleteEvent
  | ToolProgressEvent
  | SessionInitEvent
  | StatusChangeEvent
  | UnknownEvent
