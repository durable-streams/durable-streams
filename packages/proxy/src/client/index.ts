/**
 * Durable Proxy Client
 *
 * Client utilities for creating resumable streaming requests through
 * the durable proxy server.
 *
 * @packageDocumentation
 */

// Main API
export {
  createDurableFetch,
  createAbortFn,
  isAbsoluteUrl,
  resolveUpstreamUrl,
} from "./durable-fetch"

// Storage utilities
export {
  MemoryStorage,
  getDefaultStorage,
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
  StreamCredentials,
  DurableFetchOptions,
  DurableFetchRequestOptions,
  DurableResponse,
  DurableFetch,
} from "./types"
