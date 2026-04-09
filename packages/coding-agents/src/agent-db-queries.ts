import {
  coalesce,
  concat,
  createCollection,
  createLiveQueryCollection,
  eq,
  localOnlyCollectionOptions,
  toArray,
} from "@tanstack/db"
import type {
  AgentDB,
  ApprovalResponseRow,
  ParticipantRow,
  PermissionRequestRow,
  SessionEventRow,
  ToolCallRow,
  TurnRow,
} from "./agent-db-types.js"

interface TimelineSeedRow {
  id: string
}

export interface AgentTimelineQueryMessage {
  id: string
  turnId?: string
  participantId?: string
  role: string
  kind: string
  syntheticType?: string
  createdAt: string
  completedAt?: string
  status: string
  text: string
  parts: Array<{
    id: string
    partIndex: number
    deltaIndex?: number
    kind: string
    text?: string
    json?: unknown
    providerPartType?: string
    createdAt: string
  }>
}

export interface AgentTimelineQueryRow {
  id: string
  participants: Array<ParticipantRow>
  messages: Array<AgentTimelineQueryMessage>
  toolCalls: Array<ToolCallRow>
  permissionRequests: Array<PermissionRequestRow>
  approvalResponses: Array<ApprovalResponseRow>
  sessionEvents: Array<SessionEventRow>
  turns: Array<TurnRow>
}

export interface AgentTimelineEntry {
  id: string
  kind: string
  createdAt: string
  text?: string
  role?: string
  participant?: ParticipantRow
  message?: AgentTimelineQueryMessage
  toolCall?: ToolCallRow
  permissionRequest?: PermissionRequestRow
  approvalResponse?: ApprovalResponseRow
  turn?: TurnRow
  sessionEvent?: SessionEventRow
}

export type AgentTimelineCollection = any
export type PendingApprovalsCollection = any
export type SessionHeaderCollection = any
export type ParticipantSummaryCollection = any
export type ToolActivityCollection = any

function createTimelineSeedCollection(sessionId: string) {
  return createCollection(
    localOnlyCollectionOptions({
      id: `agent-db:timeline-seed:${sessionId}`,
      getKey: (row: TimelineSeedRow) => row.id,
      initialData: [{ id: sessionId }],
    })
  )
}

export function createAgentTimelineQuery(
  db: AgentDB,
  sessionId: string
): AgentTimelineCollection {
  const seedCollection = createTimelineSeedCollection(sessionId)

  return createLiveQueryCollection({
    id: `agent-db:timeline:${sessionId}`,
    query: (q) =>
      q.from({ seed: seedCollection }).select(({ seed }) => ({
        id: seed.id,
        participants: toArray(
          q
            .from({ participant: db.collections.participants })
            .where(({ participant }) => eq(participant.sessionId, seed.id))
            .orderBy(({ participant }) => participant.firstSeenAt)
            .select(({ participant }) => participant)
        ),
        messages: toArray(
          q
            .from({ message: db.collections.messages })
            .where(({ message }) => eq(message.sessionId, seed.id))
            .orderBy(({ message }) => message.createdAt)
            .orderBy(({ message }) => message.id)
            .select(({ message }) => ({
              id: message.id,
              turnId: message.turnId,
              participantId: message.participantId,
              role: message.role,
              kind: message.kind,
              syntheticType: message.syntheticType,
              createdAt: message.createdAt,
              completedAt: message.completedAt,
              status: message.status,
              text: concat(
                toArray(
                  q
                    .from({ part: db.collections.message_parts })
                    .where(({ part }) => eq(part.messageId, message.id))
                    .orderBy(({ part }) => part.partIndex)
                    .orderBy(({ part }) => coalesce(part.deltaIndex, -1))
                    .select(({ part }) => coalesce(part.text, ``))
                )
              ),
              parts: toArray(
                q
                  .from({ part: db.collections.message_parts })
                  .where(({ part }) => eq(part.messageId, message.id))
                  .orderBy(({ part }) => part.partIndex)
                  .orderBy(({ part }) => coalesce(part.deltaIndex, -1))
                  .select(({ part }) => ({
                    id: part.id,
                    partIndex: part.partIndex,
                    deltaIndex: part.deltaIndex,
                    kind: part.kind,
                    text: part.text,
                    json: part.json,
                    providerPartType: part.providerPartType,
                    createdAt: part.createdAt,
                  }))
              ),
            }))
        ),
        toolCalls: toArray(
          q
            .from({ toolCall: db.collections.tool_calls })
            .where(({ toolCall }) => eq(toolCall.sessionId, seed.id))
            .orderBy(({ toolCall }) => coalesce(toolCall.startedAt, ``))
            .orderBy(({ toolCall }) => toolCall.id)
            .select(({ toolCall }) => toolCall)
        ),
        permissionRequests: toArray(
          q
            .from({ request: db.collections.permission_requests })
            .where(({ request }) => eq(request.sessionId, seed.id))
            .orderBy(({ request }) => request.requestedAt)
            .orderBy(({ request }) => request.id)
            .select(({ request }) => request)
        ),
        approvalResponses: toArray(
          q
            .from({ response: db.collections.approval_responses })
            .where(({ response }) => eq(response.sessionId, seed.id))
            .orderBy(({ response }) => response.createdAt)
            .orderBy(({ response }) => response.id)
            .select(({ response }) => response)
        ),
        sessionEvents: toArray(
          q
            .from({ sessionEvent: db.collections.session_events })
            .where(({ sessionEvent }) => eq(sessionEvent.sessionId, seed.id))
            .orderBy(({ sessionEvent }) => sessionEvent.createdAt)
            .orderBy(({ sessionEvent }) => sessionEvent.id)
            .select(({ sessionEvent }) => sessionEvent)
        ),
        turns: toArray(
          q
            .from({ turn: db.collections.turns })
            .where(({ turn }) => eq(turn.sessionId, seed.id))
            .orderBy(({ turn }) => coalesce(turn.startedAt, ``))
            .orderBy(({ turn }) => turn.id)
            .select(({ turn }) => turn)
        ),
      })),
  }) as AgentTimelineCollection
}

export function createPendingApprovalsQuery(
  db: AgentDB,
  sessionId: string
): PendingApprovalsCollection {
  return createLiveQueryCollection({
    id: `agent-db:pending-approvals:${sessionId}`,
    query: (q) =>
      q
        .from({ request: db.collections.permission_requests })
        .where(({ request }) => eq(request.sessionId, sessionId))
        .where(({ request }) => eq(request.status, `pending`))
        .orderBy(({ request }) => request.requestedAt)
        .select(({ request }) => request),
  }) as PendingApprovalsCollection
}

export function createSessionHeaderQuery(
  db: AgentDB,
  sessionId: string
): SessionHeaderCollection {
  return createLiveQueryCollection({
    id: `agent-db:session-header:${sessionId}`,
    query: (q) =>
      q
        .from({ session: db.collections.sessions })
        .where(({ session }) => eq(session.id, sessionId))
        .select(({ session }) => session),
  }) as SessionHeaderCollection
}

export function createParticipantSummaryQuery(
  db: AgentDB,
  sessionId: string
): ParticipantSummaryCollection {
  return createLiveQueryCollection({
    id: `agent-db:participant-summary:${sessionId}`,
    query: (q) =>
      q
        .from({ participant: db.collections.participants })
        .where(({ participant }) => eq(participant.sessionId, sessionId))
        .orderBy(({ participant }) => participant.firstSeenAt)
        .select(({ participant }) => participant),
  }) as ParticipantSummaryCollection
}

export function createToolActivityQuery(
  db: AgentDB,
  sessionId: string
): ToolActivityCollection {
  return createLiveQueryCollection({
    id: `agent-db:tool-activity:${sessionId}`,
    query: (q) =>
      q
        .from({ toolCall: db.collections.tool_calls })
        .where(({ toolCall }) => eq(toolCall.sessionId, sessionId))
        .orderBy(({ toolCall }) => coalesce(toolCall.startedAt, ``))
        .orderBy(({ toolCall }) => toolCall.id)
        .select(({ toolCall }) => toolCall),
  }) as ToolActivityCollection
}

export function normalizeAgentTimelineRow(
  row: AgentTimelineQueryRow
): Array<AgentTimelineEntry> {
  const participantsById = new Map(
    row.participants.map((participant) => [participant.id, participant])
  )

  const entries: Array<AgentTimelineEntry> = [
    ...row.messages.map((message) => ({
      id: message.id,
      kind: message.kind,
      createdAt: message.createdAt,
      text: message.text,
      role: message.role,
      participant: message.participantId
        ? participantsById.get(message.participantId)
        : undefined,
      message,
    })),
    ...row.toolCalls.map((toolCall) => ({
      id: toolCall.id,
      kind: `tool_call`,
      createdAt: toolCall.startedAt ?? toolCall.completedAt ?? ``,
      toolCall,
    })),
    ...row.permissionRequests.map((permissionRequest) => ({
      id: permissionRequest.id,
      kind: `permission_request`,
      createdAt: permissionRequest.requestedAt,
      permissionRequest,
    })),
    ...row.approvalResponses.map((approvalResponse) => ({
      id: approvalResponse.id,
      kind: `approval_response`,
      createdAt: approvalResponse.createdAt,
      participant: approvalResponse.participantId
        ? participantsById.get(approvalResponse.participantId)
        : undefined,
      approvalResponse,
    })),
    ...row.turns
      .filter((turn) => turn.completedAt)
      .map((turn) => ({
        id: turn.id,
        kind: `turn_complete`,
        createdAt: turn.completedAt ?? turn.startedAt ?? ``,
        turn,
      })),
    ...row.sessionEvents.map((sessionEvent) => ({
      id: sessionEvent.id,
      kind: `session_event`,
      createdAt: sessionEvent.createdAt,
      sessionEvent,
    })),
  ]

  return entries.sort((a, b) => {
    const timeOrder = a.createdAt.localeCompare(b.createdAt)
    if (timeOrder !== 0) {
      return timeOrder
    }
    return a.id.localeCompare(b.id)
  })
}
