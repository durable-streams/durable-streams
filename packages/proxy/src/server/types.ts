/**
 * Types for the proxy server.
 */

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
  /** Allowlist of upstream URL patterns */
  allowlist?: Array<string>
  /** Secret key for signing pre-signed URLs and validating service JWT */
  jwtSecret: string
  /** TTL for streams in seconds (default: 86400 = 24 hours) */
  streamTtlSeconds?: number
  /** TTL for pre-signed URLs in seconds (default: 86400 = 24 hours) */
  urlExpirationSeconds?: number
  /** Maximum response size in bytes (default: 100MB) */
  maxResponseBytes?: number
}

/**
 * State of an active upstream connection.
 */
export interface UpstreamConnection {
  /** Unique connection ID for this upstream request */
  connectionId: string
  /** The AbortController for canceling the upstream request */
  abortController: AbortController
  /** The stream ID this connection is associated with */
  streamId: string
  /** Response ID assigned to this upstream response */
  responseId: number
  /** Timestamp when the connection started */
  startedAt: number
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
