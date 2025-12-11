/**
 * StreamResponse - A streaming session for reading from a durable stream.
 *
 * Represents a live session with fixed `url`, `offset`, and `live` parameters.
 * Supports multiple consumption styles: Promise helpers, ReadableStreams,
 * AsyncIterators, and Subscribers.
 */

import { DurableStreamError } from "./error"
import type {
  ByteChunk,
  StreamResponse as IStreamResponse,
  JsonBatch,
  LiveMode,
  Offset,
  TextChunk,
} from "./types"

/**
 * Session state machine.
 */
enum SessionState {
  /** Inside stream() before first response resolves/rejects */
  Connecting = `connecting`,
  /** First response received, Response object held (body not read) */
  Ready = `ready`,
  /** At least one consumer (iterator/stream/subscriber) is active */
  Consuming = `consuming`,
  /** Completed, cancelled, or errored */
  Closed = `closed`,
}

/**
 * Internal configuration for creating a StreamResponse.
 */
export interface StreamResponseConfig {
  /** The stream URL */
  url: string
  /** Content type from the first response */
  contentType?: string
  /** Live mode for this session */
  live: LiveMode
  /** Starting offset */
  startOffset: Offset
  /** Whether to treat as JSON (hint or content-type) */
  isJsonMode: boolean
  /** Initial offset from first response headers */
  initialOffset: Offset
  /** Initial cursor from first response headers */
  initialCursor?: string
  /** Initial upToDate from first response headers */
  initialUpToDate: boolean
  /** The held first Response object */
  firstResponse: Response
  /** Abort controller for the session */
  abortController: AbortController
  /** Function to fetch the next chunk (for long-poll) */
  fetchNext: (
    offset: Offset,
    cursor: string | undefined,
    signal: AbortSignal
  ) => Promise<Response>
  /** Function to start SSE and return an async iterator */
  startSSE?: (
    offset: Offset,
    cursor: string | undefined,
    signal: AbortSignal
  ) => AsyncIterator<ByteChunk>
}

/**
 * Implementation of the StreamResponse interface.
 */
export class StreamResponseImpl<
  TJson = unknown,
> implements IStreamResponse<TJson> {
  // --- Static session info ---
  readonly url: string
  readonly contentType?: string
  readonly live: LiveMode
  readonly startOffset: Offset

  // --- Evolving state ---
  offset: Offset
  cursor?: string
  upToDate: boolean

  // --- Internal state ---
  #state: SessionState = SessionState.Ready
  #isJsonMode: boolean
  #firstResponse: Response | null
  #abortController: AbortController
  #fetchNext: StreamResponseConfig[`fetchNext`]
  #startSSE?: StreamResponseConfig[`startSSE`]
  #closedResolve!: () => void
  #closedReject!: (err: Error) => void
  #closed: Promise<void>
  #stopAfterUpToDate = false
  #sseIterator: AsyncIterator<ByteChunk> | null = null

  constructor(config: StreamResponseConfig) {
    this.url = config.url
    this.contentType = config.contentType
    this.live = config.live
    this.startOffset = config.startOffset
    this.offset = config.initialOffset
    this.cursor = config.initialCursor
    this.upToDate = config.initialUpToDate

    this.#isJsonMode = config.isJsonMode
    this.#firstResponse = config.firstResponse
    this.#abortController = config.abortController
    this.#fetchNext = config.fetchNext
    this.#startSSE = config.startSSE

    this.#closed = new Promise((resolve, reject) => {
      this.#closedResolve = resolve
      this.#closedReject = reject
    })
  }

  // =================================
  // Internal helpers
  // =================================

  #ensureJsonMode(): void {
    if (!this.#isJsonMode) {
      throw new DurableStreamError(
        `JSON methods are only valid for JSON-mode streams. ` +
          `Content-Type is "${this.contentType}" and json hint was not set.`,
        `BAD_REQUEST`
      )
    }
  }

  #markConsuming(): void {
    if (this.#state === SessionState.Ready) {
      this.#state = SessionState.Consuming
    }
  }

  #markClosed(): void {
    if (this.#state !== SessionState.Closed) {
      this.#state = SessionState.Closed
      this.#closedResolve()
    }
  }

  #markError(err: Error): void {
    if (this.#state !== SessionState.Closed) {
      this.#state = SessionState.Closed
      this.#closedReject(err)
    }
  }

  /**
   * Determine if we should continue with live updates based on live mode
   * and whether a promise helper signaled to stop.
   */
  #shouldContinueLive(): boolean {
    if (this.#stopAfterUpToDate) return false
    if (this.live === false) return false
    return true
  }

  /**
   * Core byte chunks async generator.
   * This is the foundation for all consumption methods.
   */
  async *#generateByteChunks(): AsyncGenerator<ByteChunk, void, undefined> {
    this.#markConsuming()

    try {
      // First, consume the held first response
      if (this.#firstResponse) {
        const response = this.#firstResponse
        this.#firstResponse = null

        const data = new Uint8Array(await response.arrayBuffer())
        const chunk: ByteChunk = {
          data,
          offset: this.offset,
          cursor: this.cursor,
          upToDate: this.upToDate,
        }

        yield chunk

        // If upToDate and not continuing live, we're done
        if (this.upToDate && !this.#shouldContinueLive()) {
          this.#markClosed()
          return
        }
      }

      // Now continue with live updates if needed
      if (this.#shouldContinueLive()) {
        // Check if we should use SSE
        if (this.live === `sse` && this.#startSSE) {
          this.#sseIterator = this.#startSSE(
            this.offset,
            this.cursor,
            this.#abortController.signal
          )

          let done = false
          while (!done) {
            const result = await this.#sseIterator.next()
            if (result.done) {
              done = true
              continue
            }

            const chunk = result.value
            this.offset = chunk.offset
            this.cursor = chunk.cursor
            this.upToDate = chunk.upToDate

            yield chunk

            if (this.upToDate && !this.#shouldContinueLive()) {
              done = true
            }
          }
        } else {
          // Use long-poll
          while (!this.#abortController.signal.aborted) {
            const response = await this.#fetchNext(
              this.offset,
              this.cursor,
              this.#abortController.signal
            )

            const chunk = await this.#parseResponse(response)
            this.offset = chunk.offset
            this.cursor = chunk.cursor
            this.upToDate = chunk.upToDate

            yield chunk

            if (this.upToDate && !this.#shouldContinueLive()) {
              break
            }
          }
        }
      }

      this.#markClosed()
    } catch (err) {
      if (this.#abortController.signal.aborted) {
        this.#markClosed()
      } else {
        this.#markError(err instanceof Error ? err : new Error(String(err)))
        throw err
      }
    }
  }

  async #parseResponse(response: Response): Promise<ByteChunk> {
    const data = new Uint8Array(await response.arrayBuffer())
    const offset = response.headers.get(`Stream-Next-Offset`) ?? this.offset
    const cursor = response.headers.get(`Stream-Cursor`) ?? undefined
    const upToDate = response.headers.has(`Stream-Up-To-Date`)

    return {
      data,
      offset,
      cursor,
      upToDate,
    }
  }

  // =================================
  // 1) Accumulating helpers (Promise)
  // =================================

  async body(): Promise<Uint8Array> {
    this.#stopAfterUpToDate = true
    const chunks: Array<Uint8Array> = []

    for await (const chunk of this.#generateByteChunks()) {
      if (chunk.data.length > 0) {
        chunks.push(chunk.data)
      }
      if (chunk.upToDate) break
    }

    // Concatenate all chunks
    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0)
    const result = new Uint8Array(totalLength)
    let offset = 0
    for (const chunk of chunks) {
      result.set(chunk, offset)
      offset += chunk.length
    }

    return result
  }

  async json(): Promise<Array<TJson>> {
    this.#ensureJsonMode()
    this.#stopAfterUpToDate = true
    const items: Array<TJson> = []

    for await (const batch of this.jsonBatches()) {
      items.push(...batch.items)
      if (batch.upToDate) break
    }

    return items
  }

  async text(): Promise<string> {
    this.#stopAfterUpToDate = true
    const decoder = new TextDecoder()
    const parts: Array<string> = []

    for await (const chunk of this.#generateByteChunks()) {
      if (chunk.data.length > 0) {
        parts.push(decoder.decode(chunk.data, { stream: true }))
      }
      if (chunk.upToDate) break
    }

    // Flush any remaining data
    parts.push(decoder.decode())
    return parts.join(``)
  }

  // =====================
  // 2) ReadableStreams
  // =====================

  bodyStream(): ReadableStream<Uint8Array> {
    const iterator = this.#generateByteChunks()

    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await iterator.next()
          if (done) {
            controller.close()
          } else {
            controller.enqueue(value.data)
          }
        } catch (e) {
          controller.error(e)
        }
      },

      cancel() {
        void iterator.return()
      },
    })
  }

  jsonStream(): ReadableStream<TJson> {
    this.#ensureJsonMode()
    const iterator = this.jsonItems()[Symbol.asyncIterator]()

    return new ReadableStream<TJson>({
      async pull(controller) {
        try {
          const { done, value } = await iterator.next()
          if (done) {
            controller.close()
          } else {
            controller.enqueue(value)
          }
        } catch (e) {
          controller.error(e)
        }
      },

      cancel() {
        void iterator.return()
      },
    })
  }

  textStream(): ReadableStream<string> {
    const decoder = new TextDecoder()
    const iterator = this.#generateByteChunks()

    return new ReadableStream<string>({
      async pull(controller) {
        try {
          const { done, value } = await iterator.next()
          if (done) {
            controller.close()
          } else {
            controller.enqueue(decoder.decode(value.data, { stream: true }))
          }
        } catch (e) {
          controller.error(e)
        }
      },

      cancel() {
        void iterator.return()
      },
    })
  }

  // =====================
  // 3) Async iterators
  // =====================

  [Symbol.asyncIterator](): AsyncIterator<ByteChunk> {
    return this.#generateByteChunks()
  }

  byteChunks(): AsyncIterable<ByteChunk> {
    const self = this
    return {
      [Symbol.asyncIterator]() {
        return self.#generateByteChunks()
      },
    }
  }

  jsonBatches(): AsyncIterable<JsonBatch<TJson>> {
    this.#ensureJsonMode()
    const self = this

    return {
      async *[Symbol.asyncIterator]() {
        const decoder = new TextDecoder()

        for await (const chunk of self.#generateByteChunks()) {
          if (chunk.data.length === 0) {
            // Empty chunk, yield empty batch with metadata
            yield {
              items: [] as Array<TJson>,
              offset: chunk.offset,
              cursor: chunk.cursor,
              upToDate: chunk.upToDate,
            }
            continue
          }

          const text = decoder.decode(chunk.data)
          // Parse JSON - handle both array and newline-delimited JSON
          let items: Array<TJson>
          try {
            const parsed = JSON.parse(text) as unknown
            if (Array.isArray(parsed)) {
              items = parsed as Array<TJson>
            } else {
              items = [parsed as TJson]
            }
          } catch {
            // Try newline-delimited JSON
            const lines = text.split(`\n`).filter((l) => l.trim())
            items = lines.map((line) => JSON.parse(line) as TJson)
          }

          yield {
            items,
            offset: chunk.offset,
            cursor: chunk.cursor,
            upToDate: chunk.upToDate,
          }
        }
      },
    }
  }

  jsonItems(): AsyncIterable<TJson> {
    this.#ensureJsonMode()
    const self = this

    return {
      async *[Symbol.asyncIterator]() {
        for await (const batch of self.jsonBatches()) {
          for (const item of batch.items) {
            yield item
          }
        }
      },
    }
  }

  textChunks(): AsyncIterable<TextChunk> {
    const self = this

    return {
      async *[Symbol.asyncIterator]() {
        const decoder = new TextDecoder()

        for await (const chunk of self.#generateByteChunks()) {
          yield {
            text: decoder.decode(chunk.data, { stream: true }),
            offset: chunk.offset,
            cursor: chunk.cursor,
            upToDate: chunk.upToDate,
          }
        }
      },
    }
  }

  // =====================
  // 4) Subscriber APIs
  // =====================

  subscribeJson(
    subscriber: (batch: JsonBatch<TJson>) => Promise<void>
  ): () => void {
    this.#ensureJsonMode()
    const abortController = new AbortController()

    // Start consuming in the background
    ;(async () => {
      try {
        for await (const batch of this.jsonBatches()) {
          if (abortController.signal.aborted) break
          await subscriber(batch)
        }
      } catch (e) {
        // Ignore errors after unsubscribe
        if (!abortController.signal.aborted) throw e
      }
    })()

    return () => {
      abortController.abort()
    }
  }

  subscribeBytes(subscriber: (chunk: ByteChunk) => Promise<void>): () => void {
    const abortController = new AbortController()

    ;(async () => {
      try {
        for await (const chunk of this.#generateByteChunks()) {
          if (abortController.signal.aborted) break
          await subscriber(chunk)
        }
      } catch (e) {
        if (!abortController.signal.aborted) throw e
      }
    })()

    return () => {
      abortController.abort()
    }
  }

  subscribeText(subscriber: (chunk: TextChunk) => Promise<void>): () => void {
    const abortController = new AbortController()

    ;(async () => {
      try {
        for await (const chunk of this.textChunks()) {
          if (abortController.signal.aborted) break
          await subscriber(chunk)
        }
      } catch (e) {
        if (!abortController.signal.aborted) throw e
      }
    })()

    return () => {
      abortController.abort()
    }
  }

  // =====================
  // 5) Lifecycle
  // =====================

  cancel(reason?: unknown): void {
    this.#abortController.abort(reason)
    if (this.#sseIterator?.return) {
      this.#sseIterator.return()
    }
    this.#markClosed()
  }

  get closed(): Promise<void> {
    return this.#closed
  }
}
