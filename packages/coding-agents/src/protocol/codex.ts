export type CodexRequestId = string | number

export interface CodexJsonRpcRequest<
  TMethod extends string = string,
  TParams = unknown,
> {
  jsonrpc?: `2.0`
  id: CodexRequestId
  method: TMethod
  params: TParams
}

export interface CodexJsonRpcNotification<
  TMethod extends string = string,
  TParams = unknown,
> {
  jsonrpc?: `2.0`
  method: TMethod
  params: TParams
}

export interface CodexJsonRpcResult<
  TId extends CodexRequestId = CodexRequestId,
> {
  jsonrpc?: `2.0`
  id: TId
  result: unknown
}

export interface CodexJsonRpcError<
  TId extends CodexRequestId = CodexRequestId,
> {
  jsonrpc?: `2.0`
  id: TId
  error: {
    code: number
    message: string
    data?: unknown
  }
}

export interface CodexClientInfo {
  name: string
  title: string | null
  version: string
}

export interface CodexInitializeRequest extends CodexJsonRpcRequest<
  `initialize`,
  {
    clientInfo: CodexClientInfo
    capabilities: object | null
  }
> {}

export interface CodexThreadStartRequest extends CodexJsonRpcRequest<
  `thread/start`,
  {
    model?: string | null
    cwd?: string | null
    approvalPolicy?: `untrusted` | `on-failure` | `on-request` | `never`
    sandbox?: `read-only` | `workspace-write` | `danger-full-access` | null
    developerInstructions?: string | null
    ephemeral?: boolean | null
    experimentalRawEvents: boolean
    persistExtendedHistory: boolean
  }
> {}

export interface CodexThreadResumeRequest extends CodexJsonRpcRequest<
  `thread/resume`,
  {
    threadId: string
    model?: string | null
    cwd?: string | null
    approvalPolicy?: `untrusted` | `on-failure` | `on-request` | `never`
    sandbox?: `read-only` | `workspace-write` | `danger-full-access` | null
    developerInstructions?: string | null
    persistExtendedHistory: boolean
  }
> {}

export interface CodexTextInput {
  type: `text`
  text: string
  text_elements: Array<{
    kind?: string
    [key: string]: unknown
  }>
}

export interface CodexTurnStartRequest extends CodexJsonRpcRequest<
  `turn/start`,
  {
    threadId: string
    input: Array<CodexTextInput>
    cwd?: string | null
    approvalPolicy?: `untrusted` | `on-failure` | `on-request` | `never`
  }
> {}

export interface CodexTurnInterruptRequest extends CodexJsonRpcRequest<
  `turn/interrupt`,
  {
    threadId: string
    turnId: string
  }
> {}

export type CodexAppServerClientRequest =
  | CodexInitializeRequest
  | CodexThreadStartRequest
  | CodexThreadResumeRequest
  | CodexTurnStartRequest
  | CodexTurnInterruptRequest

export interface CodexThreadSummary {
  id: string
  title?: string | null
  status?: string
  cwd?: string | null
  turns?: Array<CodexTurnSummary>
  [key: string]: unknown
}

export interface CodexTurnSummary {
  id: string
  status: `completed` | `interrupted` | `failed` | `inProgress`
  items: Array<CodexThreadItem>
  error?: object | null
}

export interface CodexUserMessageItem {
  type: `userMessage`
  id: string
  content: Array<CodexTextInput>
}

export interface CodexAgentMessageItem {
  type: `agentMessage`
  id: string
  text: string
  phase?: string | null
  memoryCitation?: object | null
}

export interface CodexReasoningItem {
  type: `reasoning`
  id: string
  summary?: Array<string>
  content?: Array<string>
}

export interface CodexCommandExecutionItem {
  type: `commandExecution`
  id: string
  command: string
  cwd: string
  processId?: string | null
  status?: string
  aggregatedOutput?: string | null
  exitCode?: number | null
  durationMs?: number | null
}

export interface CodexFileChangeItem {
  type: `fileChange`
  id: string
  changes: Array<object>
  status?: string
}

export interface CodexMcpToolCallItem {
  type: `mcpToolCall`
  id: string
  server: string
  tool: string
  arguments: object
  status?: string
  result?: object | null
  error?: object | null
  durationMs?: number | null
}

export interface CodexDynamicToolCallItem {
  type: `dynamicToolCall`
  id: string
  tool: string
  arguments: object
  status?: string
  contentItems?: Array<object> | null
  success?: boolean | null
  durationMs?: number | null
}

export type CodexThreadItem =
  | CodexUserMessageItem
  | CodexAgentMessageItem
  | CodexReasoningItem
  | CodexCommandExecutionItem
  | CodexFileChangeItem
  | CodexMcpToolCallItem
  | CodexDynamicToolCallItem
  | ({
      type: string
      id: string
      [key: string]: unknown
    } & Record<string, unknown>)

export interface CodexThreadStartedNotification extends CodexJsonRpcNotification<
  `thread/started`,
  {
    thread: CodexThreadSummary
  }
> {}

export interface CodexThreadStatusChangedNotification extends CodexJsonRpcNotification<
  `thread/status/changed`,
  {
    threadId: string
    status: string
  }
> {}

export interface CodexTurnStartedNotification extends CodexJsonRpcNotification<
  `turn/started`,
  {
    threadId: string
    turn: CodexTurnSummary
  }
> {}

export interface CodexAgentMessageDeltaNotification extends CodexJsonRpcNotification<
  `item/agentMessage/delta`,
  {
    threadId: string
    turnId: string
    itemId: string
    delta: string
  }
> {}

export interface CodexReasoningTextDeltaNotification extends CodexJsonRpcNotification<
  `item/reasoning/textDelta`,
  {
    threadId: string
    turnId: string
    itemId: string
    delta: string
    contentIndex: number
  }
> {}

export interface CodexCommandExecutionOutputDeltaNotification extends CodexJsonRpcNotification<
  `item/commandExecution/outputDelta`,
  {
    threadId: string
    turnId: string
    itemId: string
    delta: string
  }
> {}

export interface CodexFileChangeOutputDeltaNotification extends CodexJsonRpcNotification<
  `item/fileChange/outputDelta`,
  {
    threadId: string
    turnId: string
    itemId: string
    delta: string
  }
> {}

export interface CodexItemCompletedNotification extends CodexJsonRpcNotification<
  `item/completed`,
  {
    threadId: string
    turnId: string
    item: CodexThreadItem
  }
> {}

export interface CodexTurnCompletedNotification extends CodexJsonRpcNotification<
  `turn/completed`,
  {
    threadId: string
    turn: CodexTurnSummary
  }
> {}

export interface CodexServerRequestResolvedNotification extends CodexJsonRpcNotification<
  `serverRequest/resolved`,
  {
    threadId: string
    turnId?: string
    requestId: CodexRequestId
    [key: string]: unknown
  }
> {}

export type CodexAppServerNotification =
  | CodexThreadStartedNotification
  | CodexThreadStatusChangedNotification
  | CodexTurnStartedNotification
  | CodexAgentMessageDeltaNotification
  | CodexReasoningTextDeltaNotification
  | CodexCommandExecutionOutputDeltaNotification
  | CodexFileChangeOutputDeltaNotification
  | CodexItemCompletedNotification
  | CodexTurnCompletedNotification
  | CodexServerRequestResolvedNotification
  | CodexJsonRpcNotification

export interface CodexCommandExecutionApprovalRequest extends CodexJsonRpcRequest<
  `item/commandExecution/requestApproval`,
  {
    threadId: string
    turnId: string
    itemId: string
    approvalId?: string | null
    reason?: string | null
    command?: string | null
    cwd?: string | null
    availableDecisions?: Array<
      | `accept`
      | `acceptForSession`
      | `decline`
      | `cancel`
      | Record<string, unknown>
    > | null
  }
> {}

export interface CodexFileChangeApprovalRequest extends CodexJsonRpcRequest<
  `item/fileChange/requestApproval`,
  {
    threadId: string
    turnId: string
    itemId: string
    reason?: string | null
    grantRoot?: string | null
  }
> {}

export interface CodexPermissionsApprovalRequest extends CodexJsonRpcRequest<
  `item/permissions/requestApproval`,
  {
    threadId: string
    turnId: string
    itemId: string
    reason?: string | null
    permissions: object
  }
> {}

export interface CodexToolRequestUserInputRequest extends CodexJsonRpcRequest<
  `item/tool/requestUserInput`,
  {
    threadId: string
    turnId: string
    callId: string
    tool: string
    question: string
    [key: string]: unknown
  }
> {}

export interface CodexDynamicToolCallRequest extends CodexJsonRpcRequest<
  `item/tool/call`,
  {
    threadId: string
    turnId: string
    callId: string
    tool: string
    arguments: object
  }
> {}

export type CodexAppServerServerRequest =
  | CodexCommandExecutionApprovalRequest
  | CodexFileChangeApprovalRequest
  | CodexPermissionsApprovalRequest
  | CodexToolRequestUserInputRequest
  | CodexDynamicToolCallRequest
  | CodexJsonRpcRequest

export type CodexAppServerResponse = CodexJsonRpcResult | CodexJsonRpcError

export type CodexAppServerMessage =
  | CodexAppServerClientRequest
  | CodexAppServerServerRequest
  | CodexAppServerNotification
  | CodexAppServerResponse

export interface CodexExecThreadStartedEvent {
  type: `thread.started`
  thread_id: string
}

export interface CodexExecTurnStartedEvent {
  type: `turn.started`
}

export interface CodexExecAgentMessageItem {
  id: string
  type: `agent_message`
  text: string
}

export interface CodexExecReasoningItem {
  id: string
  type: `reasoning`
  text?: string
  summary?: string
}

export interface CodexExecCommandExecutionItem {
  id: string
  type: `command_execution`
  command?: string
  output?: string
  exit_code?: number | null
}

export type CodexExecItem =
  | CodexExecAgentMessageItem
  | CodexExecReasoningItem
  | CodexExecCommandExecutionItem
  | ({
      id: string
      type: string
      [key: string]: unknown
    } & Record<string, unknown>)

export interface CodexExecItemCompletedEvent {
  type: `item.completed`
  item: CodexExecItem
}

export interface CodexExecTurnCompletedEvent {
  type: `turn.completed`
  usage?: {
    input_tokens?: number
    cached_input_tokens?: number
    output_tokens?: number
    [key: string]: unknown
  }
}

export type CodexExecEvent =
  | CodexExecThreadStartedEvent
  | CodexExecTurnStartedEvent
  | CodexExecItemCompletedEvent
  | CodexExecTurnCompletedEvent
