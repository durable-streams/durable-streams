/**
 * y-durable-streams - Yjs provider for Durable Streams
 *
 * Sync Yjs documents over append-only durable streams with optional
 * awareness (presence) support.
 *
 * @packageDocumentation
 */

// Main provider class
export { DurableStreamsProvider } from "./y-durable-streams"

// Types
export type {
  DurableStreamsProviderOptions,
  DurableStreamsProviderEvents,
  ProviderStatus,
  StreamConfig,
  AwarenessConfig,
  AwarenessUpdate,
} from "./types"

// Framing utilities (useful for custom implementations)
export { frameUpdate, parseFramedUpdates } from "./framing"
