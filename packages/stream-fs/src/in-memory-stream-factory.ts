/**
 * In-Memory Stream Factory
 *
 * A simple in-memory implementation of StreamFactory for testing and development.
 * Uses a Map to store stream data without any persistence.
 */

import type {
  DurableStream,
  DurableStreamOptions,
  StreamResponse,
  CreateStreamOptions as DSCreateOptions,
  StreamOptions,
  AppendStreamOptions,
  HeadResult,
} from "@durable-streams/client"
import type { StreamFactory, CreateStreamOptions } from "./types"

// =============================================================================
// In-Memory Stream Implementation
// =============================================================================

/**
 * A simple in-memory stream that mimics DurableStream behavior
 */
class InMemoryStream implements DurableStream {
  private data: string[] = []
  private closed = false
  private contentType: string

  constructor(
    public readonly url: string,
    options?: { contentType?: string }
  ) {
    this.contentType = options?.contentType ?? "application/octet-stream"
  }

  // Create is a no-op for in-memory (stream exists when factory creates it)
  async create(options?: DSCreateOptions): Promise<void> {
    // Already created
  }

  async head(): Promise<HeadResult> {
    return {
      exists: true,
      offset: String(this.data.length),
      streamClosed: this.closed,
      contentType: this.contentType,
    }
  }

  async delete(): Promise<void> {
    this.data = []
    this.closed = false
  }

  async append(
    data: string | Uint8Array | object,
    options?: AppendStreamOptions
  ): Promise<{ offset: string }> {
    if (this.closed) {
      throw new Error("Stream is closed")
    }

    let stringData: string
    if (typeof data === "string") {
      stringData = data
    } else if (data instanceof Uint8Array) {
      stringData = new TextDecoder().decode(data)
    } else {
      stringData = JSON.stringify(data)
    }

    this.data.push(stringData)

    if (options?.close) {
      this.closed = true
    }

    return { offset: String(this.data.length) }
  }

  async close(options?: { finalData?: string | Uint8Array | object }): Promise<{
    offset: string
    alreadyClosed: boolean
  }> {
    const alreadyClosed = this.closed
    if (options?.finalData) {
      await this.append(options.finalData)
    }
    this.closed = true
    return { offset: String(this.data.length), alreadyClosed }
  }

  async stream<T = unknown>(options?: StreamOptions): Promise<StreamResponse<T>> {
    const startOffset = options?.offset ? parseInt(options.offset, 10) : 0
    const items = this.data.slice(startOffset)

    // Parse items if JSON content type
    const parsedItems =
      this.contentType === "application/json"
        ? items.map((item) => JSON.parse(item) as T)
        : (items as unknown as T[])

    // Create a simple response object
    const response: StreamResponse<T> = {
      offset: String(this.data.length),
      cursor: undefined,
      upToDate: true,
      streamClosed: this.closed,

      async json(): Promise<T[]> {
        return parsedItems
      },

      async body(): Promise<Uint8Array> {
        return new TextEncoder().encode(items.join(""))
      },

      async text(): Promise<string> {
        return items.join("")
      },

      jsonStream(): ReadableStream<T> {
        return new ReadableStream({
          start(controller) {
            for (const item of parsedItems) {
              controller.enqueue(item)
            }
            controller.close()
          },
        })
      },

      bodyStream(): ReadableStream<Uint8Array> {
        const encoder = new TextEncoder()
        return new ReadableStream({
          start(controller) {
            for (const item of items) {
              controller.enqueue(encoder.encode(item))
            }
            controller.close()
          },
        })
      },

      textStream(): ReadableStream<string> {
        return new ReadableStream({
          start(controller) {
            for (const item of items) {
              controller.enqueue(item)
            }
            controller.close()
          },
        })
      },

      subscribeJson(callback) {
        callback({
          items: parsedItems,
          offset: String(items.length),
          upToDate: true,
          streamClosed: this.streamClosed,
        })
        return Promise.resolve()
      },

      subscribeBytes(callback) {
        const encoder = new TextEncoder()
        callback({
          data: encoder.encode(items.join("")),
          offset: String(items.length),
          upToDate: true,
          streamClosed: this.streamClosed,
        })
        return Promise.resolve()
      },

      subscribeText(callback) {
        callback({
          data: items.join(""),
          offset: String(items.length),
          upToDate: true,
          streamClosed: this.streamClosed,
        })
        return Promise.resolve()
      },

      cancel() {
        // No-op for in-memory
      },
    }

    return response
  }

  // These methods are not fully implemented for in-memory
  async appendStream(
    source: ReadableStream<Uint8Array>
  ): Promise<{ offset: string }> {
    const reader = source.getReader()
    const chunks: Uint8Array[] = []

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) chunks.push(value)
    }

    const combined = new Uint8Array(
      chunks.reduce((acc, chunk) => acc + chunk.length, 0)
    )
    let offset = 0
    for (const chunk of chunks) {
      combined.set(chunk, offset)
      offset += chunk.length
    }

    return this.append(combined)
  }

  writable(options?: { close?: boolean }): WritableStream<Uint8Array> {
    const stream = this
    return new WritableStream({
      async write(chunk) {
        await stream.append(chunk)
      },
      async close() {
        if (options?.close) {
          await stream.close()
        }
      },
    })
  }
}

// =============================================================================
// In-Memory Stream Factory
// =============================================================================

/**
 * In-memory implementation of StreamFactory for testing
 */
export class InMemoryStreamFactory implements StreamFactory {
  private streams = new Map<string, InMemoryStream>()

  /**
   * Get an existing stream by ID
   */
  getStream(id: string): DurableStream {
    let stream = this.streams.get(id)
    if (!stream) {
      // Create on-demand for getStream (lazy creation)
      stream = new InMemoryStream(`memory://${id}`, {
        contentType: "application/json",
      })
      this.streams.set(id, stream)
    }
    return stream
  }

  /**
   * Create a new stream
   */
  async createStream(
    id: string,
    options?: CreateStreamOptions
  ): Promise<DurableStream> {
    const stream = new InMemoryStream(`memory://${id}`, {
      contentType: options?.contentType ?? "application/json",
    })
    this.streams.set(id, stream)
    return stream
  }

  /**
   * Delete a stream
   */
  async deleteStream(id: string): Promise<void> {
    this.streams.delete(id)
  }

  /**
   * Get all stream IDs (for testing/debugging)
   */
  getStreamIds(): string[] {
    return Array.from(this.streams.keys())
  }

  /**
   * Clear all streams (for testing)
   */
  clear(): void {
    this.streams.clear()
  }
}
