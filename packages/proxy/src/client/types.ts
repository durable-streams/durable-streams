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
   * Origin to use when resolving relative upstream URLs.
   * If the upstream URL is a path (e.g., "/v1/chat"), it will be resolved against this origin.
   * Falls back to window.location.origin if available.
   * Required when using relative URLs in non-browser environments.
   */
  origin?: string
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
 * A durable fetch function.
 *
 * Signature mirrors standard fetch: (url, init) -> Response.
 * Everything in init is aimed at the upstream; proxy config is captured at creation time.
 */
export type DurableFetch = (
  upstreamUrl: string | URL,
  init?: DurableFetchRequestOptions
) => Promise<DurableResponse>
