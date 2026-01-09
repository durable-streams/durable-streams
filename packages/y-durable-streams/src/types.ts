/**
 * Types for y-durable-streams provider.
 */

import type { Doc } from "yjs"
import type { Awareness } from "y-protocols/awareness"
import type { HeadersRecord, LiveMode } from "@durable-streams/client"

/**
 * Connection status of the provider.
 */
export type ProviderStatus = `disconnected` | `connecting` | `connected`

/**
 * Configuration for a stream endpoint.
 */
export interface StreamConfig {
  /**
   * The URL of the durable stream.
   */
  url: string | URL

  /**
   * Optional HTTP headers for requests.
   * Values can be static strings or functions that return strings.
   */
  headers?: HeadersRecord
}

/**
 * Configuration for awareness synchronization.
 */
export interface AwarenessConfig extends StreamConfig {
  /**
   * The Yjs Awareness protocol instance.
   */
  protocol: Awareness
}

/**
 * Options for creating a DurableStreamsProvider.
 */
export interface DurableStreamsProviderOptions {
  /**
   * The Yjs document to synchronize.
   */
  doc: Doc

  /**
   * Configuration for the document updates stream.
   */
  documentStream: StreamConfig

  /**
   * Optional configuration for awareness (presence) synchronization.
   * If not provided, awareness features will be disabled.
   */
  awarenessStream?: AwarenessConfig

  /**
   * Whether to automatically connect on construction.
   * @default true
   */
  connect?: boolean

  /**
   * Enable debug logging for troubleshooting.
   * When true, logs invalid updates and other debug information.
   * @default false
   */
  debug?: boolean

  /**
   * The live mode to use for streaming updates.
   * - "long-poll": Use long-polling for live updates
   * - "sse": Use Server-Sent Events for live updates
   * @default "long-poll"
   */
  liveMode?: Extract<LiveMode, `long-poll` | `sse`>
}

/**
 * Events emitted by the DurableStreamsProvider.
 */
export interface DurableStreamsProviderEvents {
  /**
   * Emitted when the sync state changes.
   * @param synced - Whether the provider is fully synced with the server
   */
  synced: (synced: boolean) => void

  /**
   * Emitted when the connection status changes.
   * @param status - The new connection status
   */
  status: (status: ProviderStatus) => void

  /**
   * Emitted when an error occurs.
   * @param error - The error that occurred
   */
  error: (error: Error) => void
}

/**
 * Internal type for awareness update events from y-protocols.
 */
export interface AwarenessUpdate {
  added: Array<number>
  updated: Array<number>
  removed: Array<number>
}
