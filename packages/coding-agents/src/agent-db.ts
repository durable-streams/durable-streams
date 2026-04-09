import { createCollection, localOnlyCollectionOptions } from "@tanstack/db"
import { DurableStream } from "@durable-streams/client"
import { createAgentDBActions } from "./agent-db-actions.js"
import {
  createAgentDBStreamId,
  normalizeAgentDBTimestamp,
} from "./agent-db-normalize.js"
import { createAgentDBSchema } from "./agent-db-schema.js"
import {
  createAgentDBMaterializerState,
  materializeAgentDBEnvelopeWithState,
} from "./agent-db-materializer.js"
import type {
  AgentDB,
  AgentDBCollections,
  AgentDBUtils,
  CreateAgentDBOptions,
} from "./agent-db-types.js"
import type { AgentDBMutation } from "./agent-db-materializer.js"
import type { StreamEnvelope } from "./types.js"
import type { StreamResponse } from "@durable-streams/client"

function resolveStreamUrl(url: string): string {
  try {
    return new URL(url).toString()
  } catch {
    if (typeof window !== `undefined`) {
      return new URL(url, window.location.href).toString()
    }
    return url
  }
}

function createAgentDBCollections(): AgentDBCollections {
  const schema = createAgentDBSchema()
  const collections = {
    sessions: createCollection(
      localOnlyCollectionOptions({
        id: `agent-db:sessions`,
        schema: schema.sessions.schema,
        getKey: (value: { id: string }) => value.id,
      })
    ),
    participants: createCollection(
      localOnlyCollectionOptions({
        id: `agent-db:participants`,
        schema: schema.participants.schema,
        getKey: (value: { id: string }) => value.id,
      })
    ),
    messages: createCollection(
      localOnlyCollectionOptions({
        id: `agent-db:messages`,
        schema: schema.messages.schema,
        getKey: (value: { id: string }) => value.id,
      })
    ),
    message_parts: createCollection(
      localOnlyCollectionOptions({
        id: `agent-db:message-parts`,
        schema: schema.message_parts.schema,
        getKey: (value: { id: string }) => value.id,
      })
    ),
    turns: createCollection(
      localOnlyCollectionOptions({
        id: `agent-db:turns`,
        schema: schema.turns.schema,
        getKey: (value: { id: string }) => value.id,
      })
    ),
    tool_calls: createCollection(
      localOnlyCollectionOptions({
        id: `agent-db:tool-calls`,
        schema: schema.tool_calls.schema,
        getKey: (value: { id: string }) => value.id,
      })
    ),
    permission_requests: createCollection(
      localOnlyCollectionOptions({
        id: `agent-db:permission-requests`,
        schema: schema.permission_requests.schema,
        getKey: (value: { id: string }) => value.id,
      })
    ),
    approval_responses: createCollection(
      localOnlyCollectionOptions({
        id: `agent-db:approval-responses`,
        schema: schema.approval_responses.schema,
        getKey: (value: { id: string }) => value.id,
      })
    ),
    session_events: createCollection(
      localOnlyCollectionOptions({
        id: `agent-db:session-events`,
        schema: schema.session_events.schema,
        getKey: (value: { id: string }) => value.id,
      })
    ),
    debug_events: createCollection(
      localOnlyCollectionOptions({
        id: `agent-db:debug-events`,
        schema: schema.debug_events.schema,
        getKey: (value: { id: string }) => value.id,
      })
    ),
  }

  return collections as AgentDBCollections
}

function applyMutation(
  collections: AgentDBCollections,
  mutation: AgentDBMutation
) {
  const collection = collections[mutation.collection] as any
  const key = String((mutation.value as { id: string }).id)
  const existing = collection.get(key)

  if (existing) {
    collection.update(key, (draft: Record<string, unknown>) => {
      Object.assign(draft, mutation.value)
    })
    return
  }

  collection.insert(mutation.value as never)
}

export function createAgentDB(options: CreateAgentDBOptions): AgentDB {
  const resolvedUrl = resolveStreamUrl(String(options.streamOptions.url))
  const stream = new DurableStream({
    ...options.streamOptions,
    url: resolvedUrl,
    contentType: options.streamOptions.contentType ?? `application/json`,
  })
  const streamId = createAgentDBStreamId(stream.url)
  const collections = createAgentDBCollections()
  const utils: AgentDBUtils = {
    awaitTxId(): Promise<void> {
      return Promise.reject(
        new Error(`agentdb actions are not implemented yet`)
      )
    },
  }

  let responsePromise: Promise<StreamResponse<StreamEnvelope>> | null = null
  let closeConsumer: (() => void) | null = null
  let preloadPromise: Promise<void> | null = null
  let sequence = 0
  const materializerState = createAgentDBMaterializerState()
  const seenTxids = new Set<string>()
  const txidResolvers = new Map<
    string,
    Array<{
      resolve: () => void
      reject: (error: Error) => void
      timeoutId: ReturnType<typeof setTimeout>
    }>
  >()

  const ensureSessionShell = () => {
    const existing = collections.sessions.get(streamId)
    if (existing) {
      collections.sessions.update(
        streamId,
        (draft: { lastEventAt?: string }) => {
          draft.lastEventAt = normalizeAgentDBTimestamp(Date.now())
        }
      )
      return
    }

    collections.sessions.insert({
      id: streamId,
      streamId,
      status: `loading`,
      lastEventAt: normalizeAgentDBTimestamp(Date.now()),
    })
  }

  const resolveTxid = (txid: string) => {
    seenTxids.add(txid)
    const waiters = txidResolvers.get(txid)
    if (!waiters) {
      return
    }

    txidResolvers.delete(txid)
    for (const waiter of waiters) {
      clearTimeout(waiter.timeoutId)
      waiter.resolve()
    }
  }

  const preload = async () => {
    if (preloadPromise) {
      return preloadPromise
    }

    ensureSessionShell()

    preloadPromise = (async () => {
      if (!responsePromise) {
        responsePromise = stream.stream<StreamEnvelope>({ live: true })
      }

      const response = await responsePromise

      await new Promise<void>((resolve, reject) => {
        closeConsumer = response.subscribeJson((batch) => {
          for (const envelope of batch.items) {
            sequence += 1
            const envelopeTxid =
              envelope.direction === `user` &&
              typeof envelope.txid === `string` &&
              envelope.txid.length > 0
                ? envelope.txid
                : undefined
            const mutations = materializeAgentDBEnvelopeWithState(
              materializerState,
              {
                streamId,
                envelope,
                sequence,
              }
            )

            for (const mutation of mutations) {
              applyMutation(collections, mutation)
            }

            if (envelopeTxid) {
              resolveTxid(envelopeTxid)
            }
          }

          if (batch.upToDate) {
            resolve()
          }
        })

        void response.closed.catch(reject)
      })
    })()

    return preloadPromise
  }

  const awaitTxId = (txid: string, timeout: number = 5000): Promise<void> => {
    if (seenTxids.has(txid)) {
      return Promise.resolve()
    }

    return new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        const waiters = txidResolvers.get(txid) ?? []
        txidResolvers.set(
          txid,
          waiters.filter((waiter) => waiter.reject !== reject)
        )
        reject(new Error(`Timed out waiting for txid ${txid}`))
      }, timeout)

      const waiters = txidResolvers.get(txid) ?? []
      waiters.push({ resolve, reject, timeoutId })
      txidResolvers.set(txid, waiters)
    })
  }

  const db = {
    stream,
    collections,
    utils,
    preload,
    close() {
      for (const waiters of txidResolvers.values()) {
        for (const waiter of waiters) {
          clearTimeout(waiter.timeoutId)
          waiter.reject(new Error(`AgentDB closed`))
        }
      }
      txidResolvers.clear()
      closeConsumer?.()
      closeConsumer = null
    },
  } as AgentDB

  utils.awaitTxId = awaitTxId

  const actionDefs = createAgentDBActions({
    db,
    stream,
    sessionId: streamId,
  })

  return {
    ...db,
    actions: actionDefs,
  }
}
