import type { IncomingMessage, ServerResponse } from "node:http"

/**
 * Options for creating a proxy server.
 */
export interface ProxyServerOptions {
  /** Port to listen on (default: 4440) */
  port?: number
  /** Host to bind to (default: 'localhost') */
  host?: string
  /** URL of the durable-streams server to use for persistence */
  durableStreamsUrl: string
  /** Allowlist of upstream URL patterns (glob-style patterns supported) */
  allowlist?: Array<string>
  /** Secret key for signing JWT read tokens */
  jwtSecret: string
  /** TTL for streams in seconds (default: 86400 = 24 hours) */
  streamTtlSeconds?: number
  /** Maximum response size in bytes (default: 100MB) */
  maxResponseBytes?: number
  /** Idle timeout for upstream connections in milliseconds (default: 300000 = 5 min) */
  idleTimeoutMs?: number
}

/**
 * Control message appended to streams by the proxy.
 */
export type ControlMessage =
  | { type: `close`; reason: `complete` }
  | { type: `close`; reason: `aborted` }
  | { type: `close`; reason: `error`; error: ControlError }

/**
 * Error details in control messages.
 */
export interface ControlError {
  code: string
  status?: number
  message?: string
}

/**
 * State of an active upstream connection.
 */
export interface UpstreamConnection {
  /** The AbortController for canceling the upstream request */
  abortController: AbortController
  /** The stream key this connection is associated with */
  streamKey: string
  /** Timestamp when the connection started */
  startedAt: number
  /** Current offset in the durable stream */
  currentOffset: string
  /** Whether the upstream has completed */
  completed: boolean
  /** Whether this connection was aborted */
  aborted: boolean
}

/**
 * Request context passed to handlers.
 */
export interface RequestContext {
  req: IncomingMessage
  res: ServerResponse
  url: URL
  serviceName: string
}

/**
 * Options for creating a new proxy stream.
 */
export interface CreateStreamOptions {
  /** Unique key for this stream */
  streamKey: string
  /** URL of the upstream service to proxy */
  upstream: string
  /** HTTP method for the upstream request */
  method?: string
  /** Headers to forward to upstream */
  headers?: Record<string, string>
  /** Request body to send to upstream */
  body?: Buffer | string
}

/**
 * Response from creating a proxy stream.
 */
export interface CreateStreamResponse {
  /** Path to read the stream from */
  path: string
  /** JWT token for reading the stream */
  readToken: string
}

/**
 * JWT payload for read tokens.
 */
export interface ReadTokenPayload {
  /** Stream path */
  path: string
  /** Issued at timestamp */
  iat: number
  /** Expiration timestamp */
  exp: number
}

/**
 * A running proxy server instance.
 */
export interface ProxyServer {
  /** The full URL of the running server */
  url: string
  /** Stop the server */
  stop: () => Promise<void>
}
