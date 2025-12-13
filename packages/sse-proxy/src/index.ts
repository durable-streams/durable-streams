/**
 * SSE Proxy for Durable Streams
 *
 * A library for proxying Server-Sent Events (SSE) through durable streams,
 * providing resilient, resumable SSE connections.
 *
 * @packageDocumentation
 */

// ============================================================================
// Client API
// ============================================================================

export { createSSEProxyFetch } from "./client"

// ============================================================================
// Server API
// ============================================================================

export { createSSEProxyServer } from "./server"

// ============================================================================
// Hashing Utilities
// ============================================================================

export { defaultHashRequest, createRequestHasher } from "./hash"

// ============================================================================
// Types
// ============================================================================

export type {
  // Client types
  SSEProxyFetchOptions,
  RequestHasher,

  // Server types
  SSEProxyServerOptions,
  ActiveProxyConnection,

  // Request/response types
  ProxyInitiateRequest,
  ProxyInitiateResponse,
} from "./types"
