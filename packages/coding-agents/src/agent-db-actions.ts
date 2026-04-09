import { createOptimisticAction } from "@tanstack/db"
import {
  createAgentDBParticipantId,
  createAgentDBTxRowId,
  normalizeAgentDBProvider,
  normalizeAgentDBTimestamp,
} from "./agent-db-normalize.js"
import type {
  AgentDB,
  AgentDBActions,
  AgentDBCancelParams,
  AgentDBInterruptParams,
  AgentDBPromptParams,
  AgentDBRespondParams,
} from "./agent-db-types.js"
import type { ControlResponseIntent, UserEnvelope } from "./types.js"
import type { DurableStream } from "@durable-streams/client"

interface PromptVariables extends AgentDBPromptParams {
  txid: string
}

interface RespondVariables extends AgentDBRespondParams {
  txid: string
}

interface CancelVariables extends AgentDBCancelParams {
  txid: string
}

interface InterruptVariables extends AgentDBInterruptParams {
  txid: string
}

function upsertParticipant(
  db: AgentDB,
  sessionId: string,
  variables: {
    user: AgentDBPromptParams[`user`]
    timestamp: string
  }
) {
  const participantId = createAgentDBParticipantId(variables.user)
  const existing = db.collections.participants.get(participantId)

  if (existing) {
    db.collections.participants.update(participantId, (draft) => {
      draft.name = variables.user.name
      draft.email = variables.user.email
      draft.lastSeenAt = variables.timestamp
    })
    return participantId
  }

  db.collections.participants.insert({
    id: participantId,
    sessionId,
    name: variables.user.name,
    email: variables.user.email,
    firstSeenAt: variables.timestamp,
    lastSeenAt: variables.timestamp,
  })
  return participantId
}

function appendEnvelope(
  stream: DurableStream,
  envelope: UserEnvelope
): Promise<void> {
  return stream.append(JSON.stringify(envelope))
}

function normalizeOptimisticApprovalDecision(response: object): {
  decision: string
  message?: string
  updatedInput?: unknown
} {
  const payload = response as Record<string, unknown>
  const behavior =
    typeof payload.behavior === `string` ? payload.behavior : undefined

  if (behavior === `deny`) {
    return {
      decision: `denied`,
      message:
        typeof payload.message === `string` ? payload.message : undefined,
      updatedInput: payload.updatedInput,
    }
  }

  return {
    decision: `approved`,
    message: typeof payload.message === `string` ? payload.message : undefined,
    updatedInput: payload.updatedInput,
  }
}

export function createAgentDBActions(context: {
  db: AgentDB
  stream: DurableStream
  sessionId: string
}): AgentDBActions {
  const { db, stream, sessionId } = context

  const promptAction = createOptimisticAction<PromptVariables>({
    onMutate: (variables) => {
      const timestamp = normalizeAgentDBTimestamp(Date.now())
      const participantId = upsertParticipant(db, sessionId, {
        user: variables.user,
        timestamp,
      })
      const messageId = createAgentDBTxRowId(variables.txid, `message`)
      const turnId = createAgentDBTxRowId(variables.txid, `turn`)

      db.collections.messages.insert({
        id: messageId,
        sessionId,
        turnId,
        participantId,
        role: `user`,
        provider: normalizeAgentDBProvider(variables.agent),
        kind: `user_message`,
        createdAt: timestamp,
        completedAt: timestamp,
        status: `completed`,
      })
      db.collections.message_parts.insert({
        id: createAgentDBTxRowId(variables.txid, `part:0`),
        messageId,
        sessionId,
        partIndex: 0,
        kind: `text`,
        text: variables.text,
        createdAt: timestamp,
      })
      db.collections.turns.insert({
        id: turnId,
        sessionId,
        promptMessageId: messageId,
        status: `queued`,
        startedAt: timestamp,
      })
    },
    mutationFn: async (variables) => {
      await db.preload()
      await appendEnvelope(stream, {
        agent: variables.agent,
        direction: `user`,
        timestamp: Date.now(),
        txid: variables.txid,
        user: variables.user,
        raw: {
          type: `user_message`,
          text: variables.text,
        },
      })
      await db.utils.awaitTxId(variables.txid)
    },
  })

  const respondAction = createOptimisticAction<RespondVariables>({
    onMutate: (variables) => {
      const timestamp = normalizeAgentDBTimestamp(Date.now())
      const participantId = upsertParticipant(db, sessionId, {
        user: variables.user,
        timestamp,
      })
      const responseId = createAgentDBTxRowId(
        variables.txid,
        `approval-response`
      )
      const resolution = normalizeOptimisticApprovalDecision(variables.response)

      db.collections.approval_responses.insert({
        id: responseId,
        sessionId,
        requestId: String(variables.requestId),
        participantId,
        decision: resolution.decision,
        message: resolution.message,
        updatedInput: resolution.updatedInput,
        effective: true,
        createdAt: timestamp,
      })

      const existing = db.collections.permission_requests.get(
        String(variables.requestId)
      )
      if (existing) {
        db.collections.permission_requests.update(
          String(variables.requestId),
          (draft) => {
            draft.status = resolution.decision
            draft.resolvedAt = timestamp
            draft.resolvedByParticipantId = participantId
            draft.effectiveResponseId = responseId
          }
        )
      }
    },
    mutationFn: async (variables) => {
      await db.preload()
      await appendEnvelope(stream, {
        agent: variables.agent,
        direction: `user`,
        timestamp: Date.now(),
        txid: variables.txid,
        user: variables.user,
        raw: {
          type: `control_response`,
          response: {
            request_id: variables.requestId,
            subtype: `success`,
            response: variables.response,
          },
        } satisfies ControlResponseIntent,
      })
      await db.utils.awaitTxId(variables.txid)
    },
  })

  const cancelAction = createOptimisticAction<CancelVariables>({
    onMutate: (variables) => {
      const timestamp = normalizeAgentDBTimestamp(Date.now())
      const participantId = upsertParticipant(db, sessionId, {
        user: variables.user,
        timestamp,
      })
      const responseId = createAgentDBTxRowId(
        variables.txid,
        `approval-response`
      )

      db.collections.approval_responses.insert({
        id: responseId,
        sessionId,
        requestId: String(variables.requestId),
        participantId,
        decision: `cancelled`,
        effective: true,
        createdAt: timestamp,
      })

      const existing = db.collections.permission_requests.get(
        String(variables.requestId)
      )
      if (existing) {
        db.collections.permission_requests.update(
          String(variables.requestId),
          (draft) => {
            draft.status = `cancelled`
            draft.resolvedAt = timestamp
            draft.resolvedByParticipantId = participantId
            draft.effectiveResponseId = responseId
          }
        )
      }
    },
    mutationFn: async (variables) => {
      await db.preload()
      await appendEnvelope(stream, {
        agent: variables.agent,
        direction: `user`,
        timestamp: Date.now(),
        txid: variables.txid,
        user: variables.user,
        raw: {
          type: `control_response`,
          response: {
            request_id: variables.requestId,
            subtype: `cancelled`,
            response: {},
          },
        } satisfies ControlResponseIntent,
      })
      await db.utils.awaitTxId(variables.txid)
    },
  })

  const interruptAction = createOptimisticAction<InterruptVariables>({
    onMutate: (variables) => {
      const timestamp = normalizeAgentDBTimestamp(Date.now())
      const participantId = upsertParticipant(db, sessionId, {
        user: variables.user,
        timestamp,
      })

      db.collections.session_events.insert({
        id: createAgentDBTxRowId(variables.txid, `interrupt`),
        sessionId,
        kind: `interrupt_requested`,
        data: {
          participantId,
        },
        createdAt: timestamp,
      })
    },
    mutationFn: async (variables) => {
      await db.preload()
      await appendEnvelope(stream, {
        agent: variables.agent,
        direction: `user`,
        timestamp: Date.now(),
        txid: variables.txid,
        user: variables.user,
        raw: {
          type: `interrupt`,
        },
      })
      await db.utils.awaitTxId(variables.txid)
    },
  })

  return {
    prompt(params) {
      return promptAction({
        ...params,
        txid: crypto.randomUUID(),
      })
    },
    respond(params) {
      return respondAction({
        ...params,
        txid: crypto.randomUUID(),
      })
    },
    cancel(params) {
      return cancelAction({
        ...params,
        txid: crypto.randomUUID(),
      })
    },
    interrupt(params) {
      return interruptAction({
        ...params,
        txid: crypto.randomUUID(),
      })
    },
  }
}
