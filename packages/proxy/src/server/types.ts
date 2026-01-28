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
  /** Secret key for signing pre-signed URLs (also used for JWT tokens in legacy mode) */
  jwtSecret: string
  /** TTL for streams in seconds (default: 86400 = 24 hours) */
  streamTtlSeconds?: number
  /** Maximum response size in bytes (default: 100MB) */
  maxResponseBytes?: number
  /** Idle timeout for upstream connections in milliseconds (default: 300000 = 5 min) */
  idleTimeoutMs?: number
  /** Service token for DELETE operations (optional) */
  serviceToken?: string
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
  /** The stream ID this connection is associated with */
  streamId: string
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
  /** URL of the upstream service to proxy (from Upstream-URL header) */
  upstreamUrl: string
  /** HTTP method for the upstream request (from Upstream-Method header, default: POST) */
  upstreamMethod?: string
  /** Authorization to forward to upstream (from Upstream-Authorization header) */
  upstreamAuth?: string
  /** Headers to forward to upstream */
  headers?: Record<string, string>
  /** Request body to send to upstream */
  body?: Buffer | string
}

/**
 * Internal state for a created proxy stream.
 */
export interface CreateStreamResult {
  /** The generated stream ID */
  streamId: string
  /** Path to the stream (for internal use) */
  streamPath: string
  /** Pre-signed URL path for the Location header */
  locationPath: string
  /** Content-Type from upstream response */
  upstreamContentType: string
}

/**
 * JWT payload for read tokens.
 * @deprecated Use pre-signed URLs instead. This is kept for backward compatibility.
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
