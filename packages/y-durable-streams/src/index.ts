/**
 * y-durable-streams - Yjs provider for Durable Streams
 *
 * Sync Yjs documents over append-only durable streams with optional
 * awareness (presence) support.
 *
 * @packageDocumentation
 */

export { YjsProvider, AWARENESS_HEARTBEAT_INTERVAL } from "./yjs-provider"

export type {
  YjsProviderOptions,
  YjsProviderEvents,
  YjsProviderStatus,
} from "./yjs-provider"

// Server exports are available via "@durable-streams/y-durable-streams/server"
// They are NOT re-exported here to keep the main entry point browser-compatible
