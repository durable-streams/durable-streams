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
  type HeadResult,
  type Offset,
  type ResponseMetadata,
  // Re-export errors
  FetchError,
  InvalidSignalError,
  MissingStreamUrlError,
} from "@durable-streams/client"

export * from "./writer"
