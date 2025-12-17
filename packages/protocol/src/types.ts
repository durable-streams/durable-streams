/**
 * Types for the Durable Streams Protocol SDK.
 *
 * This SDK enables building APIs and protocols on top of durable streams
 * by registering handlers for namespace patterns (e.g., /yjs/*, /automerge/*).
 */

/**
 * HTTP methods supported by the protocol dispatcher.
 */
export type HttpMethod = `GET` | `POST` | `PUT` | `DELETE` | `HEAD` | `OPTIONS`

/**
 * Parsed request information passed to protocol handlers.
 */
export interface ProtocolRequest {
  /** HTTP method */
  method: HttpMethod

  /** Full URL path (e.g., /yjs/doc-123/awareness) */
  path: string

  /** Path relative to the protocol namespace (e.g., /doc-123/awareness for namespace /yjs/*) */
  subpath: string

  /** Parsed URL with query parameters */
  url: URL

  /** Request headers (lowercase keys) */
  headers: Headers

  /** Raw request body (if any) */
  body?: Uint8Array

  /**
   * Parsed route parameters from the namespace pattern.
   * For pattern "/yjs/:docId/*", request "/yjs/abc/awareness" yields { docId: "abc" }
   */
  params: Record<string, string>

  /**
   * Wildcard capture from pattern.
   * For pattern "/yjs/:docId/*", request "/yjs/abc/awareness" yields "*" = "awareness"
   */
  wildcard?: string
}

/**
 * Response from a protocol handler.
 */
export interface ProtocolResponse {
  /** HTTP status code */
  status: number

  /** Response headers */
  headers?: Record<string, string>

  /** Response body (string, bytes, or JSON-serializable object) */
  body?: string | Uint8Array | object

  /**
   * For streaming responses (SSE), provide an async iterable.
   * Each yielded value is sent as an SSE event.
   */
  stream?: AsyncIterable<SSEEvent>
}

/**
 * SSE event for streaming responses.
 */
export interface SSEEvent {
  /** Event type (defaults to "message") */
  event?: string

  /** Event data (will be JSON-stringified if object) */
  data: string | object

  /** Optional event ID */
  id?: string

  /** Retry interval in ms (sent to client) */
  retry?: number
}

/**
 * Control response that instructs clients to take special actions.
 */
export interface ControlResponse {
  /** Tell clients they must refetch from a new location */
  mustRefetch?: {
    /** New stream URL to fetch from */
    url: string

    /** Optional offset to start from */
    offset?: string
  }
}

/**
 * Stream metadata returned from operations.
 */
export interface StreamInfo {
  /** Stream path */
  path: string

  /** Content type */
  contentType?: string

  /** Current offset (position after last message) */
  currentOffset: string

  /** When the stream was created */
  createdAt: number

  /** TTL in seconds (if set) */
  ttlSeconds?: number

  /** Absolute expiry time (if set) */
  expiresAt?: string
}

/**
 * Options for creating a stream.
 */
export interface CreateStreamOptions {
  /** Content type (defaults to application/json) */
  contentType?: string

  /** Initial data to write */
  initialData?: Uint8Array | string | object

  /** TTL in seconds */
  ttlSeconds?: number

  /** Absolute expiry timestamp (ISO 8601) */
  expiresAt?: string
}

/**
 * Options for appending to a stream.
 */
export interface AppendOptions {
  /** Sequence number for writer coordination */
  seq?: string
}

/**
 * Options for reading from a stream.
 */
export interface ReadOptions {
  /** Starting offset ("-1" for beginning) */
  offset?: string

  /** Read mode */
  mode?: `catch-up` | `long-poll` | `sse`

  /** Cursor for CDN collapsing */
  cursor?: string
}

/**
 * Result from reading a stream.
 */
export interface ReadResult {
  /** Messages read */
  messages: StreamMessage[]

  /** Next offset to use for subsequent reads */
  nextOffset: string

  /** Whether the stream is caught up */
  upToDate: boolean
}

/**
 * A message in a stream.
 */
export interface StreamMessage {
  /** Message data */
  data: Uint8Array

  /** Offset after this message */
  offset: string

  /** When the message was appended */
  timestamp: number
}

/**
 * Scoped context for stream operations within a namespace.
 * All stream paths are automatically prefixed with the namespace.
 */
export interface StreamContext {
  /** The namespace this context is scoped to (e.g., "/yjs") */
  readonly namespace: string

  /**
   * Create a new stream within the namespace.
   * @param subpath - Path within namespace (e.g., "doc-123" becomes "/yjs/doc-123")
   * @param options - Stream creation options
   * @returns Stream info
   */
  create(subpath: string, options?: CreateStreamOptions): Promise<StreamInfo>

  /**
   * Get stream metadata.
   * @param subpath - Path within namespace
   * @returns Stream info or undefined if not found
   */
  get(subpath: string): Promise<StreamInfo | undefined>

  /**
   * Check if a stream exists.
   * @param subpath - Path within namespace
   */
  has(subpath: string): Promise<boolean>

  /**
   * Append data to a stream.
   * @param subpath - Path within namespace
   * @param data - Data to append
   * @param options - Append options
   * @returns The message that was appended
   */
  append(
    subpath: string,
    data: Uint8Array | string | object,
    options?: AppendOptions
  ): Promise<StreamMessage>

  /**
   * Read messages from a stream.
   * @param subpath - Path within namespace
   * @param options - Read options
   * @returns Messages and metadata
   */
  read(subpath: string, options?: ReadOptions): Promise<ReadResult>

  /**
   * Delete a stream.
   * @param subpath - Path within namespace
   */
  delete(subpath: string): Promise<void>

  /**
   * List all streams within a subpath pattern.
   * @param prefix - Prefix to filter by (e.g., "doc-" lists "/yjs/doc-*")
   * @returns Array of stream infos
   */
  list(prefix?: string): Promise<StreamInfo[]>

  /**
   * Wait for new messages on a stream.
   * @param subpath - Path within namespace
   * @param offset - Current offset
   * @param timeout - Max wait time in ms
   * @returns New messages or timeout indicator
   */
  waitForMessages(
    subpath: string,
    offset: string,
    timeout: number
  ): Promise<{ messages: StreamMessage[]; timedOut: boolean }>

  /**
   * Compact a stream by creating a new stream with compacted state.
   * Useful for state streams that accumulate changes over time.
   *
   * @param subpath - Path of stream to compact
   * @param compactor - Function that takes current messages and returns compacted data
   * @returns Info about the new compacted stream, or undefined if compaction not needed
   */
  compact(
    subpath: string,
    compactor: (messages: StreamMessage[]) => Uint8Array | string | object
  ): Promise<{ oldStream: StreamInfo; newStream: StreamInfo } | undefined>
}

/**
 * Protocol handler function signature.
 */
export type ProtocolHandler = (
  request: ProtocolRequest,
  context: StreamContext
) => Promise<ProtocolResponse | void>

/**
 * A protocol implementation that handles requests for a namespace.
 */
export interface Protocol {
  /**
   * Unique name for this protocol (used for logging/debugging).
   */
  name: string

  /**
   * Namespace pattern this protocol handles.
   * Supports:
   * - Exact match: "/yjs"
   * - Wildcard suffix: "/yjs/*"
   * - Named params: "/yjs/:docId"
   * - Combined: "/yjs/:docId/*"
   */
  namespace: string

  /**
   * Handle an incoming request.
   * Return a ProtocolResponse to send a custom response.
   * Return void/undefined to let the default stream handler process the request.
   */
  handle: ProtocolHandler

  /**
   * Optional lifecycle hooks.
   */
  hooks?: {
    /** Called when a stream is created within this namespace */
    onStreamCreated?: (info: StreamInfo, context: StreamContext) => Promise<void>

    /** Called when a stream is deleted within this namespace */
    onStreamDeleted?: (path: string, context: StreamContext) => Promise<void>

    /** Called when the protocol is registered */
    onRegister?: (context: StreamContext) => Promise<void>

    /** Called when the protocol is unregistered */
    onUnregister?: (context: StreamContext) => Promise<void>
  }
}

/**
 * Configuration for the protocol dispatcher.
 */
export interface DispatcherConfig {
  /**
   * Base path prefix for all protocols (e.g., "/v1/stream").
   * Defaults to "/v1/stream".
   */
  basePath?: string

  /**
   * Default handler for requests that don't match any protocol.
   * If not provided, returns 404.
   */
  defaultHandler?: ProtocolHandler
}

/**
 * Result of matching a request to a protocol.
 */
export interface ProtocolMatch {
  /** The matched protocol */
  protocol: Protocol

  /** Parsed route parameters */
  params: Record<string, string>

  /** Wildcard capture */
  wildcard?: string

  /** Path relative to the namespace */
  subpath: string
}
