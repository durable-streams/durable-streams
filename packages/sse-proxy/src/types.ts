/**
 * SSE Proxy Types
 */

/**
 * Function to generate a unique stream path from a request.
 * The returned string will be used as the stream identifier.
 */
export type RequestHasher = (
  request: RequestInfo | URL,
  init?: RequestInit
) => string | Promise<string>

/**
 * Options for creating an SSE proxy fetch client.
 */
export interface SSEProxyFetchOptions {
  /**
   * The URL of the SSE proxy server.
   * E.g., "https://proxy.example.com"
   */
  proxyUrl: string

  /**
   * Custom function to generate stream paths from requests.
   * By default, uses a hash of the URL, method, and relevant headers.
   */
  hashRequest?: RequestHasher

  /**
   * Base fetch implementation to use for non-SSE requests.
   * Defaults to globalThis.fetch.
   */
  fetch?: typeof globalThis.fetch

  /**
   * Headers to include when communicating with the proxy server.
   * These are NOT the headers sent to the backend SSE server.
   */
  proxyHeaders?: Record<string, string>
}

/**
 * Request details sent to the proxy server to initiate an SSE connection.
 */
export interface ProxyInitiateRequest {
  /**
   * The target SSE URL to proxy.
   */
  url: string

  /**
   * HTTP method (usually GET for SSE).
   */
  method: string

  /**
   * Headers to send to the backend SSE server.
   */
  headers: Record<string, string>

  /**
   * Request body (if any).
   */
  body?: string

  /**
   * The computed stream path for this request.
   */
  streamPath: string
}

/**
 * Response from the proxy server after initiating an SSE connection.
 */
export interface ProxyInitiateResponse {
  /**
   * The full URL to the durable stream for this SSE connection.
   */
  streamUrl: string

  /**
   * The stream path/ID.
   */
  streamPath: string

  /**
   * Whether the stream was newly created or already existed.
   */
  created: boolean

  /**
   * The starting offset for reading (usually "-1" for new streams).
   */
  offset: string
}

/**
 * Options for the SSE proxy server.
 */
export interface SSEProxyServerOptions {
  /**
   * The base URL of the durable streams server for writing proxied data.
   * E.g., "https://streams.example.com"
   */
  streamsUrl: string

  /**
   * The public URL of the durable streams server returned to clients.
   * Defaults to streamsUrl. Use this when the internal and external URLs differ.
   * E.g., internal: "http://streams:3001", public: "https://streams.example.com"
   */
  publicStreamsUrl?: string

  /**
   * Headers to include when writing to the durable streams server.
   */
  streamsHeaders?: Record<string, string>

  /**
   * Base fetch implementation for the server.
   * Defaults to globalThis.fetch.
   */
  fetch?: typeof globalThis.fetch

  /**
   * Time-to-live for streams in seconds.
   * Defaults to 3600 (1 hour).
   */
  streamTTLSeconds?: number

  /**
   * Hook called when a new proxy connection is initiated.
   * Can be used for logging, auth validation, etc.
   */
  onProxyStart?: (request: ProxyInitiateRequest) => void | Promise<void>

  /**
   * Hook called when a proxy connection ends.
   */
  onProxyEnd?: (streamPath: string, error?: Error) => void | Promise<void>
}

/**
 * Internal state for tracking active proxy connections.
 */
export interface ActiveProxyConnection {
  /**
   * AbortController to cancel the backend SSE connection.
   */
  abortController: AbortController

  /**
   * The stream path being written to.
   */
  streamPath: string

  /**
   * Timestamp when the connection was started.
   */
  startedAt: number
}
