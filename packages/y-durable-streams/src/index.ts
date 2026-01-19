/**
 * y-durable-streams - Yjs provider for Durable Streams
 *
 * Sync Yjs documents over append-only durable streams with optional
 * awareness (presence) support.
 *
 * @packageDocumentation
 */

// New Yjs Protocol Provider (recommended)
export {
  YjsProvider,
  AWARENESS_HEARTBEAT_INTERVAL as YJS_AWARENESS_HEARTBEAT_INTERVAL,
} from "./yjs-provider"

export type {
  YjsProviderOptions,
  YjsProviderEvents,
  YjsProviderStatus,
} from "./yjs-provider"

// Legacy provider (direct durable streams access)
export {
  DurableStreamsProvider,
  AWARENESS_HEARTBEAT_INTERVAL,
} from "./y-durable-streams"

export type {
  DurableStreamsProviderOptions,
  DurableStreamsProviderEvents,
  ProviderStatus,
  StreamConfig,
  AwarenessConfig,
  AwarenessUpdate,
} from "./types"

// Server exports are available via "@durable-streams/y-durable-streams/server"
// They are NOT re-exported here to keep the main entry point browser-compatible
