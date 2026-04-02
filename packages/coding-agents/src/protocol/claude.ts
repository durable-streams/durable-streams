export interface ClaudeTextBlock {
  type: `text`
  text: string
}

export interface ClaudeThinkingBlock {
  type: `thinking`
  thinking: string
}

export interface ClaudeToolUseBlock {
  type: `tool_use`
  id: string
  name: string
  input: object
}

export interface ClaudeToolResultTextPart {
  type: `text`
  text: string
}

export interface ClaudeToolResultBlock {
  type: `tool_result`
  tool_use_id: string
  content:
    | string
    | Array<ClaudeToolResultTextPart | Record<string, unknown>>
    | object
  is_error?: boolean
}

export type ClaudeAssistantContentBlock =
  | ClaudeTextBlock
  | ClaudeThinkingBlock
  | ClaudeToolUseBlock
  | ClaudeToolResultBlock

export interface ClaudeUserMessage {
  type: `user`
  message: {
    role: `user`
    content: string | Array<ClaudeTextBlock>
  }
  parent_tool_use_id: string | null
  session_id: string
}

export interface ClaudeInitSystemMessage {
  type: `system`
  subtype: `init`
  session_id: string
  cwd: string
  model?: string
  permissionMode?: string
  tools?: Array<string>
  slash_commands?: Array<string>
  skills?: Array<string>
  agents?: Array<string>
  uuid?: string
  [key: string]: unknown
}

export interface ClaudeHookStartedSystemMessage {
  type: `system`
  subtype: `hook_started`
  hook_id: string
  hook_name: string
  hook_event: string
  uuid?: string
  session_id?: string
}

export interface ClaudeHookResponseSystemMessage {
  type: `system`
  subtype: `hook_response`
  hook_id: string
  hook_name: string
  hook_event: string
  output?: string
  stdout?: string
  stderr?: string
  exit_code?: number
  outcome?: string
  uuid?: string
  session_id?: string
}

export interface ClaudeOtherSystemMessage {
  type: `system`
  subtype: string
  uuid?: string
  session_id?: string
  [key: string]: unknown
}

export type ClaudeSystemMessage =
  | ClaudeInitSystemMessage
  | ClaudeHookStartedSystemMessage
  | ClaudeHookResponseSystemMessage
  | ClaudeOtherSystemMessage

export interface ClaudeAssistantMessage {
  type: `assistant`
  message: {
    model?: string
    id?: string
    type?: `message`
    role?: `assistant`
    content: Array<ClaudeAssistantContentBlock>
    stop_reason?: string | null
    stop_sequence?: string | null
    usage?: Record<string, unknown>
    [key: string]: unknown
  }
  parent_tool_use_id?: string | null
  session_id?: string
  uuid?: string
}

export interface ClaudeTextDelta {
  type: `text_delta`
  text: string
}

export interface ClaudeThinkingDelta {
  type: `thinking_delta`
  thinking: string
}

export interface ClaudeInputJsonDelta {
  type: `input_json_delta`
  partial_json: string
}

export interface ClaudeContentBlockDeltaEvent {
  type: `content_block_delta`
  delta: ClaudeTextDelta | ClaudeThinkingDelta | ClaudeInputJsonDelta
  [key: string]: unknown
}

export interface ClaudeOtherStreamEvent {
  type: string
  [key: string]: unknown
}

export interface ClaudeStreamEventMessage {
  type: `stream_event`
  event: ClaudeContentBlockDeltaEvent | ClaudeOtherStreamEvent
  session_id?: string
  uuid?: string
}

export interface ClaudeToolPermissionRequest {
  subtype: `can_use_tool`
  tool_name: string
  input?: object
}

export interface ClaudeOtherControlRequest {
  subtype: string
  [key: string]: unknown
}

export interface ClaudeControlRequestMessage {
  type: `control_request`
  request_id: string | number
  request: ClaudeToolPermissionRequest | ClaudeOtherControlRequest
  session_id?: string
  uuid?: string
}

export interface ClaudeControlResponsePayload {
  request_id: string | number
  subtype: `success` | `cancelled`
  response: object
}

export interface ClaudeControlResponseMessage {
  type: `control_response`
  response: ClaudeControlResponsePayload
  session_id?: string
  uuid?: string
}

export interface ClaudeResultMessage {
  type: `result`
  subtype: string
  is_error?: boolean
  result?: string
  session_id?: string
  uuid?: string
  usage?: Record<string, unknown>
  [key: string]: unknown
}

export interface ClaudeToolProgressMessage {
  type: `tool_progress`
  tool_use_id: string
  elapsed?: number
  session_id?: string
  uuid?: string
}

export interface ClaudeStatusMessage {
  type: `status` | `status_change`
  status?: string
  subtype?: string
  session_id?: string
  uuid?: string
}

export interface ClaudeKeepAliveMessage {
  type: `keep_alive`
  session_id?: string
  uuid?: string
}

export interface ClaudeRateLimitEventMessage {
  type: `rate_limit_event`
  rate_limit_info?: Record<string, unknown>
  session_id?: string
  uuid?: string
}

export interface ClaudeStreamlinedTextMessage {
  type: `streamlined_text`
  text?: string
  session_id?: string
  uuid?: string
}

export interface ClaudeStreamlinedToolUseSummaryMessage {
  type: `streamlined_tool_use_summary`
  summary?: string
  session_id?: string
  uuid?: string
}

export type ClaudeWireMessage =
  | ClaudeUserMessage
  | ClaudeSystemMessage
  | ClaudeAssistantMessage
  | ClaudeStreamEventMessage
  | ClaudeControlRequestMessage
  | ClaudeControlResponseMessage
  | ClaudeResultMessage
  | ClaudeToolProgressMessage
  | ClaudeStatusMessage
  | ClaudeKeepAliveMessage
  | ClaudeRateLimitEventMessage
  | ClaudeStreamlinedTextMessage
  | ClaudeStreamlinedToolUseSummaryMessage
