/**
 * In-memory test server for durable-stream e2e testing.
 *
 * @packageDocumentation
 */

export { DurableStreamTestServer } from "./server"
export { StreamManager } from "./stream-manager"
export { MemoryStore } from "./memory-store"
export { FileStore } from "./file-store"
export { encodeStreamPath, decodeStreamPath } from "./path-encoding"
export { createRegistryHooks } from "./registry-hook"
export {
  calculateCursor,
  handleCursorCollision,
  generateResponseCursor,
  DEFAULT_CURSOR_EPOCH,
  DEFAULT_CURSOR_INTERVAL_SECONDS,
  type CursorOptions,
} from "./cursor"
export type {
  AppendMetadata,
  Store,
  StoreConfig,
  StreamInfo,
  StoredMessage,
  SerializableProducerState,
  ClosedByInfo,
} from "./store"
export type {
  Stream,
  StreamMessage,
  TestServerOptions,
  PendingLongPoll,
  StreamLifecycleEvent,
  StreamLifecycleHook,
} from "./types"
