/**
 * Effect-based client for Durable Streams.
 *
 * @example
 * ```typescript
 * import { Effect, Layer } from "effect"
 * import {
 *   DurableStreamClient,
 *   DurableStreamClientLiveNode,
 * } from "@durable-streams/client-effect"
 *
 * const program = Effect.gen(function* () {
 *   const client = yield* DurableStreamClient
 *
 *   // Create a stream
 *   yield* client.create("https://example.com/streams/my-stream", {
 *     contentType: "application/json",
 *   })
 *
 *   // Append data
 *   yield* client.append(
 *     "https://example.com/streams/my-stream",
 *     JSON.stringify({ message: "hello" })
 *   )
 *
 *   // Read stream
 *   const session = yield* client.stream("https://example.com/streams/my-stream")
 *   const items = yield* session.json()
 *   console.log(items)
 * })
 *
 * Effect.runPromise(
 *   program.pipe(Effect.provide(DurableStreamClientLiveNode()))
 * )
 * ```
 *
 * @module
 */

// =============================================================================
// Main Client
// =============================================================================

export {
  DurableStreamClient,
  DurableStreamClientLive,
  DurableStreamClientLiveNode,
  type DurableStreamClientConfig,
} from "./DurableStreamClient.js"

// =============================================================================
// HTTP Client
// =============================================================================

export {
  DurableStreamsHttpClient,
  DurableStreamsHttpClientLive,
  extractOffset,
  extractCursor,
  isUpToDate,
  buildStreamUrl,
  type DurableStreamsHttpClientConfig,
  type RequestOptions,
  type DurableStreamsResponse,
} from "./HttpClient.js"

// =============================================================================
// Stream Session
// =============================================================================

export { makeStreamSession } from "./StreamSession.js"

// =============================================================================
// Idempotent Producer
// =============================================================================

export {
  makeIdempotentProducer,
  type IdempotentProducer,
} from "./IdempotentProducer.js"

// =============================================================================
// SSE Parser
// =============================================================================

export {
  parseSSEStream,
  filterDataEvents,
  findControlEvent,
  collectSSE,
  type SSEEvent,
  type SSEDataEvent,
  type SSEControlEvent,
  type SSEResult,
} from "./SSE.js"

// =============================================================================
// Errors
// =============================================================================

export {
  StreamNotFoundError,
  StreamConflictError,
  ContentTypeMismatchError,
  InvalidOffsetError,
  SequenceConflictError,
  StaleEpochError,
  SequenceGapError,
  ProducerClosedError,
  InvalidProducerOptionsError,
  HttpError,
  NetworkError,
  TimeoutError,
  ParseError,
  SSEParseError,
  type ClientError,
} from "./errors.js"

// =============================================================================
// Types
// =============================================================================

export {
  type Offset,
  type LiveMode,
  type DynamicValue,
  type HeadersRecord,
  type ParamsRecord,
  type BaseOptions,
  type CreateOptions,
  type AppendOptions,
  type StreamOptions,
  type ProducerOptions,
  type CreateResult,
  type HeadResult,
  type AppendResult,
  type ChunkMeta,
  type Batch,
  type ByteChunk,
  type StreamSession,
  Headers,
  QueryParams,
  SSEFields,
} from "./types.js"

// =============================================================================
// Internal Utilities (for advanced use)
// =============================================================================

export {
  resolveHeaders,
  resolveParams,
  mergeHeaders,
  mergeParams,
} from "./internal/headers.js"

export {
  makeRetrySchedule,
  isRetryableStatus,
  retryWithBackoff,
  DefaultRetryOptions,
  type RetryOptions,
} from "./internal/retry.js"

export {
  makeBatchQueue,
  normalizeContentType,
  isJsonContentType,
  encodeBatchData,
  type BatchQueue,
  type BatchQueueConfig,
  type PendingMessage,
  type Batch as BatchQueueBatch,
} from "./internal/batching.js"
