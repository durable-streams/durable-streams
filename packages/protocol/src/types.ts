/**
 * Types for the Durable Streams Protocol SDK.
 *
 * This SDK enables building APIs and protocols on top of durable streams
 * using Hono for HTTP routing. Protocols are stateless and derive all
 * information from the request URL.
 */

import type { Hono } from "hono"
import type { DurableStream } from "@durable-streams/client"

/**
 * Environment variables that can be passed to protocols.
 */
export interface ProtocolEnv {
  /** Base URL for streams (e.g., "https://streams.example.com/v1/stream") */
  STREAM_BASE_URL: string

  /** Additional variables */
  [key: string]: unknown
}

/**
 * Hono environment for protocol routes.
 */
export interface ProtocolHonoEnv {
  Bindings: ProtocolEnv
  Variables: {
    /** Get a stream handle for a subpath within the protocol's namespace */
    stream: (subpath: string) => DurableStream
    /** The protocol's namespace prefix */
    namespace: string
  }
}

/**
 * Configuration for creating a protocol.
 */
export interface ProtocolConfig {
  /** Base URL for streams */
  baseUrl: string

  /** Optional headers to include in all stream requests */
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>)

  /** Optional custom fetch function */
  fetch?: typeof fetch
}

/**
 * Options for creating a stream.
 */
export interface CreateStreamOptions {
  /** Content type (defaults to application/json) */
  contentType?: string

  /** Initial data to write */
  body?: Uint8Array | string | unknown

  /** TTL in seconds */
  ttlSeconds?: number

  /** Absolute expiry timestamp (ISO 8601) */
  expiresAt?: string
}

/**
 * A protocol definition.
 */
export interface Protocol {
  /** Unique name for this protocol */
  name: string

  /** Namespace prefix (e.g., "/yjs") */
  namespace: string

  /**
   * Create the Hono app with routes for this protocol.
   * Routes are relative to the namespace.
   *
   * @param config - Configuration for stream access
   * @returns Hono app
   */
  createApp(config: ProtocolConfig): Hono<ProtocolHonoEnv>
}

/**
 * Factory function signature for creating protocols.
 */
export type ProtocolFactory = (options?: Record<string, unknown>) => Protocol
