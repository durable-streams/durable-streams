/**
 * @durable-streams/ai-session
 *
 * Durable AI sessions with unified schema for Vercel AI SDK,
 * TanStack AI, and OpenResponses.
 */

// Schema exports
export {
  // Zod schemas
  MessageSchema,
  DeltaSchema,
  PresenceSchema,
  AgentSchema,
  StatusSchema,
  // Types
  type Message,
  type Delta,
  type Presence,
  type Agent,
  type Status,
  type Part,
  type MessageWithParts,
  // State schema for createStreamDB
  aiSessionSchema,
  // ID generators
  generateMessageId,
  generateDeltaId,
  generatePresenceId,
  generateStatusId,
} from "./schema.js"

// Session exports
export {
  createAISession,
  type AISession,
  type AISessionOptions,
  type CreateMessageOptions,
  type AppendDeltaOptions,
  type UpdateStatusOptions,
} from "./session.js"
