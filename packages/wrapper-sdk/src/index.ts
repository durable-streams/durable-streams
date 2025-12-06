/**
 * @durable-streams/wrapper-sdk
 *
 * SDK for building wrapper protocols on top of durable streams.
 *
 * This package provides:
 * - `WrapperProtocol` - Base class for building protocols
 * - `InMemoryStorage` - In-memory storage for development/testing
 * - Type definitions for streams, storage, and SDK operations
 *
 * @example
 * ```typescript
 * import {
 *   WrapperProtocol,
 *   InMemoryStorage,
 *   type Stream,
 * } from '@durable-streams/wrapper-sdk'
 *
 * class MyProtocol extends WrapperProtocol {
 *   async createSession(sessionId: string): Promise<Stream> {
 *     const stream = await this.sdk.createStream({
 *       url: `/v1/stream/sessions/${sessionId}`,
 *       contentType: 'application/json',
 *     })
 *     await this.state.set(`session:${sessionId}`, { createdAt: new Date() })
 *     return stream
 *   }
 *
 *   async onStreamCreated(stream: Stream): Promise<void> {
 *     console.log(`Session created: ${stream.id}`)
 *   }
 * }
 *
 * const protocol = new MyProtocol({
 *   baseUrl: 'https://streams.example.com',
 * })
 * ```
 *
 * @packageDocumentation
 */

// Primary exports
export { WrapperProtocol } from "./protocol"
export { InMemoryStorage } from "./storage/memory"
export { WrapperSDKError, type WrapperSDKErrorCode } from "./errors"

// Type exports
export type {
  // Core types
  Storage,
  Stream,
  StreamMetadata,
  StreamAppendOptions,
  WrapperSDK,
  WrapperProtocolOptions,
  CreateStreamOptions,
  FilterOptions,

  // Re-exported from client for convenience
  Auth,
  HeadersRecord,
  Offset,
} from "./types"

// Re-export underlying client error for error handling
export { DurableStreamError } from "@durable-streams/client"
