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
import { parseSSEStream } from "./sse"
import type { SSEEvent } from "./sse"
import type {
  ByteChunk,
  StreamResponse as IStreamResponse,
  JsonBatch,
  LiveMode,
  Offset,
  TextChunk,
} from "./types"

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
  /** Function to start SSE connection and return a Response with SSE body */
  startSSE?: (
    offset: Offset,
    cursor: string | undefined,
    signal: AbortSignal
  ) => Promise<Response>
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

  // --- Response metadata (updated on each response) ---
  #headers: Headers
  #status: number
  #statusText: string
  #ok: boolean
  #isLoading: boolean

  // --- Evolving state ---
  offset: Offset
  cursor?: string
  upToDate: boolean

  // --- Internal state ---
  #isJsonMode: boolean
  #abortController: AbortController
  #fetchNext: StreamResponseConfig[`fetchNext`]
  #startSSE?: StreamResponseConfig[`startSSE`]
  #closedResolve!: () => void
  #closedReject!: (err: Error) => void
  #closed: Promise<void>
  #stopAfterUpToDate = false

  // Core primitive: a ReadableStream of Response objects
  #responseStream: ReadableStream<Response>

  constructor(config: StreamResponseConfig) {
    this.url = config.url
    this.contentType = config.contentType
    this.live = config.live
    this.startOffset = config.startOffset
    this.offset = config.initialOffset
    this.cursor = config.initialCursor
    this.upToDate = config.initialUpToDate

    // Initialize response metadata from first response
    this.#headers = config.firstResponse.headers
    this.#status = config.firstResponse.status
    this.#statusText = config.firstResponse.statusText
    this.#ok = config.firstResponse.ok
    // isLoading is false because stream() already awaited the first response
    // before creating this StreamResponse. By the time user has this object,
    // the initial request has completed.
    this.#isLoading = false

    this.#isJsonMode = config.isJsonMode
    this.#abortController = config.abortController
    this.#fetchNext = config.fetchNext
    this.#startSSE = config.startSSE

    this.#closed = new Promise((resolve, reject) => {
      this.#closedResolve = resolve
      this.#closedReject = reject
    })

    // Create the core response stream
    this.#responseStream = this.#createResponseStream(config.firstResponse)
  }

  // --- Response metadata getters ---

  get headers(): Headers {
    return this.#headers
  }

  get status(): number {
    return this.#status
  }

  get statusText(): string {
    return this.#statusText
  }

  get ok(): boolean {
    return this.#ok
  }

  get isLoading(): boolean {
    return this.#isLoading
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

  #markClosed(): void {
    this.#closedResolve()
  }

  #markError(err: Error): void {
    this.#closedReject(err)
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
    // Update stream-specific state
    const offset = response.headers.get(STREAM_OFFSET_HEADER)
    if (offset) this.offset = offset
    const cursor = response.headers.get(STREAM_CURSOR_HEADER)
    if (cursor) this.cursor = cursor
    this.upToDate = response.headers.has(STREAM_UP_TO_DATE_HEADER)

    // Update response metadata to reflect latest server response
    this.#headers = response.headers
    this.#status = response.status
    this.#statusText = response.statusText
    this.#ok = response.ok
  }

  /**
   * Create the core ReadableStream<Response> that yields responses.
   * This is consumed once - all consumption methods use this same stream.
   *
   * For long-poll mode: yields actual Response objects.
   * For SSE mode: yields synthetic Response objects created from SSE data events.
   */
  #createResponseStream(firstResponse: Response): ReadableStream<Response> {
    let firstResponseYielded = false
    let sseEventIterator: AsyncGenerator<SSEEvent, void, undefined> | null =
      null

    return new ReadableStream<Response>({
      pull: async (controller) => {
        try {
          // First, yield the held first response (for non-SSE modes)
          // For SSE mode, the first response IS the SSE stream, so we start parsing it
          if (!firstResponseYielded) {
            firstResponseYielded = true

            // Check if this is an SSE response
            const isSSE =
              firstResponse.headers
                .get(`content-type`)
                ?.includes(`text/event-stream`) ?? false

            if (isSSE && firstResponse.body) {
              // Start parsing SSE events
              sseEventIterator = parseSSEStream(
                firstResponse.body,
                this.#abortController.signal
              )
              // Fall through to SSE processing below
            } else {
              // Regular response - enqueue it
              controller.enqueue(firstResponse)

              // If upToDate and not continuing live, we're done
              if (this.upToDate && !this.#shouldContinueLive()) {
                this.#markClosed()
                controller.close()
                return
              }
              return
            }
          }

          // SSE mode: process events from the SSE stream
          if (sseEventIterator) {
            // Keep reading events until we get data or stream ends
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
            while (true) {
              // Read next SSE event
              const { done, value: event } = await sseEventIterator.next()

              if (done) {
                // SSE stream ended - server may have closed after ~60s
                // Try to reconnect if we should continue live
                if (this.#shouldContinueLive() && this.#startSSE) {
                  try {
                    const newSSEResponse = await this.#startSSE(
                      this.offset,
                      this.cursor,
                      this.#abortController.signal
                    )
                    if (newSSEResponse.body) {
                      sseEventIterator = parseSSEStream(
                        newSSEResponse.body,
                        this.#abortController.signal
                      )
                      // Continue reading from new stream
                      continue
                    }
                  } catch {
                    // If reconnect fails, close the stream
                  }
                }
                this.#markClosed()
                controller.close()
                return
              }

              if (event.type === `control`) {
                // Update offset and cursor from control event
                this.offset = event.streamNextOffset
                if (event.streamCursor) {
                  this.cursor = event.streamCursor
                }
                // Continue to get next event (control events don't produce data)
                continue
              }

              // event.type === `data` - create a synthetic Response from SSE data
              const syntheticResponse = new Response(event.data, {
                status: 200,
                headers: {
                  "content-type": this.contentType ?? `application/json`,
                },
              })
              controller.enqueue(syntheticResponse)
              return
            }
          }

          // Long-poll mode: continue with live updates if needed
          if (this.#shouldContinueLive()) {
            if (this.#abortController.signal.aborted) {
              this.#markClosed()
              controller.close()
              return
            }

            const response = await this.#fetchNext(
              this.offset,
              this.cursor,
              this.#abortController.signal
            )

            this.#updateStateFromResponse(response)
            controller.enqueue(response)

            if (this.upToDate && !this.#shouldContinueLive()) {
              this.#markClosed()
              controller.close()
            }
            return
          }

          // No more data
          this.#markClosed()
          controller.close()
        } catch (err) {
          if (this.#abortController.signal.aborted) {
            this.#markClosed()
            controller.close()
          } else {
            this.#markError(err instanceof Error ? err : new Error(String(err)))
            controller.error(err)
          }
        }
      },

      cancel: () => {
        this.#abortController.abort()
        this.#markClosed()
      },
    })
  }

  /**
   * Get the response stream reader. Can only be called once.
   */
  #getResponseReader(): ReadableStreamDefaultReader<Response> {
    return this.#responseStream.getReader()
  }

  // =================================
  // 1) Accumulating helpers (Promise)
  // =================================

  async body(): Promise<Uint8Array> {
    this.#stopAfterUpToDate = true
    const reader = this.#getResponseReader()
    const blobs: Array<Blob> = []

    try {
      let result = await reader.read()
      while (!result.done) {
        const blob = await result.value.blob()
        if (blob.size > 0) {
          blobs.push(blob)
        }
        if (this.upToDate) break
        result = await reader.read()
      }
    } finally {
      reader.releaseLock()
    }

    this.#markClosed()

    if (blobs.length === 0) {
      return new Uint8Array(0)
    }
    if (blobs.length === 1) {
      return new Uint8Array(await blobs[0]!.arrayBuffer())
    }

    const combined = new Blob(blobs)
    return new Uint8Array(await combined.arrayBuffer())
  }

  async json(): Promise<Array<TJson>> {
    this.#ensureJsonMode()
    this.#stopAfterUpToDate = true
    const reader = this.#getResponseReader()
    const items: Array<TJson> = []

    try {
      let result = await reader.read()
      while (!result.done) {
        const parsed = (await result.value.json()) as TJson | Array<TJson>
        if (Array.isArray(parsed)) {
          items.push(...parsed)
        } else {
          items.push(parsed)
        }
        if (this.upToDate) break
        result = await reader.read()
      }
    } finally {
      reader.releaseLock()
    }

    this.#markClosed()
    return items
  }

  async text(): Promise<string> {
    this.#stopAfterUpToDate = true
    const reader = this.#getResponseReader()
    const parts: Array<string> = []

    try {
      let result = await reader.read()
      while (!result.done) {
        const text = await result.value.text()
        if (text) {
          parts.push(text)
        }
        if (this.upToDate) break
        result = await reader.read()
      }
    } finally {
      reader.releaseLock()
    }

    this.#markClosed()
    return parts.join(``)
  }

  // =====================
  // 2) ReadableStreams
  // =====================

  bodyStream(): ReadableStream<Uint8Array> {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
    const reader = this.#getResponseReader()

    const pipeBodyStream = async (): Promise<void> => {
      try {
        let result = await reader.read()
        while (!result.done) {
          const body = result.value.body
          if (body) {
            await body.pipeTo(writable, {
              preventClose: true,
              preventAbort: true,
              preventCancel: true,
            })
          }

          if (this.upToDate && !this.#shouldContinueLive()) {
            break
          }
          result = await reader.read()
        }
        await writable.close()
        this.#markClosed()
      } catch (err) {
        if (this.#abortController.signal.aborted) {
          try {
            await writable.close()
          } catch {
            // Ignore close errors on abort
          }
          this.#markClosed()
        } else {
          try {
            await writable.abort(err)
          } catch {
            // Ignore abort errors
          }
          this.#markError(err instanceof Error ? err : new Error(String(err)))
        }
      } finally {
        reader.releaseLock()
      }
    }

    pipeBodyStream()

    return readable
  }

  jsonStream(): ReadableStream<TJson> {
    this.#ensureJsonMode()
    const reader = this.#getResponseReader()
    let pendingItems: Array<TJson> = []

    return new ReadableStream<TJson>({
      pull: async (controller) => {
        // Drain pending items first
        if (pendingItems.length > 0) {
          controller.enqueue(pendingItems.shift())
          return
        }

        // Get next response
        const { done, value: response } = await reader.read()
        if (done) {
          this.#markClosed()
          controller.close()
          return
        }

        // Parse JSON and flatten arrays
        const parsed = (await response.json()) as TJson | Array<TJson>
        pendingItems = Array.isArray(parsed) ? parsed : [parsed]

        // Enqueue first item
        if (pendingItems.length > 0) {
          controller.enqueue(pendingItems.shift())
        }
      },

      cancel: () => {
        reader.releaseLock()
        this.cancel()
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
    const reader = this.#getResponseReader()

    const consumeJsonSubscription = async (): Promise<void> => {
      try {
        let result = await reader.read()
        while (!result.done) {
          if (abortController.signal.aborted) break

          const parsed = (await result.value.json()) as TJson | Array<TJson>
          const items = Array.isArray(parsed) ? parsed : [parsed]

          await subscriber({
            items,
            offset: this.offset,
            cursor: this.cursor,
            upToDate: this.upToDate,
          })

          result = await reader.read()
        }
      } catch (e) {
        if (!abortController.signal.aborted) throw e
      } finally {
        reader.releaseLock()
      }
    }

    consumeJsonSubscription()

    return () => {
      abortController.abort()
      this.cancel()
    }
  }

  subscribeBytes(subscriber: (chunk: ByteChunk) => Promise<void>): () => void {
    const abortController = new AbortController()
    const reader = this.#getResponseReader()

    const consumeBytesSubscription = async (): Promise<void> => {
      try {
        let result = await reader.read()
        while (!result.done) {
          if (abortController.signal.aborted) break

          const buffer = await result.value.arrayBuffer()

          await subscriber({
            data: new Uint8Array(buffer),
            offset: this.offset,
            cursor: this.cursor,
            upToDate: this.upToDate,
          })

          result = await reader.read()
        }
      } catch (e) {
        if (!abortController.signal.aborted) throw e
      } finally {
        reader.releaseLock()
      }
    }

    consumeBytesSubscription()

    return () => {
      abortController.abort()
      this.cancel()
    }
  }

  subscribeText(subscriber: (chunk: TextChunk) => Promise<void>): () => void {
    const abortController = new AbortController()
    const reader = this.#getResponseReader()

    const consumeTextSubscription = async (): Promise<void> => {
      try {
        let result = await reader.read()
        while (!result.done) {
          if (abortController.signal.aborted) break

          const text = await result.value.text()

          await subscriber({
            text,
            offset: this.offset,
            cursor: this.cursor,
            upToDate: this.upToDate,
          })

          result = await reader.read()
        }
      } catch (e) {
        if (!abortController.signal.aborted) throw e
      } finally {
        reader.releaseLock()
      }
    }

    consumeTextSubscription()

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
    this.#markClosed()
  }

  get closed(): Promise<void> {
    return this.#closed
  }
}
