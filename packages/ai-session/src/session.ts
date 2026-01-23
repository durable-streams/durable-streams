/**
 * AI Session - high-level API for creating and interacting with durable AI sessions
 */

import { createStreamDB, type StreamDB } from "@durable-streams/state"
import { DurableStream } from "@durable-streams/client"
import {
  aiSessionSchema,
  generateMessageId,
  generateDeltaId,
  generatePresenceId,
  type Message,
  type Delta,
  type Presence,
  type Agent,
} from "./schema.js"

// =============================================================================
// Types
// =============================================================================

export interface AISessionOptions {
  /** URL of the durable stream for this session */
  url: string
  /** Optional headers for authentication */
  headers?: Record<string, string>
  /** Create the stream if it doesn't exist (default: false) */
  create?: boolean
}

export interface CreateMessageOptions {
  role: Message["role"]
  status?: Message["status"]
  agentId?: string
  userId?: string
}

export interface AppendDeltaOptions {
  messageId: string
  partIndex: number
  partType: Delta["partType"]
  seq: number
  text?: string
  toolCallId?: string
  toolName?: string
  toolOutput?: unknown
  toolError?: string
  fileUrl?: string
  fileName?: string
  mimeType?: string
  sourceUrl?: string
  sourceTitle?: string
  done?: boolean
}

type SessionDB = StreamDB<typeof aiSessionSchema>

export interface AISession {
  /** The underlying StreamDB instance */
  db: SessionDB

  /** The underlying DurableStream for appending events */
  stream: DurableStream

  /** Preload all session data */
  preload(): Promise<void>

  /** Close the session */
  close(): void

  // Message operations
  createMessage(options: CreateMessageOptions): Promise<Message>
  updateMessage(messageId: string, updates: Partial<Pick<Message, "status">>): Promise<void>
  appendDelta(options: AppendDeltaOptions): Promise<Delta>

  // Presence operations
  updatePresence(
    type: "agent" | "user",
    id: string,
    name: string,
    status: Presence["status"]
  ): Promise<Presence>

  // Agent operations
  registerAgent(agent: Omit<Agent, "id"> & { id?: string }): Promise<Agent>
}

// =============================================================================
// Implementation
// =============================================================================

export async function createAISession(
  options: AISessionOptions
): Promise<AISession> {
  const { url, headers, create: shouldCreate } = options

  // Create the stream first if requested
  if (shouldCreate) {
    await DurableStream.create({
      url,
      contentType: "application/json",
      headers,
    })
  }

  // Create the stream DB with AI session schema
  const db = createStreamDB({
    streamOptions: {
      url,
      contentType: "application/json",
      headers,
    },
    state: aiSessionSchema,
  })

  // Get the underlying stream for appending
  const stream = db.stream

  return {
    db,
    stream,

    preload: () => db.preload(),
    close: () => db.close(),

    async createMessage(opts: CreateMessageOptions): Promise<Message> {
      const message: Message = {
        id: generateMessageId(),
        role: opts.role,
        status: opts.status ?? "pending",
        agentId: opts.agentId ?? null,
        userId: opts.userId ?? null,
        createdAt: Date.now(),
      }

      await stream.append(
        JSON.stringify(aiSessionSchema.messages.insert({ value: message }))
      )

      return message
    },

    async updateMessage(
      messageId: string,
      updates: Partial<Pick<Message, "status">>
    ): Promise<void> {
      // Get existing message from collection
      const existing = Array.from(db.collections.messages.values()).find(
        (m) => m.id === messageId
      )
      if (!existing) {
        throw new Error(`Message not found: ${messageId}`)
      }

      // Merge updates
      const updated: Message = {
        ...existing,
        ...updates,
        status: updates.status ?? existing.status ?? "pending",
      }

      // Send update event
      await stream.append(
        JSON.stringify(aiSessionSchema.messages.update({ value: updated }))
      )
    },

    async appendDelta(opts: AppendDeltaOptions): Promise<Delta> {
      const delta: Delta = {
        id: generateDeltaId(opts.messageId, opts.partIndex, opts.seq),
        messageId: opts.messageId,
        partIndex: opts.partIndex,
        partType: opts.partType,
        seq: opts.seq,
        text: opts.text,
        toolCallId: opts.toolCallId,
        toolName: opts.toolName,
        toolOutput: opts.toolOutput,
        toolError: opts.toolError,
        fileUrl: opts.fileUrl,
        fileName: opts.fileName,
        mimeType: opts.mimeType,
        sourceUrl: opts.sourceUrl,
        sourceTitle: opts.sourceTitle,
        done: opts.done,
      }

      await stream.append(
        JSON.stringify(aiSessionSchema.deltas.insert({ value: delta }))
      )

      return delta
    },

    async updatePresence(
      type: "agent" | "user",
      id: string,
      name: string,
      status: Presence["status"]
    ): Promise<Presence> {
      const presence: Presence = {
        id: generatePresenceId(type, id),
        type,
        name,
        status,
        lastSeen: Date.now(),
      }

      // Use upsert since presence updates the same entity
      await stream.append(
        JSON.stringify(aiSessionSchema.presence.upsert({ value: presence }))
      )

      return presence
    },

    async registerAgent(
      agent: Omit<Agent, "id"> & { id?: string }
    ): Promise<Agent> {
      const fullAgent: Agent = {
        id: agent.id ?? `agent_${Date.now()}`,
        name: agent.name,
        model: agent.model,
        systemPrompt: agent.systemPrompt,
        metadata: agent.metadata,
      }

      await stream.append(
        JSON.stringify(aiSessionSchema.agents.upsert({ value: fullAgent }))
      )

      return fullAgent
    },
  }
}
