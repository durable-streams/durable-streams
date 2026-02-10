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
  /** Build the backend URL path for a stream. Default: (id) => `/v1/streams/${id}` */
  streamPath?: (streamId: string) => string
  /** Headers to include on all requests to the durable-streams backend.
   *  Static object or async function for per-request headers (e.g., short-lived JWTs). */
  backendHeaders?:
    | Record<string, string>
    | ((ctx: {
        streamId: string
        method: string
      }) => Record<string, string> | Promise<Record<string, string>>)
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
