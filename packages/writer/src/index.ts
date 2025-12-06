/**
 * @durable-streams/writer
 *
 * Writer client for Durable Streams with create/append/delete operations.
 * Extends the read-only client with write capabilities for server-side use.
 */

export {
  // Re-export types from client for convenience
  type DurableStreamOptions,
  type StreamOptions,
  type ReadOptions,
  type ReadResult,
  type HeadResult,
  type StreamChunk,
  type Offset,
  // Re-export errors
  FetchError,
  InvalidSignalError,
  MissingStreamUrlError,
  type ErrorDetails,
} from "@durable-streams/client"

export * from "./writer"
