/**
 * TanStack AI transport adapters for Durable Streams.
 */

export { durableStreamConnection } from "./client"
export {
  appendSanitizedChunksToStream,
  ensureDurableChatSessionStream,
  pipeSanitizedChunksToStream,
  toDurableChatSessionResponse,
  toDurableStreamResponse,
  toMessageEchoChunks,
} from "./server"
export {
  materializeSnapshotFromDurableStream,
  sanitizeChunkForStorage,
} from "./client"

export type {
  DurableChatSessionStreamTarget,
  DurableSessionConnection,
  DurableSessionMessage,
  DurableSessionMessagePart,
  DurableStreamConnection,
  DurableStreamConnectionOptions,
  DurableStreamTarget,
  TanStackChunk,
  ToDurableStreamResponseMode,
  ToDurableChatSessionResponseOptions,
  ToDurableStreamResponseOptions,
  WaitUntil,
} from "./types"
