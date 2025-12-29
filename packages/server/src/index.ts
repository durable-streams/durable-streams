/**
 * In-memory test server for durable-stream e2e testing.
 *
 * @packageDocumentation
 */

export { DurableStreamTestServer } from "./server"
export { DurableStreamRouter } from "./router"
export { CORSMiddleware, type CORSOptions } from "./cors-middleware"
export {
  CompressionMiddleware,
  type CompressionOptions,
} from "./compression-middleware"
export {
  FaultInjectionMiddleware,
  type InjectedError,
  type FaultInjectionOptions,
} from "./fault-injection"
export { StreamStore } from "./store"
export { FileBackedStreamStore } from "./file-store"
export type {
  StreamStorage,
  CreateStreamOptions,
  AppendOptions,
  ReadResult,
  WaitResult,
} from "./storage"
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
  Stream,
  StreamMessage,
  TestServerOptions,
  RouterOptions,
  PendingLongPoll,
  StreamLifecycleEvent,
  StreamLifecycleHook,
} from "./types"
