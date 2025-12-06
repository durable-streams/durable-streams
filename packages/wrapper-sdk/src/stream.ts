/**
 * Stream implementation for @durable-streams/wrapper-sdk.
 */

import type { DurableStream } from "@durable-streams/writer"
import type {
  SDKHooks,
  Stream,
  StreamAppendOptions,
  StreamMetadata,
} from "./types"

/**
 * Options for creating a StreamImpl.
 */
export interface StreamImplOptions {
  /**
   * The stream's URL path identifier.
   */
  id: string

  /**
   * The underlying DurableStream handle.
   */
  durableStream: DurableStream

  /**
   * Lifecycle hooks for the SDK.
   */
  hooks: SDKHooks
}

/**
 * Implementation of the Stream interface.
 *
 * Wraps a DurableStream with high-level operations and lifecycle hooks.
 */
export class StreamImpl implements Stream {
  readonly id: string
  readonly #durableStream: DurableStream
  readonly #hooks: SDKHooks

  constructor(options: StreamImplOptions) {
    this.id = options.id
    this.#durableStream = options.durableStream
    this.#hooks = options.hooks
  }

  /**
   * The full stream URL.
   */
  get url(): string {
    return this.#durableStream.url
  }

  /**
   * The stream's content type.
   */
  get contentType(): string | undefined {
    return this.#durableStream.contentType
  }

  /**
   * Read stream data starting from an offset.
   *
   * Uses the underlying DurableStream's follow() method in catchup mode
   * for memory-efficient streaming without buffering the entire stream.
   *
   * @param offset - Starting offset (omit for beginning, or a previously returned offset)
   * @yields Uint8Array chunks of stream data
   */
  async *readFromOffset(offset?: string): AsyncIterable<Uint8Array> {
    // Use follow() in catchup mode for memory-efficient streaming
    for await (const chunk of this.#durableStream.follow({
      offset: offset,
      live: `catchup`,
    })) {
      // Only yield non-empty chunks
      if (chunk.data.length > 0) {
        yield chunk.data
      }
    }
  }

  /**
   * Get stream metadata for introspection.
   *
   * @returns Stream metadata including tail offset
   */
  async getMetadata(): Promise<StreamMetadata> {
    const head = await this.#durableStream.head()

    return {
      contentType: head.contentType,
      createdAt: null, // Not available from HEAD
      ttlSeconds: null, // Would need Stream-TTL header parsing
      expiresAt: null, // Would need Stream-Expires-At header parsing
      tailOffset: head.offset ?? `0_0`,
      lastAppendedAt: null, // Not tracked
    }
  }

  /**
   * Append data to the stream.
   *
   * @param data - Data to append (Uint8Array or string)
   * @param options - Optional append options (seq for ordering)
   */
  async append(
    data: Uint8Array | string,
    options?: StreamAppendOptions
  ): Promise<void> {
    // Encode string data to Uint8Array for the hook
    const encodedData =
      typeof data === `string` ? new TextEncoder().encode(data) : data

    // Append to the underlying stream
    await this.#durableStream.append(data, { seq: options?.seq })

    // Call the lifecycle hook
    await this.#hooks.onMessageAppended?.(this, encodedData)
  }

  /**
   * Get the underlying DurableStream handle.
   *
   * Escape hatch for advanced operations not exposed by the Stream interface.
   */
  get underlying(): DurableStream {
    return this.#durableStream
  }
}
