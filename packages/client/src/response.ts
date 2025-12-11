/**
 * StreamResponse - A streaming session for reading from a durable stream.
 *
 * Represents a live session with fixed `url`, `offset`, and `live` parameters.
 * Supports multiple consumption styles: Promise helpers, ReadableStreams, and Subscribers.
 */

import { DurableStreamError } from "./error"
import {
  STREAM_CURSOR_HEADER,
  STREAM_OFFSET_HEADER,
  STREAM_UP_TO_DATE_HEADER,
} from "./constants"
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
  /** First response received, Response object held (body not read) */
  Ready = `ready`,
  /** At least one consumer (stream/subscriber) is active */
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
   * Update state from response headers.
   */
  #updateStateFromResponse(response: Response): void {
    const offset = response.headers.get(STREAM_OFFSET_HEADER)
    if (offset) this.offset = offset
    const cursor = response.headers.get(STREAM_CURSOR_HEADER)
    if (cursor) this.cursor = cursor
    this.upToDate = response.headers.has(STREAM_UP_TO_DATE_HEADER)
  }

  /**
   * Consume the first response if available, returning null if already consumed.
   */
  #takeFirstResponse(): Response | null {
    const response = this.#firstResponse
    this.#firstResponse = null
    return response
  }

  /**
   * Async generator that yields Response objects (first response + live updates).
   * This is the core primitive for all consumption methods.
   */
  async *#generateResponses(): AsyncGenerator<Response, void, undefined> {
    this.#markConsuming()

    try {
      // First, yield the held first response
      const firstResponse = this.#takeFirstResponse()
      if (firstResponse) {
        yield firstResponse

        // If upToDate and not continuing live, we're done
        if (this.upToDate && !this.#shouldContinueLive()) {
          this.#markClosed()
          return
        }
      }

      // Continue with live updates if needed
      while (this.#shouldContinueLive()) {
        // Check if we should use SSE
        if (this.live === `sse` && this.#startSSE) {
          if (!this.#sseIterator) {
            this.#sseIterator = this.#startSSE(
              this.offset,
              this.cursor,
              this.#abortController.signal
            )
          }

          // SSE mode yields ByteChunks directly, not Response objects
          // So we need to handle this differently - for now, throw
          throw new DurableStreamError(
            `SSE mode is not yet implemented`,
            `SSE_NOT_SUPPORTED`
          )
        }

        // Use long-poll
        if (this.#abortController.signal.aborted) {
          break
        }

        const response = await this.#fetchNext(
          this.offset,
          this.cursor,
          this.#abortController.signal
        )

        this.#updateStateFromResponse(response)
        yield response

        if (this.upToDate && !this.#shouldContinueLive()) {
          break
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

  // =================================
  // 1) Accumulating helpers (Promise)
  // =================================

  async body(): Promise<Uint8Array> {
    this.#markConsuming()
    this.#stopAfterUpToDate = true

    const blobs: Array<Blob> = []

    for await (const response of this.#generateResponses()) {
      // Get blob directly - no copy needed
      const blob = await response.blob()
      if (blob.size > 0) {
        blobs.push(blob)
      }
      if (this.upToDate) break
    }

    this.#markClosed()

    // No data
    if (blobs.length === 0) {
      return new Uint8Array(0)
    }

    // Single blob - get arrayBuffer directly (no concatenation needed)
    if (blobs.length === 1) {
      return new Uint8Array(await blobs[0]!.arrayBuffer())
    }

    // Multiple blobs - use Blob constructor to concatenate (no manual copying)
    const combined = new Blob(blobs)
    return new Uint8Array(await combined.arrayBuffer())
  }

  async json(): Promise<Array<TJson>> {
    this.#ensureJsonMode()
    this.#markConsuming()
    this.#stopAfterUpToDate = true

    const items: Array<TJson> = []

    for await (const response of this.#generateResponses()) {
      // Use the efficient json() method on Response
      const parsed = (await response.json()) as TJson | Array<TJson>
      if (Array.isArray(parsed)) {
        items.push(...parsed)
      } else {
        items.push(parsed)
      }
      if (this.upToDate) break
    }

    this.#markClosed()
    return items
  }

  async text(): Promise<string> {
    this.#markConsuming()
    this.#stopAfterUpToDate = true

    const parts: Array<string> = []

    for await (const response of this.#generateResponses()) {
      // Use the efficient text() method on Response
      const text = await response.text()
      if (text) {
        parts.push(text)
      }
      if (this.upToDate) break
    }

    this.#markClosed()
    return parts.join(``)
  }

  // =====================
  // 2) ReadableStreams
  // =====================

  bodyStream(): ReadableStream<Uint8Array> {
    this.#markConsuming()

    // Optimization: If we have the first response and won't need more,
    // just return the response body directly - zero copy!
    if (this.upToDate && !this.#shouldContinueLive() && this.#firstResponse) {
      const response = this.#takeFirstResponse()!
      const body = response.body
      if (body) {
        // Wrap to handle cleanup on completion
        const self = this
        return body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            flush() {
              self.#markClosed()
            },
          })
        )
      }
      this.#markClosed()
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close()
        },
      })
    }

    // Multiple responses case: need to concatenate streams
    const self = this
    const responseGenerator = this.#generateResponses()
    let currentReader: ReadableStreamDefaultReader<Uint8Array> | null = null

    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          // If we have a current reader, try to read from it
          if (currentReader) {
            const { done, value } = await currentReader.read()
            if (!done) {
              controller.enqueue(value)
              return
            }
            // Current response body exhausted, get next response
            currentReader = null
          }

          // Get next response
          const { done, value: response } = await responseGenerator.next()
          if (done) {
            self.#markClosed()
            controller.close()
            return
          }

          // Get the body reader from the response
          const body = response.body
          if (body) {
            currentReader = body.getReader()
            // Read first chunk
            const { done: chunkDone, value } = await currentReader.read()
            if (!chunkDone) {
              controller.enqueue(value)
            } else {
              currentReader = null
            }
          }

          // Check if we should stop
          if (self.upToDate && !self.#shouldContinueLive()) {
            self.#markClosed()
            controller.close()
          }
        } catch (err) {
          if (self.#abortController.signal.aborted) {
            self.#markClosed()
            controller.close()
          } else {
            self.#markError(err instanceof Error ? err : new Error(String(err)))
            controller.error(err)
          }
        }
      },

      cancel() {
        currentReader?.cancel()
        responseGenerator.return()
        self.#abortController.abort()
        self.#markClosed()
      },
    })
  }

  jsonStream(): ReadableStream<TJson> {
    this.#ensureJsonMode()
    this.#markConsuming()
    const self = this
    const responseGenerator = this.#generateResponses()
    let pendingItems: Array<TJson> = []

    return new ReadableStream<TJson>({
      async pull(controller) {
        try {
          // If we have pending items, yield the next one
          const nextItem = pendingItems.shift()
          if (nextItem !== undefined) {
            controller.enqueue(nextItem)
            return
          }

          // Get next response and parse JSON
          const { done, value: response } = await responseGenerator.next()
          if (done) {
            self.#markClosed()
            controller.close()
            return
          }

          // Use the efficient json() method on Response
          const parsed = (await response.json()) as TJson | Array<TJson>
          if (Array.isArray(parsed)) {
            pendingItems = parsed
          } else {
            pendingItems = [parsed]
          }

          // Yield first item
          const firstItem = pendingItems.shift()
          if (firstItem !== undefined) {
            controller.enqueue(firstItem)
          }

          // Check if we should stop
          if (self.upToDate && !self.#shouldContinueLive()) {
            // Drain remaining items first
            if (pendingItems.length === 0) {
              self.#markClosed()
              controller.close()
            }
          }
        } catch (err) {
          if (self.#abortController.signal.aborted) {
            self.#markClosed()
            controller.close()
          } else {
            self.#markError(err instanceof Error ? err : new Error(String(err)))
            controller.error(err)
          }
        }
      },

      cancel() {
        responseGenerator.return()
        self.#abortController.abort()
        self.#markClosed()
      },
    })
  }

  textStream(): ReadableStream<string> {
    const decoder = new TextDecoder()

    return this.bodyStream().pipeThrough(
      new TransformStream<Uint8Array, string>({
        transform(chunk, controller) {
          controller.enqueue(decoder.decode(chunk, { stream: true }))
        },
        flush(controller) {
          const remaining = decoder.decode()
          if (remaining) {
            controller.enqueue(remaining)
          }
        },
      })
    )
  }

  // =====================
  // 3) Subscriber APIs
  // =====================

  subscribeJson(
    subscriber: (batch: JsonBatch<TJson>) => Promise<void>
  ): () => void {
    this.#ensureJsonMode()
    const abortController = new AbortController()
    const self = this

    // Start consuming in the background
    ;(async () => {
      try {
        for await (const response of self.#generateResponses()) {
          if (abortController.signal.aborted) break

          // Use the efficient json() method on Response
          const parsed = (await response.json()) as TJson | Array<TJson>
          const items = Array.isArray(parsed) ? parsed : [parsed]

          await subscriber({
            items,
            offset: self.offset,
            cursor: self.cursor,
            upToDate: self.upToDate,
          })
        }
      } catch (e) {
        // Ignore errors after unsubscribe
        if (!abortController.signal.aborted) throw e
      }
    })()

    return () => {
      abortController.abort()
      this.cancel()
    }
  }

  subscribeBytes(subscriber: (chunk: ByteChunk) => Promise<void>): () => void {
    const abortController = new AbortController()
    const self = this

    ;(async () => {
      try {
        for await (const response of self.#generateResponses()) {
          if (abortController.signal.aborted) break

          const buffer = await response.arrayBuffer()

          await subscriber({
            data: new Uint8Array(buffer),
            offset: self.offset,
            cursor: self.cursor,
            upToDate: self.upToDate,
          })
        }
      } catch (e) {
        if (!abortController.signal.aborted) throw e
      }
    })()

    return () => {
      abortController.abort()
      this.cancel()
    }
  }

  subscribeText(subscriber: (chunk: TextChunk) => Promise<void>): () => void {
    const abortController = new AbortController()
    const self = this

    ;(async () => {
      try {
        for await (const response of self.#generateResponses()) {
          if (abortController.signal.aborted) break

          const text = await response.text()

          await subscriber({
            text,
            offset: self.offset,
            cursor: self.cursor,
            upToDate: self.upToDate,
          })
        }
      } catch (e) {
        if (!abortController.signal.aborted) throw e
      }
    })()

    return () => {
      abortController.abort()
      this.cancel()
    }
  }

  // =====================
  // 4) Lifecycle
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
