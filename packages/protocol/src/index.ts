/**
 * @durable-streams/protocol
 *
 * SDK for building protocols and APIs on top of Durable Streams.
 *
 * @example
 * ```typescript
 * import { createDispatcher, defineProtocol } from '@durable-streams/protocol'
 * import { StreamStore } from '@durable-streams/server'
 *
 * const store = new StreamStore()
 * const dispatcher = createDispatcher(store)
 *
 * // Register a protocol for Yjs collaboration
 * await dispatcher.register(defineProtocol({
 *   name: 'yjs',
 *   namespace: '/yjs/:docId/*',
 *   async handle(req, ctx) {
 *     // Handle Yjs sync messages
 *     if (req.method === 'POST') {
 *       await ctx.append(req.params.docId, req.body!)
 *       return { status: 200 }
 *     }
 *     // Let default handler process GET/HEAD
 *     return undefined
 *   }
 * }))
 *
 * // Dispatch requests
 * const response = await dispatcher.dispatch('POST', '/yjs/my-doc/sync', {
 *   url: new URL('http://localhost/yjs/my-doc/sync'),
 *   headers: new Headers({ 'content-type': 'application/octet-stream' }),
 *   body: new Uint8Array([...])
 * })
 * ```
 */

// Types
export type {
  HttpMethod,
  ProtocolRequest,
  ProtocolResponse,
  SSEEvent,
  ControlResponse,
  StreamInfo,
  CreateStreamOptions,
  AppendOptions,
  ReadOptions,
  ReadResult,
  StreamMessage,
  StreamContext,
  ProtocolHandler,
  Protocol,
  DispatcherConfig,
  ProtocolMatch,
} from "./types"

// Context
export {
  ScopedStreamContext,
  createStreamContext,
  type StoreAdapter,
  type ScopedStreamContextOptions,
} from "./context"

// Dispatcher
export {
  ProtocolDispatcher,
  createDispatcher,
  formatSSEEvent,
  streamSSE,
} from "./dispatcher"

// Protocol helpers
export { defineProtocol, createProtocolBuilder } from "./helpers"

// Example protocols
export * from "./examples/index"
