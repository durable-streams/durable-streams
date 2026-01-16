/**
 * AI SDK Transports for Durable Proxy
 *
 * Provides integration with popular AI SDK libraries for
 * transparent reconnection of streaming responses.
 *
 * @packageDocumentation
 */

// Vercel AI SDK transport
export { createDurableChatTransport, wasResumed } from "./vercel"

// TanStack AI adapter
export { createDurableAdapter } from "./tanstack"

// Types
export type {
  BaseDurableTransportOptions,
  DurableChatTransportOptions,
  DurableAdapterOptions,
  ChatTransport,
  ChatTransportSendOptions,
  ChatTransportResponse,
  ConnectionAdapter,
  ConnectionAdapterOptions,
  ConnectionAdapterResponse,
} from "./types"
