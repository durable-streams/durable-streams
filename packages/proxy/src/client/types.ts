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
  /** The stream path on the proxy */
  path: string
  /** The read token for authentication */
  readToken: string
  /** The last known offset */
  offset: string
  /** When this stream was created */
  createdAt: number
}

/**
 * Options for creating a durable fetch wrapper.
 */
export interface DurableFetchOptions {
  /** Base URL of the proxy server */
  proxyUrl: string
  /** Storage for persisting credentials (default: localStorage if available) */
  storage?: DurableStorage
  /** Custom fetch implementation */
  fetch?: typeof fetch
  /** Prefix for storage keys (default: 'durable-streams:') */
  storagePrefix?: string
  /** Whether to automatically resume on reconnection (default: true) */
  autoResume?: boolean
}

/**
 * Options for a durable fetch request.
 */
export interface DurableFetchRequestOptions extends RequestInit {
  /** Unique key for this stream (required for resumability) */
  stream_key: string
  /** Whether this is a resume request (internal use) */
  _isResume?: boolean
}

/**
 * Extended Response with durable stream properties.
 */
export interface DurableResponse extends Response {
  /** The stream path for this response */
  durableStreamPath?: string
  /** The current offset in the stream */
  durableStreamOffset?: string
  /** Whether this response was resumed from a previous session */
  wasResumed?: boolean
}

/**
 * A durable fetch function that wraps the standard fetch API.
 */
export type DurableFetch = (
  input: RequestInfo | URL,
  init?: DurableFetchRequestOptions
) => Promise<DurableResponse>
