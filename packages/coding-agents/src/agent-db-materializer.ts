import { normalizeClaude } from "./normalize/claude.js"
import { normalizeCodex } from "./normalize/codex.js"
import {
  createAgentDBParticipantId,
  createAgentDBRowId,
  createAgentDBTxRowId,
  normalizeAgentDBProvider,
  normalizeAgentDBTimestamp,
} from "./agent-db-normalize.js"
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
import type { NormalizedEvent } from "./normalize/types.js"
import type {
  AgentEnvelope,
  BridgeEnvelope,
  StreamEnvelope,
  UserEnvelope,
} from "./types.js"

type CollectionName =
  | `sessions`
  | `participants`
  | `messages`
  | `message_parts`
  | `turns`
  | `tool_calls`
  | `permission_requests`
  | `approval_responses`
  | `session_events`
  | `debug_events`

type CollectionRowMap = {
  sessions: SessionRow
  participants: ParticipantRow
  messages: MessageRow
  message_parts: MessagePartRow
  turns: TurnRow
  tool_calls: ToolCallRow
  permission_requests: PermissionRequestRow
  approval_responses: ApprovalResponseRow
  session_events: SessionEventRow
  debug_events: DebugEventRow
}

interface QueuedTurn {
  id: string
  promptMessageId: string
  createdAt: string
}

interface ActiveTurn {
  id: string
  promptMessageId: string
  startedAt: string
}

export interface AgentDBMaterializerState {
  queuedTurns: Array<QueuedTurn>
  activeTurn?: ActiveTurn
  activeAssistantMessageId?: string
  activeAssistantStartedAt?: string
  nextAssistantPartIndex: number
  activeAssistantHasDelta: boolean
  toolCallIdsByProviderId: Record<string, string>
  lastToolCallId?: string
  resolvedRequestIds: Record<string, string>
}

export interface AgentDBMaterializeParams {
  streamId: string
  envelope: StreamEnvelope
  sequence: number
}

export interface AgentDBMutation<
  TCollection extends CollectionName = CollectionName,
> {
  collection: TCollection
  value: CollectionRowMap[TCollection]
}

export function createAgentDBMaterializerState(): AgentDBMaterializerState {
  return {
    queuedTurns: [],
    nextAssistantPartIndex: 0,
    activeAssistantHasDelta: false,
    toolCallIdsByProviderId: {},
    resolvedRequestIds: {},
  }
}

function normalizeApprovalDecision(
  envelope: UserEnvelope
): Pick<ApprovalResponseRow, `decision` | `message` | `updatedInput`> | null {
  if (envelope.raw.type !== `control_response`) {
    return null
  }

  if (envelope.raw.response.subtype === `cancelled`) {
    return {
      decision: `cancelled`,
    }
  }

  const response = envelope.raw.response.response as Record<string, unknown>
  const behavior =
    typeof response.behavior === `string` ? response.behavior : undefined

  if (behavior === `deny`) {
    return {
      decision: `denied`,
      message:
        typeof response.message === `string` ? response.message : undefined,
      updatedInput: response.updatedInput,
    }
  }

  return {
    decision: `approved`,
    message:
      typeof response.message === `string` ? response.message : undefined,
    updatedInput: response.updatedInput,
  }
}

function normalizeAgentEvent(envelope: AgentEnvelope): NormalizedEvent | null {
  return envelope.agent === `claude`
    ? normalizeClaude(envelope.raw)
    : normalizeCodex(envelope.raw)
}

function createSessionUpsert(
  streamId: string,
  timestamp: number,
  status?: string
): AgentDBMutation<`sessions`> {
  return {
    collection: `sessions`,
    value: {
      id: streamId,
      streamId,
      status: status ?? `active`,
      lastEventAt: normalizeAgentDBTimestamp(timestamp),
    },
  }
}

function maybeStartQueuedTurn(
  state: AgentDBMaterializerState,
  streamId: string,
  timestamp: number
): Array<AgentDBMutation> {
  if (state.activeTurn || state.queuedTurns.length === 0) {
    return []
  }

  const next = state.queuedTurns.shift()
  if (!next) {
    return []
  }

  const startedAt = normalizeAgentDBTimestamp(timestamp)
  state.activeTurn = {
    id: next.id,
    promptMessageId: next.promptMessageId,
    startedAt,
  }

  return [
    {
      collection: `turns`,
      value: {
        id: next.id,
        sessionId: streamId,
        promptMessageId: next.promptMessageId,
        status: `active`,
        startedAt,
      },
    },
  ]
}

function ensureAssistantMessage(
  state: AgentDBMaterializerState,
  params: AgentDBMaterializeParams,
  envelope: AgentEnvelope,
  status: `streaming` | `completed`
): Array<AgentDBMutation> {
  if (state.activeAssistantMessageId) {
    return []
  }

  const createdAt = normalizeAgentDBTimestamp(envelope.timestamp)
  const messageId = createAgentDBRowId(params.sequence, `assistant`)
  state.activeAssistantMessageId = messageId
  state.activeAssistantStartedAt = createdAt
  state.nextAssistantPartIndex = 0
  state.activeAssistantHasDelta = false

  return [
    {
      collection: `messages`,
      value: {
        id: messageId,
        sessionId: params.streamId,
        turnId: state.activeTurn?.id,
        role: `assistant`,
        provider: normalizeAgentDBProvider(envelope.agent),
        kind: `assistant_message`,
        createdAt,
        completedAt: status === `completed` ? createdAt : undefined,
        status,
      },
    },
  ]
}

function appendAssistantPart(
  state: AgentDBMaterializerState,
  params: AgentDBMaterializeParams,
  messageId: string,
  kind: string,
  timestamp: number,
  options: {
    text?: string
    json?: unknown
    providerPartType?: string
    deltaIndex?: number
  } = {}
): AgentDBMutation<`message_parts`> {
  const partIndex = state.nextAssistantPartIndex++
  return {
    collection: `message_parts`,
    value: {
      id: createAgentDBRowId(params.sequence, `assistant-part:${partIndex}`),
      messageId,
      sessionId: params.streamId,
      partIndex,
      deltaIndex: options.deltaIndex,
      kind,
      text: options.text,
      json: options.json,
      providerPartType: options.providerPartType,
      createdAt: normalizeAgentDBTimestamp(timestamp),
    },
  }
}

function finalizeAssistantMessage(
  state: AgentDBMaterializerState,
  params: AgentDBMaterializeParams,
  envelope: AgentEnvelope,
  timestamp: number,
  status: `completed` | `failed`
): Array<AgentDBMutation> {
  if (!state.activeAssistantMessageId) {
    return []
  }

  const messageId = state.activeAssistantMessageId
  const mutations: Array<AgentDBMutation> = [
    {
      collection: `messages`,
      value: {
        id: messageId,
        sessionId: params.streamId,
        turnId: state.activeTurn?.id,
        role: `assistant`,
        provider: normalizeAgentDBProvider(envelope.agent),
        kind: `assistant_message`,
        createdAt:
          state.activeAssistantStartedAt ??
          normalizeAgentDBTimestamp(timestamp),
        completedAt: normalizeAgentDBTimestamp(timestamp),
        status,
      },
    },
  ]

  state.activeAssistantMessageId = undefined
  state.activeAssistantStartedAt = undefined
  state.nextAssistantPartIndex = 0
  state.activeAssistantHasDelta = false

  return mutations
}

function materializeUserEnvelope(
  state: AgentDBMaterializerState,
  params: AgentDBMaterializeParams,
  envelope: UserEnvelope
): Array<AgentDBMutation> {
  const participantId = createAgentDBParticipantId(envelope.user)
  const mutations: Array<AgentDBMutation> = [
    createSessionUpsert(params.streamId, envelope.timestamp),
    {
      collection: `participants`,
      value: {
        id: participantId,
        sessionId: params.streamId,
        name: envelope.user.name,
        email: envelope.user.email,
        firstSeenAt: normalizeAgentDBTimestamp(envelope.timestamp),
        lastSeenAt: normalizeAgentDBTimestamp(envelope.timestamp),
      },
    },
  ]

  if (envelope.raw.type === `user_message`) {
    const messageId = envelope.txid
      ? createAgentDBTxRowId(envelope.txid, `message`)
      : createAgentDBRowId(params.sequence, `message`)
    const turnId = envelope.txid
      ? createAgentDBTxRowId(envelope.txid, `turn`)
      : createAgentDBRowId(params.sequence, `turn`)

    mutations.push(
      {
        collection: `messages`,
        value: {
          id: messageId,
          sessionId: params.streamId,
          turnId,
          participantId,
          role: `user`,
          provider: normalizeAgentDBProvider(envelope.agent),
          kind: `user_message`,
          syntheticType: envelope.raw.syntheticType,
          createdAt: normalizeAgentDBTimestamp(envelope.timestamp),
          completedAt: normalizeAgentDBTimestamp(envelope.timestamp),
          status: `completed`,
        },
      },
      {
        collection: `message_parts`,
        value: {
          id: envelope.txid
            ? createAgentDBTxRowId(envelope.txid, `part:0`)
            : createAgentDBRowId(params.sequence, `part:0`),
          messageId,
          sessionId: params.streamId,
          partIndex: 0,
          kind: `text`,
          text: envelope.raw.text,
          createdAt: normalizeAgentDBTimestamp(envelope.timestamp),
        },
      },
      {
        collection: `turns`,
        value: {
          id: turnId,
          sessionId: params.streamId,
          promptMessageId: messageId,
          status: `queued`,
          startedAt: normalizeAgentDBTimestamp(envelope.timestamp),
        },
      }
    )

    state.queuedTurns.push({
      id: turnId,
      promptMessageId: messageId,
      createdAt: normalizeAgentDBTimestamp(envelope.timestamp),
    })
  }

  if (envelope.raw.type === `control_response`) {
    const requestId = String(envelope.raw.response.request_id)
    const responseId = envelope.txid
      ? createAgentDBTxRowId(envelope.txid, `approval-response`)
      : createAgentDBRowId(params.sequence, `approval-response`)
    const resolution = normalizeApprovalDecision(envelope)

    if (resolution) {
      const effectiveResponseId = state.resolvedRequestIds[requestId]
      const effective = effectiveResponseId == null

      if (effective) {
        state.resolvedRequestIds[requestId] = responseId
      }

      mutations.push({
        collection: `approval_responses`,
        value: {
          id: responseId,
          sessionId: params.streamId,
          requestId,
          participantId,
          decision: resolution.decision,
          message: resolution.message,
          updatedInput: resolution.updatedInput,
          effective,
          ignoredReason: effective ? undefined : `request_already_resolved`,
          createdAt: normalizeAgentDBTimestamp(envelope.timestamp),
        },
      })

      if (effective) {
        mutations.push({
          collection: `permission_requests`,
          value: {
            id: requestId,
            sessionId: params.streamId,
            status: resolution.decision,
            resolvedAt: normalizeAgentDBTimestamp(envelope.timestamp),
            resolvedByParticipantId: participantId,
            effectiveResponseId: responseId,
          },
        })
      }
    }
  }

  return mutations
}

function materializeBridgeEnvelope(
  params: AgentDBMaterializeParams,
  envelope: BridgeEnvelope
): Array<AgentDBMutation> {
  const mutations: Array<AgentDBMutation> = [
    createSessionUpsert(
      params.streamId,
      envelope.timestamp,
      envelope.type === `session_ended`
        ? `ended`
        : envelope.type === `session_resumed`
          ? `resumed`
          : `started`
    ),
  ]

  if (
    envelope.type === `session_started` ||
    envelope.type === `session_resumed` ||
    envelope.type === `session_ended`
  ) {
    mutations.push({
      collection: `session_events`,
      value: {
        id: createAgentDBRowId(params.sequence, envelope.type),
        sessionId: params.streamId,
        kind: envelope.type,
        createdAt: normalizeAgentDBTimestamp(envelope.timestamp),
      },
    })
  } else {
    mutations.push({
      collection: `debug_events`,
      value: {
        id: createAgentDBRowId(params.sequence, envelope.type),
        sessionId: params.streamId,
        kind: envelope.type,
        data: `raw` in envelope ? envelope.raw : undefined,
        createdAt: normalizeAgentDBTimestamp(envelope.timestamp),
      },
    })
  }

  return mutations
}

function materializeAssistantMessage(
  state: AgentDBMaterializerState,
  params: AgentDBMaterializeParams,
  envelope: AgentEnvelope,
  event: Extract<NormalizedEvent, { type: `assistant_message` }>
): Array<AgentDBMutation> {
  const hadActiveAssistant = state.activeAssistantMessageId != null
  const mutations: Array<AgentDBMutation> = [
    createSessionUpsert(params.streamId, envelope.timestamp),
    ...maybeStartQueuedTurn(state, params.streamId, envelope.timestamp),
    ...ensureAssistantMessage(
      state,
      params,
      envelope,
      hadActiveAssistant ? `streaming` : `completed`
    ),
  ]

  const messageId =
    state.activeAssistantMessageId ??
    createAgentDBRowId(params.sequence, `assistant`)

  for (const part of event.content) {
    if (
      state.activeAssistantHasDelta &&
      (part.type === `text` || part.type === `thinking`)
    ) {
      continue
    }

    mutations.push(
      appendAssistantPart(
        state,
        params,
        messageId,
        part.type,
        envelope.timestamp,
        {
          text:
            part.type === `text`
              ? part.text
              : part.type === `thinking`
                ? part.text
                : part.type === `tool_result`
                  ? part.output
                  : undefined,
          json:
            part.type === `tool_use`
              ? { id: part.id, name: part.name, input: part.input }
              : part.type === `tool_result`
                ? { toolUseId: part.toolUseId, isError: part.isError }
                : undefined,
          providerPartType: part.type,
        }
      )
    )

    if (part.type === `tool_use`) {
      const toolCallId = createAgentDBRowId(
        params.sequence,
        `tool-call:${state.nextAssistantPartIndex - 1}`
      )
      state.toolCallIdsByProviderId[part.id] = toolCallId
      state.lastToolCallId = toolCallId
      mutations.push({
        collection: `tool_calls`,
        value: {
          id: toolCallId,
          sessionId: params.streamId,
          turnId: state.activeTurn?.id,
          messageId,
          toolName: part.name,
          providerToolType: `tool_use`,
          status: `requested`,
          input: part.input,
          startedAt: normalizeAgentDBTimestamp(envelope.timestamp),
        },
      })
    }

    if (part.type === `tool_result`) {
      const toolCallId =
        state.toolCallIdsByProviderId[part.toolUseId] ??
        createAgentDBRowId(params.sequence, `tool-result`)
      state.lastToolCallId = toolCallId
      mutations.push({
        collection: `tool_calls`,
        value: {
          id: toolCallId,
          sessionId: params.streamId,
          turnId: state.activeTurn?.id,
          messageId,
          toolName: `tool`,
          providerToolType: `tool_result`,
          status: part.isError ? `failed` : `completed`,
          output: part.output,
          error: part.isError ? part.output : undefined,
          completedAt: normalizeAgentDBTimestamp(envelope.timestamp),
        },
      })
    }
  }

  if (hadActiveAssistant) {
    mutations.push(
      ...finalizeAssistantMessage(
        state,
        params,
        envelope,
        envelope.timestamp,
        `completed`
      )
    )
  } else {
    state.activeAssistantMessageId = undefined
    state.activeAssistantStartedAt = undefined
    state.nextAssistantPartIndex = 0
    state.activeAssistantHasDelta = false
  }

  return mutations
}

function materializeStreamDelta(
  state: AgentDBMaterializerState,
  params: AgentDBMaterializeParams,
  envelope: AgentEnvelope,
  event: Extract<NormalizedEvent, { type: `stream_delta` }>
): Array<AgentDBMutation> {
  const mutations: Array<AgentDBMutation> = [
    createSessionUpsert(params.streamId, envelope.timestamp),
    ...maybeStartQueuedTurn(state, params.streamId, envelope.timestamp),
    ...ensureAssistantMessage(state, params, envelope, `streaming`),
  ]

  const messageId = state.activeAssistantMessageId
  if (!messageId) {
    return mutations
  }

  const deltaIndex = state.nextAssistantPartIndex
  state.activeAssistantHasDelta = true
  mutations.push(
    appendAssistantPart(
      state,
      params,
      messageId,
      event.delta.kind,
      envelope.timestamp,
      {
        text: event.delta.text,
        providerPartType: event.delta.kind,
        deltaIndex,
      }
    )
  )

  return mutations
}

function materializeToolCall(
  state: AgentDBMaterializerState,
  params: AgentDBMaterializeParams,
  envelope: AgentEnvelope,
  event: Extract<NormalizedEvent, { type: `tool_call` }>
): Array<AgentDBMutation> {
  const mutations: Array<AgentDBMutation> = [
    createSessionUpsert(params.streamId, envelope.timestamp),
    ...maybeStartQueuedTurn(state, params.streamId, envelope.timestamp),
  ]

  const toolCallId = createAgentDBRowId(params.sequence, `tool-call`)
  state.toolCallIdsByProviderId[event.id] = toolCallId
  state.lastToolCallId = toolCallId

  mutations.push({
    collection: `tool_calls`,
    value: {
      id: toolCallId,
      sessionId: params.streamId,
      turnId: state.activeTurn?.id,
      toolName: event.tool,
      providerToolType: event.tool,
      status: `completed`,
      input: event.input,
      startedAt: normalizeAgentDBTimestamp(envelope.timestamp),
      completedAt: normalizeAgentDBTimestamp(envelope.timestamp),
    },
  })

  return mutations
}

function materializeToolResult(
  state: AgentDBMaterializerState,
  params: AgentDBMaterializeParams,
  envelope: AgentEnvelope,
  event: Extract<NormalizedEvent, { type: `tool_result` }>
): Array<AgentDBMutation> {
  const toolCallId =
    state.toolCallIdsByProviderId[event.toolCallId] ??
    createAgentDBRowId(params.sequence, `tool-result`)
  state.lastToolCallId = toolCallId

  return [
    createSessionUpsert(params.streamId, envelope.timestamp),
    ...maybeStartQueuedTurn(state, params.streamId, envelope.timestamp),
    {
      collection: `tool_calls`,
      value: {
        id: toolCallId,
        sessionId: params.streamId,
        turnId: state.activeTurn?.id,
        toolName: `tool`,
        providerToolType: `tool_result`,
        status: event.isError ? `failed` : `completed`,
        output: event.output,
        error: event.isError ? event.output : undefined,
        completedAt: normalizeAgentDBTimestamp(envelope.timestamp),
      },
    },
  ]
}

function materializePermissionRequest(
  state: AgentDBMaterializerState,
  params: AgentDBMaterializeParams,
  envelope: AgentEnvelope,
  event: Extract<NormalizedEvent, { type: `permission_request` }>
): Array<AgentDBMutation> {
  return [
    createSessionUpsert(params.streamId, envelope.timestamp),
    ...maybeStartQueuedTurn(state, params.streamId, envelope.timestamp),
    {
      collection: `permission_requests`,
      value: {
        id: String(event.id),
        sessionId: params.streamId,
        turnId: state.activeTurn?.id,
        toolCallId: state.lastToolCallId,
        providerRequestId: String(event.id),
        toolName: event.tool,
        input: event.input,
        status: `pending`,
        requestedAt: normalizeAgentDBTimestamp(envelope.timestamp),
      },
    },
  ]
}

function materializeToolProgress(
  state: AgentDBMaterializerState,
  params: AgentDBMaterializeParams,
  envelope: AgentEnvelope,
  event: Extract<NormalizedEvent, { type: `tool_progress` }>
): Array<AgentDBMutation> {
  const toolCallId = state.toolCallIdsByProviderId[event.toolUseId]
  if (!toolCallId) {
    return [createSessionUpsert(params.streamId, envelope.timestamp)]
  }

  return [
    createSessionUpsert(params.streamId, envelope.timestamp),
    {
      collection: `tool_calls`,
      value: {
        id: toolCallId,
        sessionId: params.streamId,
        turnId: state.activeTurn?.id,
        toolName: `tool`,
        providerToolType: `tool_progress`,
        status: `running`,
        durationMs: Number.isFinite(event.elapsed) ? event.elapsed : undefined,
      },
    },
  ]
}

function materializeTurnComplete(
  state: AgentDBMaterializerState,
  params: AgentDBMaterializeParams,
  envelope: AgentEnvelope,
  event: Extract<NormalizedEvent, { type: `turn_complete` }>
): Array<AgentDBMutation> {
  const mutations: Array<AgentDBMutation> = [
    createSessionUpsert(params.streamId, envelope.timestamp),
    ...maybeStartQueuedTurn(state, params.streamId, envelope.timestamp),
  ]

  if (state.activeAssistantMessageId) {
    mutations.push(
      ...finalizeAssistantMessage(
        state,
        params,
        envelope,
        envelope.timestamp,
        event.success ? `completed` : `failed`
      )
    )
  }

  if (state.activeTurn) {
    mutations.push({
      collection: `turns`,
      value: {
        id: state.activeTurn.id,
        sessionId: params.streamId,
        promptMessageId: state.activeTurn.promptMessageId,
        status: event.success ? `completed` : `failed`,
        startedAt: state.activeTurn.startedAt,
        completedAt: normalizeAgentDBTimestamp(envelope.timestamp),
        inputTokens: event.cost?.inputTokens,
        outputTokens: event.cost?.outputTokens,
        costUsd: event.cost?.totalCost,
      },
    })
    state.activeTurn = undefined
  }

  return mutations
}

function materializeSessionInit(
  params: AgentDBMaterializeParams,
  envelope: AgentEnvelope,
  event: Extract<NormalizedEvent, { type: `session_init` }>
): Array<AgentDBMutation> {
  return [
    {
      collection: `sessions`,
      value: {
        id: params.streamId,
        streamId: params.streamId,
        agent: envelope.agent,
        model: event.model,
        permissionMode: event.permissionMode,
        status: `initialized`,
        startedAt: normalizeAgentDBTimestamp(envelope.timestamp),
        lastEventAt: normalizeAgentDBTimestamp(envelope.timestamp),
      },
    },
    {
      collection: `session_events`,
      value: {
        id: createAgentDBRowId(params.sequence, `session_init`),
        sessionId: params.streamId,
        kind: `session_init`,
        data: {
          sessionId: event.sessionId,
          model: event.model,
          permissionMode: event.permissionMode,
        },
        createdAt: normalizeAgentDBTimestamp(envelope.timestamp),
      },
    },
  ]
}

function materializeStatusChange(
  params: AgentDBMaterializeParams,
  envelope: AgentEnvelope,
  event: Extract<NormalizedEvent, { type: `status_change` }>
): Array<AgentDBMutation> {
  return [
    createSessionUpsert(params.streamId, envelope.timestamp),
    {
      collection: `session_events`,
      value: {
        id: createAgentDBRowId(params.sequence, `status_change`),
        sessionId: params.streamId,
        kind: `status_change`,
        data: {
          status: event.status,
          agent: envelope.agent,
        },
        createdAt: normalizeAgentDBTimestamp(envelope.timestamp),
      },
    },
  ]
}

function materializeAgentEnvelopeWithState(
  state: AgentDBMaterializerState,
  params: AgentDBMaterializeParams,
  envelope: AgentEnvelope
): Array<AgentDBMutation> {
  const event = normalizeAgentEvent(envelope)
  if (!event) {
    return [createSessionUpsert(params.streamId, envelope.timestamp)]
  }

  switch (event.type) {
    case `session_init`:
      return materializeSessionInit(params, envelope, event)
    case `assistant_message`:
      return materializeAssistantMessage(state, params, envelope, event)
    case `stream_delta`:
      return materializeStreamDelta(state, params, envelope, event)
    case `tool_call`:
      return materializeToolCall(state, params, envelope, event)
    case `tool_result`:
      return materializeToolResult(state, params, envelope, event)
    case `permission_request`:
      return materializePermissionRequest(state, params, envelope, event)
    case `tool_progress`:
      return materializeToolProgress(state, params, envelope, event)
    case `turn_complete`:
      return materializeTurnComplete(state, params, envelope, event)
    case `status_change`:
      return materializeStatusChange(params, envelope, event)
    default:
      return [createSessionUpsert(params.streamId, envelope.timestamp)]
  }
}

export function materializeAgentDBEnvelopeWithState(
  state: AgentDBMaterializerState,
  params: AgentDBMaterializeParams
): Array<AgentDBMutation> {
  const { envelope } = params

  if (envelope.direction === `user`) {
    return materializeUserEnvelope(state, params, envelope)
  }

  if (envelope.direction === `bridge`) {
    return materializeBridgeEnvelope(params, envelope)
  }

  return materializeAgentEnvelopeWithState(state, params, envelope)
}

export function materializeAgentDBEnvelope(
  params: AgentDBMaterializeParams
): Array<AgentDBMutation> {
  return materializeAgentDBEnvelopeWithState(
    createAgentDBMaterializerState(),
    params
  )
}
