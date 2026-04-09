import {
  createCollection,
  createOptimisticAction,
  localOnlyCollectionOptions,
} from "@tanstack/react-db"
import type { Collection, Transaction } from "@tanstack/react-db"
import type {
  CreateSessionPayload,
  SessionControlPayload,
  SessionPendingAction,
  SessionSummary,
} from "~/lib/session-types"
import { buildClientStreamUrl } from "~/lib/client-stream-url"

export type SessionsCollection = Collection<SessionSummary, string>

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, ``)
  const segments = trimmed.split(/[\\/]/).filter(Boolean)
  return segments[segments.length - 1] ?? path
}

function dedupeFeatures(features: Array<string> | undefined): Array<string> {
  return Array.from(new Set((features ?? []).filter(Boolean)))
}

export function buildOptimisticSessionSummary(
  payload: CreateSessionPayload
): SessionSummary {
  const id = trimOptional(payload.id) ?? crypto.randomUUID().slice(0, 8)
  const now = new Date().toISOString()
  const cwd = payload.cwd.trim()
  const title =
    trimOptional(payload.title) ?? `${payload.agent} · ${basename(cwd)}`

  return {
    id,
    title,
    agent: payload.agent,
    cwd,
    model: trimOptional(payload.model),
    permissionMode: trimOptional(payload.permissionMode),
    approvalPolicy: payload.approvalPolicy,
    sandboxMode: payload.sandboxMode,
    developerInstructions: trimOptional(payload.developerInstructions),
    experimentalFeatures: dedupeFeatures(payload.experimentalFeatures),
    debugStream: payload.debugStream === true,
    createdAt: now,
    updatedAt: now,
    active: false,
    clientStreamUrl: buildClientStreamUrl(id),
    pendingAction: `starting`,
  }
}

export function createSessionsCollection(
  initialSessions: Array<SessionSummary>
): SessionsCollection {
  return createCollection(
    localOnlyCollectionOptions({
      id: `coding-agents-ui:sessions`,
      getKey: (session: SessionSummary) => session.id,
      initialData: initialSessions,
    })
  )
}

export function upsertSessionSummary(
  collection: SessionsCollection,
  session: SessionSummary,
  options?: { optimistic?: boolean }
): Transaction {
  if (collection.has(session.id)) {
    return collection.update(session.id, options ?? {}, (draft) => {
      Object.assign(draft, session)
    })
  }

  return collection.insert(session, options)
}

export function reconcileSessionSummaries(
  collection: SessionsCollection,
  nextSessions: Array<SessionSummary>
): void {
  for (const session of nextSessions) {
    upsertSessionSummary(collection, session, { optimistic: false })
  }
}

async function postJson<TResponse>(
  url: string,
  body: object
): Promise<TResponse> {
  const response = await fetch(url, {
    method: `POST`,
    headers: {
      "Content-Type": `application/json`,
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    throw new Error(await response.text())
  }

  return (await response.json()) as TResponse
}

export function createSessionAction(collection: SessionsCollection) {
  const run = createOptimisticAction<{
    optimisticSession: SessionSummary
    payload: CreateSessionPayload
  }>({
    onMutate: ({ optimisticSession }) => {
      upsertSessionSummary(collection, optimisticSession)
    },
    mutationFn: async ({ optimisticSession, payload }) => {
      const persistedSession = await postJson<SessionSummary>(`/api/sessions`, {
        ...payload,
        id: optimisticSession.id,
      })

      upsertSessionSummary(collection, persistedSession, { optimistic: false })
    },
  })

  return (
    payload: CreateSessionPayload
  ): {
    session: SessionSummary
    transaction: Transaction
  } => {
    const optimisticSession = buildOptimisticSessionSummary(payload)
    return {
      session: optimisticSession,
      transaction: run({
        optimisticSession,
        payload,
      }),
    }
  }
}

function buildOptimisticControlSession(
  session: SessionSummary,
  action: SessionControlPayload[`action`]
): SessionSummary {
  const pendingAction: SessionPendingAction =
    action === `resume`
      ? `resuming`
      : action === `restart`
        ? `restarting`
        : `stopping`

  return {
    ...session,
    active: action === `stop` ? false : true,
    updatedAt: new Date().toISOString(),
    pendingAction,
  }
}

export function createSessionControlAction(collection: SessionsCollection) {
  return createOptimisticAction<{
    session: SessionSummary
    action: SessionControlPayload[`action`]
  }>({
    onMutate: ({ session, action }) => {
      upsertSessionSummary(
        collection,
        buildOptimisticControlSession(session, action)
      )
    },
    mutationFn: async ({ session, action }) => {
      const persistedSession = await postJson<SessionSummary>(
        `/api/session-control`,
        {
          id: session.id,
          action,
        }
      )

      upsertSessionSummary(collection, persistedSession, { optimistic: false })
    },
  })
}
