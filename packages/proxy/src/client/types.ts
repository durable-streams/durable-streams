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

export interface SessionCredentials {
  streamUrl: string
  streamId: string
}

export interface RequestIdMapping {
  responseId: number
  streamUrl?: string
}

export interface DurableFetchOptions {
  proxyUrl: string
  proxyAuthorization: string
  storage?: DurableStorage
  storagePrefix?: string
  fetch?: typeof fetch
}

export interface ProxySessionOptions extends DurableFetchOptions {
  streamId: string
  connectUrl?: string
  streamSignedUrlTtl?: number
}

export interface ProxyFetchOptions extends Omit<RequestInit, `method`> {
  method?: string
  requestId?: string
}

export interface ProxyResponse extends Response {
  responseId: number
}

export interface DurableProxySession {
  readonly streamUrl: string | null
  readonly streamId: string
  fetch: (
    upstreamUrl: string | URL,
    options?: ProxyFetchOptions
  ) => Promise<ProxyResponse>
  responses: () => AsyncIterable<ProxyResponse>
  connect: () => Promise<void>
  abort: () => Promise<void>
  close: () => void
}

export interface DurableResponse extends ProxyResponse {
  streamUrl?: string
  streamId?: string
  wasResumed?: boolean
}

export type DurableFetch = (
  upstreamUrl: string | URL,
  options?: ProxyFetchOptions
) => Promise<DurableResponse>

// Legacy aliases kept for existing transport typings.
export type DurableFetchRequestOptions = ProxyFetchOptions
export interface ConnectResponse {
  streamUrl: string
  streamId: string
  status: number
  headers: Headers
}
