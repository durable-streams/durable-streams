/**
 * Client types for the durable proxy.
 */

/**
 * Storage interface for persisting stream credentials.
 * Implementations can use localStorage, sessionStorage, or custom storage.
 */
export interface DurableStorage {
  /** Get a value by key */
  getItem: (key: string) => string | null
  /** Set a value by key */
  setItem: (key: string, value: string) => void
  /** Remove a value by key */
  removeItem: (key: string) => void
}

/**
 * Stored credentials for resuming a stream.
 */
export interface StreamCredentials {
  /** The pre-signed stream URL (includes expires/signature) */
  streamUrl: string
  /** The stream ID (UUID) */
  streamId: string
  /** The last known offset for resuming */
  offset: string
  /** Original upstream content type */
  upstreamContentType?: string
  /** When this stream was created (Unix timestamp in milliseconds) */
  createdAtMs: number
  /** When the pre-signed URL expires (Unix timestamp in seconds) */
  expiresAtSecs: number
}

/**
 * Stored credentials for session-based stream reuse.
 * Used to append multiple requests to the same stream.
 */
export interface SessionCredentials {
  /** The pre-signed stream URL (may be expired - still valid for writes) */
  streamUrl: string
  /** The stream ID (UUID) */
  streamId: string
}

/**
 * Options for creating a durable fetch wrapper.
 *
 * These options configure the proxy itself, not the upstream request.
 */
export interface DurableFetchOptions {
  /** Full base URL of the proxy endpoint (e.g., "https://proxy.example.com/v1/proxy") */
  proxyUrl: string
  /** Authorization for the proxy (service secret). Sent as ?secret= on POST. */
  proxyAuthorization: string
  /** Whether to automatically resume from stored credentials (default: true) */
  autoResume?: boolean
  /** Storage for persisting credentials (default: localStorage if available) */
  storage?: DurableStorage
  /** Custom fetch implementation */
  fetch?: typeof fetch
  /** Prefix for storage keys (default: 'durable-streams:') */
  storagePrefix?: string
  /**
   * Static session ID for stream reuse.
   * All requests made with this client will append to the same stream
   * unless overridden per-request.
   */
  sessionId?: string
  /**
   * Derive session ID from request parameters.
   * Called for each request to determine the session ID.
   * Takes precedence over static sessionId if both are provided.
   *
   * @param upstreamUrl - The upstream URL being requested
   * @param init - The request options
   * @returns Session ID string, or undefined to create a new stream
   */
  getSessionId?: (
    upstreamUrl: string,
    init?: DurableFetchRequestOptions
  ) => string | undefined
  /**
   * Optional TTL in seconds for signed URLs.
   * Sent as Stream-Signed-URL-TTL header. Server uses this as the expiry
   * duration for generated pre-signed URLs.
   * Default: server-configured (typically 7 days).
   */
  streamSignedUrlTtl?: number
  /**
   * Optional URL for the connect handler (origin endpoint).
   * When a session connects, the proxy forwards the request to this URL
   * with a Stream-Id header. The handler authorizes the session, reads
   * the raw stream to materialize message history, and returns the
   * history body + optional Stream-Offset header.
   */
  connectUrl?: string
  /**
   * Optional URL for renewing expired signed URLs.
   * When a read URL expires, the client will POST to /v1/proxy
   * with Renew-Stream-URL header and this as the Upstream-URL
   * to obtain a fresh signed URL. The endpoint must accept the
   * client's auth headers and return 2xx if the client is still authorized.
   *
   * If not configured, expired URLs surface as errors to the caller.
   */
  renewUrl?: string
}

/**
 * Options for a durable fetch request.
 *
 * Everything here is aimed at the upstream request. The client
 * transparently relabels `Authorization` -> `Upstream-Authorization`
 * and `method` -> `Upstream-Method` when sending to the proxy.
 */
export interface DurableFetchRequestOptions extends Omit<
  RequestInit,
  `method`
> {
  /** HTTP method for the upstream request (default: POST) */
  method?: string
  /** Optional request ID for resumability. If not provided, creates a fresh stream each time. */
  requestId?: string
  /**
   * Override session ID for this specific request.
   * Takes precedence over client-level sessionId/getSessionId.
   * Set to undefined to explicitly create a new stream.
   */
  sessionId?: string
}

/**
 * Extended Response with durable stream properties.
 */
export interface DurableResponse extends Response {
  /** The stream ID */
  streamId?: string
  /** The pre-signed stream URL */
  streamUrl?: string
  /** The current offset in the stream */
  offset?: string
  /** The upstream content type */
  upstreamContentType?: string
  /** Whether this response was resumed from a previous session */
  wasResumed?: boolean
}

/**
 * Response from a connect operation.
 */
export interface ConnectResponse {
  /** The origin's response body */
  body: Response[`body`]
  /** The pre-signed stream URL */
  streamUrl: string
  /** The stream ID */
  streamId: string
  /** Byte offset for SSE subscription (from origin's Stream-Offset header) */
  offset?: string
  /** The upstream content type */
  upstreamContentType?: string
  /** HTTP status code (200 for existing session, 201 for new) */
  status: number
  /** Full response headers */
  headers: Headers
}

/**
 * A durable fetch function with optional connect method.
 *
 * Signature mirrors standard fetch: (url, init) -> Response.
 * Everything in init is aimed at the upstream; proxy config is captured at creation time.
 */
export interface DurableFetch {
  (
    upstreamUrl: string | URL,
    init?: DurableFetchRequestOptions
  ): Promise<DurableResponse>

  /**
   * Connect to a session.
   *
   * Sends a connect operation to the proxy, which derives a stream ID
   * from the session ID, ensures the stream exists, and forwards the
   * request to the connect handler. Returns the origin's response body
   * (e.g., message history) along with the signed stream URL and offset.
   *
   * Requires `connectUrl` and `sessionId` to be configured.
   *
   * @param init - Optional request options (headers, body, signal)
   */
  connect: (
    init?: Omit<
      DurableFetchRequestOptions,
      `requestId` | `sessionId` | `method`
    >
  ) => Promise<ConnectResponse>
}
