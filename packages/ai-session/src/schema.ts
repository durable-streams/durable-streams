/**
 * Durable AI Session Schema
 *
 * Insert-only deltas, TanStack DB incremental queries concat them efficiently.
 */

import { z } from "zod"
import { createStateSchema } from "@durable-streams/state"

// =============================================================================
// Zod Schemas
// =============================================================================

export const MessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant", "system"]),
  status: z.enum(["pending", "streaming", "done"]).default("pending"),
  agentId: z.string().nullable(),
  userId: z.string().nullable(),
  createdAt: z.number(),
})

export const DeltaSchema = z.object({
  id: z.string(),
  messageId: z.string(),
  partIndex: z.number(),
  partType: z.enum([
    "text",
    "tool-call",
    "tool-result",
    "reasoning",
    "file",
    "source",
  ]),
  seq: z.number(),
  text: z.string().optional(),
  toolCallId: z.string().optional(),
  toolName: z.string().optional(),
  toolOutput: z.unknown().optional(),
  toolError: z.string().optional(),
  fileUrl: z.string().optional(),
  fileName: z.string().optional(),
  mimeType: z.string().optional(),
  sourceUrl: z.string().optional(),
  sourceTitle: z.string().optional(),
  done: z.boolean().optional(),
})

export const PresenceSchema = z.object({
  id: z.string(),
  type: z.enum(["agent", "user"]),
  name: z.string(),
  status: z.enum(["active", "typing", "idle", "disconnected"]),
  lastSeen: z.number(),
  metadata: z.record(z.unknown()).optional(),
})

export const AgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  model: z.string().optional(),
  systemPrompt: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
})

// =============================================================================
// Inferred Types
// =============================================================================

export type Message = z.infer<typeof MessageSchema>
export type Delta = z.infer<typeof DeltaSchema>
export type Presence = z.infer<typeof PresenceSchema>
export type Agent = z.infer<typeof AgentSchema>

// =============================================================================
// State Schema
// =============================================================================

export const aiSessionSchema = createStateSchema({
  messages: {
    schema: MessageSchema,
    type: "message",
    primaryKey: "id",
  },
  deltas: {
    schema: DeltaSchema,
    type: "delta",
    primaryKey: "id",
  },
  presence: {
    schema: PresenceSchema,
    type: "presence",
    primaryKey: "id",
  },
  agents: {
    schema: AgentSchema,
    type: "agent",
    primaryKey: "id",
  },
})

// =============================================================================
// Helper Types (computed views, not stored)
// =============================================================================

export interface Part {
  partIndex: number
  partType: Delta["partType"]
  content: string
  done: boolean
  toolCallId?: string
  toolName?: string
  toolOutput?: unknown
  toolError?: string
  fileUrl?: string
  fileName?: string
  mimeType?: string
  sourceUrl?: string
  sourceTitle?: string
}

export interface MessageWithParts extends Message {
  parts: Part[]
}

// =============================================================================
// ID Generators
// =============================================================================

let messageCounter = 0

export function generateMessageId(): string {
  return `msg_${Date.now()}_${++messageCounter}`
}

export function generateDeltaId(
  messageId: string,
  partIndex: number,
  seq: number
): string {
  return `${messageId}_p${partIndex}_s${seq}`
}

export function generatePresenceId(type: "agent" | "user", id: string): string {
  return `${type}_${id}`
}
