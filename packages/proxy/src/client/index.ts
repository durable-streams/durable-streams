/**
 * Durable Proxy Client
 *
 * Client utilities for creating resumable streaming requests through
 * the durable proxy server.
 *
 * @packageDocumentation
 */

// Main API
export { createDurableFetch, createAbortFn } from "./durable-fetch"
export { createDurableSession } from "./proxy-session"

// Storage utilities
export {
  MemoryStorage,
  getDefaultStorage,
  createRequestIdStorageKey,
  saveRequestIdMapping,
  loadRequestIdMapping,
  removeRequestIdMapping,
  createStorageKey,
  saveCredentials,
  loadCredentials,
  removeCredentials,
  isUrlExpired,
  extractStreamIdFromUrl,
  extractExpiresFromUrl,
} from "./storage"

// Types
export type {
  DurableStorage,
  RequestIdMapping,
  SessionCredentials,
  DurableFetchOptions,
  ProxySessionOptions,
  ProxyFetchOptions,
  ProxyResponse,
  DurableProxySession,
  DurableFetch,
  DurableFetchRequestOptions,
  DurableResponse,
  ConnectResponse,
} from "./types"
