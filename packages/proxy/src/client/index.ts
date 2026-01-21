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

// Storage utilities
export {
  MemoryStorage,
  getDefaultStorage,
  createScopeFromUrl,
  saveCredentials,
  loadCredentials,
  removeCredentials,
  updateOffset,
  isExpired,
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
