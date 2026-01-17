/**
 * Types for AI SDK transports.
 */

import type { DurableStorage } from "../client/types"

/**
 * Base options shared by all durable transport implementations.
 */
export interface BaseDurableTransportOptions {
  /** Base URL of the proxy server */
  proxyUrl: string
  /** Storage for persisting credentials */
  storage?: DurableStorage
  /** Function to generate stream keys from messages */
  getStreamKey?: (messages: Array<unknown>, data?: unknown) => string
  /** Headers to include with requests */
  headers?: Record<string, string> | (() => Record<string, string>)
  /** Custom fetch implementation */
  fetch?: typeof fetch
}

/**
 * Options for creating a durable chat transport (Vercel AI SDK).
 */
export interface DurableChatTransportOptions extends BaseDurableTransportOptions {
  /** API endpoint for chat completions (used to construct upstream URL) */
  api?: string
}

/**
 * Options for creating a durable adapter (TanStack).
 */
export type DurableAdapterOptions = BaseDurableTransportOptions

/**
 * A Vercel AI SDK chat transport.
 *
 * Transports are the abstraction layer that handles how messages are
 * sent to and received from the AI backend.
 */
export interface ChatTransport {
  /** Send a chat completion request */
  send: (options: ChatTransportSendOptions) => Promise<ChatTransportResponse>
}

/**
 * Options for sending a chat request through the transport.
 */
export interface ChatTransportSendOptions {
  /** The messages to send */
  messages: Array<unknown>
  /** Additional request data */
  data?: unknown
  /** AbortSignal for cancellation */
  signal?: AbortSignal
  /** Headers to include with the request */
  headers?: Record<string, string>
  /** Request body overrides */
  body?: Record<string, unknown>
}

/**
 * Response from a chat transport.
 */
export interface ChatTransportResponse {
  /** The response stream */
  stream: ReadableStream<Uint8Array>
  /** Response headers */
  headers: Headers
  /** HTTP status code */
  status: number
  /** Whether this was resumed from a previous session */
  wasResumed?: boolean
}

/**
 * A TanStack connection adapter.
 */
export interface ConnectionAdapter {
  /** Connect and start receiving data */
  connect: (
    options: ConnectionAdapterOptions
  ) => Promise<ConnectionAdapterResponse>
  /** Abort the current connection */
  abort: () => Promise<void>
}

/**
 * Options for connecting through the adapter.
 */
export interface ConnectionAdapterOptions {
  /** The URL to connect to */
  url: string
  /** Request method */
  method?: string
  /** Request body */
  body?: unknown
  /** Headers to include */
  headers?: Record<string, string>
  /** AbortSignal for cancellation */
  signal?: AbortSignal
}

/**
 * Response from a connection adapter.
 */
export interface ConnectionAdapterResponse {
  /** The response stream */
  stream: ReadableStream<Uint8Array>
  /** Response headers */
  headers: Headers
  /** HTTP status code */
  status: number
}
