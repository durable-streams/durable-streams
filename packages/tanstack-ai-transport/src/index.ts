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
  DurableMessageMetadata,
  DurableMessageOffsetMarker,
  DurableMessageOffsetMarkerValue,
  DurableSessionConnection,
  DurableSessionMessage,
  DurableSessionMessagePart,
  DurableStreamConnection,
  DurableStreamConnectionOptions,
  DurableStreamTarget,
  ForkPointOptions,
  TanStackChunk,
  ToDurableStreamResponseMode,
  ToDurableChatSessionResponseOptions,
  ToDurableStreamResponseOptions,
  WaitUntil,
} from "./types"

export { DEFAULT_FORK_POINT_MARKER_NAME } from "./types"
