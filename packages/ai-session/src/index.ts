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
  // Types
  type Message,
  type Delta,
  type Presence,
  type Agent,
  type Part,
  type MessageWithParts,
  // State schema for createStreamDB
  aiSessionSchema,
  // ID generators
  generateMessageId,
  generateDeltaId,
  generatePresenceId,
} from "./schema.js"

// Session exports
export {
  createAISession,
  type AISession,
  type AISessionOptions,
  type CreateMessageOptions,
  type AppendDeltaOptions,
} from "./session.js"
