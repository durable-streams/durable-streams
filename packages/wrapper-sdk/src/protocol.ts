/**
 * WrapperProtocol base class for @durable-streams/wrapper-sdk.
 */

import { WrapperSDKImpl } from "./sdk"
import { InMemoryStorage } from "./storage/memory"
import type {
  Storage,
  Stream,
  WrapperProtocolOptions,
  WrapperSDK,
} from "./types"

/**
 * Base class for building wrapper protocols on top of durable streams.
 *
 * Provides access to:
 * - `this.sdk` - Stream CRUD operations
 * - `this.state` - Key-value state storage
 *
 * Subclasses can override lifecycle hooks to respond to stream events.
 *
 * @example
 * ```typescript
 * class MyProtocol extends WrapperProtocol {
 *   async createSession(sessionId: string) {
 *     const stream = await this.sdk.createStream({
 *       url: `/v1/stream/sessions/${sessionId}`,
 *       contentType: 'application/json',
 *     })
 *     await this.state.set(`session:${sessionId}`, { createdAt: new Date() })
 *     return stream
 *   }
 * }
 *
 * // Usage
 * const protocol = new MyProtocol({ baseUrl: 'https://streams.example.com' })
 * const stream = await protocol.createSession('abc123')
 * ```
 *
 * @example
 * ```typescript
 * // With lifecycle hooks
 * class LoggingProtocol extends WrapperProtocol {
 *   async onStreamCreated(stream: Stream): Promise<void> {
 *     console.log(`Stream created: ${stream.id}`)
 *   }
 *
 *   async onMessageAppended(stream: Stream, data: Uint8Array): Promise<void> {
 *     console.log(`Appended ${data.length} bytes to ${stream.id}`)
 *   }
 *
 *   async onStreamDeleted(stream: Stream): Promise<void> {
 *     console.log(`Stream deleted: ${stream.id}`)
 *   }
 * }
 * ```
 */
export abstract class WrapperProtocol {
  /**
   * Stream management operations.
   *
   * Use this to create, get, delete, and list streams.
   */
  protected readonly sdk: WrapperSDK

  /**
   * Key-value state storage.
   *
   * Use this to store protocol state, session metadata, etc.
   */
  protected readonly state: Storage

  /**
   * Create a new wrapper protocol instance.
   *
   * @param options - Configuration options
   */
  constructor(options: WrapperProtocolOptions) {
    // Use provided storage or default to in-memory
    this.state = options.storage ?? new InMemoryStorage()

    // Create the SDK implementation with bound hooks
    this.sdk = new WrapperSDKImpl({
      baseUrl: options.baseUrl,
      storage: this.state,
      auth: options.auth,
      headers: options.headers,
      fetch: options.fetch,
      hooks: {
        onStreamCreated: this.#boundOnStreamCreated.bind(this),
        onMessageAppended: this.#boundOnMessageAppended.bind(this),
        onStreamDeleted: this.#boundOnStreamDeleted.bind(this),
      },
    })
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Lifecycle Hooks (optional overrides)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Called after a stream is created.
   * Override to perform initialization logic.
   *
   * @param stream - The created stream
   * @param metadata - Optional metadata passed during creation
   */
  protected onStreamCreated?(stream: Stream, metadata?: unknown): Promise<void>

  /**
   * Called after data is appended to a stream.
   * Override for logging, analytics, or side effects.
   *
   * @param stream - The stream that was appended to
   * @param data - The data that was appended
   */
  protected onMessageAppended?(stream: Stream, data: Uint8Array): Promise<void>

  /**
   * Called after a stream is deleted.
   * Override for cleanup logic.
   *
   * @param stream - The deleted stream
   */
  protected onStreamDeleted?(stream: Stream): Promise<void>

  // ═══════════════════════════════════════════════════════════════════════════
  // Private hook wrappers
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Internal wrapper for onStreamCreated hook.
   * Uses optional chaining to safely call the hook if it's defined.
   */
  async #boundOnStreamCreated(
    stream: Stream,
    metadata?: unknown
  ): Promise<void> {
    await this.onStreamCreated?.(stream, metadata)
  }

  /**
   * Internal wrapper for onMessageAppended hook.
   */
  async #boundOnMessageAppended(
    stream: Stream,
    data: Uint8Array
  ): Promise<void> {
    await this.onMessageAppended?.(stream, data)
  }

  /**
   * Internal wrapper for onStreamDeleted hook.
   */
  async #boundOnStreamDeleted(stream: Stream): Promise<void> {
    await this.onStreamDeleted?.(stream)
  }
}
