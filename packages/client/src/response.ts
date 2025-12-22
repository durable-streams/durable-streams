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
import type { SSEControlEvent, SSEEvent } from "./sse"
import type {
  ByteChunk,
  StreamResponse as IStreamResponse,
  JsonBatch,
  LiveMode,
  Offset,
  SSEResilienceOptions,
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
  /** SSE resilience options */
  sseResilience?: SSEResilienceOptions
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
  #consumptionMethod: string | null = null

  // --- SSE Resilience State ---
  #sseResilience: Required<SSEResilienceOptions>
  #lastSSEConnectionStartTime?: number
  #consecutiveShortSSEConnections = 0
  #sseFallbackToLongPoll = false

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

    // Initialize SSE resilience options with defaults
    this.#sseResilience = {
      minConnectionDuration:
        config.sseResilience?.minConnectionDuration ?? 1000,
      maxShortConnections: config.sseResilience?.maxShortConnections ?? 3,
      backoffBaseDelay: config.sseResilience?.backoffBaseDelay ?? 100,
      backoffMaxDelay: config.sseResilience?.backoffMaxDelay ?? 5000,
      logWarnings: config.sseResilience?.logWarnings ?? true,
    }

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
   * Ensure only one consumption method is used per StreamResponse.
   * Throws if any consumption method was already called.
   */
  #ensureNoConsumption(method: string): void {
    if (this.#consumptionMethod !== null) {
      throw new DurableStreamError(
        `Cannot call ${method}() - this StreamResponse is already being consumed via ${this.#consumptionMethod}()`,
        `ALREADY_CONSUMED`
      )
    }
    this.#consumptionMethod = method
  }

  /**
   * Determine if we should continue with live updates based on live mode
   * and whether we've received upToDate.
   */
  #shouldContinueLive(): boolean {
    // Stop if we've received upToDate and a consumption method wants to stop after upToDate
    if (this.#stopAfterUpToDate && this.upToDate) return false
    // Stop if live mode is explicitly disabled
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
   * Extract stream metadata from Response headers.
   * Used by subscriber APIs to get the correct offset/cursor/upToDate for each
   * specific Response, rather than reading from `this` which may be stale due to
   * ReadableStream prefetching or timing issues.
   */
  #getMetadataFromResponse(response: Response): {
    offset: Offset
    cursor: string | undefined
    upToDate: boolean
  } {
    const offset = response.headers.get(STREAM_OFFSET_HEADER)
    const cursor = response.headers.get(STREAM_CURSOR_HEADER)
    const upToDate = response.headers.has(STREAM_UP_TO_DATE_HEADER)
    return {
      offset: offset ?? this.offset, // Fall back to instance state if no header
      cursor: cursor ?? this.cursor,
      upToDate,
    }
  }

  /**
   * Create a synthetic Response from SSE data with proper headers.
   * Includes offset/cursor/upToDate in headers so subscribers can read them.
   */
  #createSSESyntheticResponse(
    data: string,
    offset: Offset,
    cursor: string | undefined,
    upToDate: boolean
  ): Response {
    const headers: Record<string, string> = {
      "content-type": this.contentType ?? `application/json`,
      [STREAM_OFFSET_HEADER]: String(offset),
    }
    if (cursor) {
      headers[STREAM_CURSOR_HEADER] = cursor
    }
    if (upToDate) {
      headers[STREAM_UP_TO_DATE_HEADER] = `true`
    }
    return new Response(data, { status: 200, headers })
  }

  /**
   * Update instance state from an SSE control event.
   */
  #updateStateFromSSEControl(controlEvent: SSEControlEvent): void {
    this.offset = controlEvent.streamNextOffset
    if (controlEvent.streamCursor) {
      this.cursor = controlEvent.streamCursor
    }
    if (controlEvent.upToDate !== undefined) {
      this.upToDate = controlEvent.upToDate
    }
  }

  /**
   * Mark the start of an SSE connection for duration tracking.
   */
  #markSSEConnectionStart(): void {
    this.#lastSSEConnectionStartTime = Date.now()
  }

  /**
   * Handle SSE connection end - check duration and manage fallback state.
   * Returns a delay to wait before reconnecting, or null if should not reconnect.
   */
  async #handleSSEConnectionEnd(): Promise<number | null> {
    if (this.#lastSSEConnectionStartTime === undefined) {
      return 0 // No tracking, allow immediate reconnect
    }

    const connectionDuration = Date.now() - this.#lastSSEConnectionStartTime
    const wasAborted = this.#abortController.signal.aborted

    if (
      connectionDuration < this.#sseResilience.minConnectionDuration &&
      !wasAborted
    ) {
      // Connection was too short - likely proxy buffering or misconfiguration
      this.#consecutiveShortSSEConnections++

      if (
        this.#consecutiveShortSSEConnections >=
        this.#sseResilience.maxShortConnections
      ) {
        // Too many short connections - fall back to long polling
        this.#sseFallbackToLongPoll = true

        if (this.#sseResilience.logWarnings) {
          console.warn(
            `[Durable Streams] SSE connections are closing immediately (possibly due to proxy buffering or misconfiguration). ` +
              `Falling back to long polling. ` +
              `Your proxy must support streaming SSE responses (not buffer the complete response). ` +
              `Configuration: Nginx add 'X-Accel-Buffering: no', Caddy add 'flush_interval -1' to reverse_proxy.`
          )
        }
        return null // Signal to not reconnect SSE
      } else {
        // Add exponential backoff with full jitter to prevent tight infinite loop
        // Formula: random(0, min(cap, base * 2^attempt))
        const maxDelay = Math.min(
          this.#sseResilience.backoffMaxDelay,
          this.#sseResilience.backoffBaseDelay *
            Math.pow(2, this.#consecutiveShortSSEConnections)
        )
        const delayMs = Math.floor(Math.random() * maxDelay)
        await new Promise((resolve) => setTimeout(resolve, delayMs))
        return delayMs
      }
    } else if (
      connectionDuration >= this.#sseResilience.minConnectionDuration
    ) {
      // Connection was healthy - reset counter
      this.#consecutiveShortSSEConnections = 0
    }

    return 0 // Allow immediate reconnect
  }

  /**
   * Try to reconnect SSE and return the new iterator, or null if reconnection
   * is not possible or fails.
   */
  async #trySSEReconnect(): Promise<AsyncGenerator<
    SSEEvent,
    void,
    undefined
  > | null> {
    // Check if we should fall back to long-poll due to repeated short connections
    if (this.#sseFallbackToLongPoll) {
      return null // Will cause fallback to long-poll
    }

    if (!this.#shouldContinueLive() || !this.#startSSE) {
      return null
    }

    // Handle short connection detection and backoff
    const delayOrNull = await this.#handleSSEConnectionEnd()
    if (delayOrNull === null) {
      return null // Fallback to long-poll was triggered
    }

    // Track new connection start
    this.#markSSEConnectionStart()

    const newSSEResponse = await this.#startSSE(
      this.offset,
      this.cursor,
      this.#abortController.signal
    )
    if (newSSEResponse.body) {
      return parseSSEStream(newSSEResponse.body, this.#abortController.signal)
    }
    return null
  }

  /**
   * Process SSE events from the iterator.
   * Returns an object indicating the result:
   * - { type: 'response', response, newIterator? } - yield this response
   * - { type: 'closed' } - stream should be closed
   * - { type: 'error', error } - an error occurred
   * - { type: 'continue', newIterator? } - continue processing (control-only event)
   */
  async #processSSEEvents(
    sseEventIterator: AsyncGenerator<SSEEvent, void, undefined>
  ): Promise<
    | {
        type: `response`
        response: Response
        newIterator?: AsyncGenerator<SSEEvent, void, undefined>
      }
    | { type: `closed` }
    | { type: `error`; error: Error }
    | {
        type: `continue`
        newIterator?: AsyncGenerator<SSEEvent, void, undefined>
      }
  > {
    const { done, value: event } = await sseEventIterator.next()

    if (done) {
      // SSE stream ended - try to reconnect
      try {
        const newIterator = await this.#trySSEReconnect()
        if (newIterator) {
          return { type: `continue`, newIterator }
        }
      } catch (err) {
        return {
          type: `error`,
          error:
            err instanceof Error ? err : new Error(`SSE reconnection failed`),
        }
      }
      return { type: `closed` }
    }

    if (event.type === `data`) {
      // Wait for the subsequent control event to get correct offset/cursor/upToDate
      return this.#processSSEDataEvent(event.data, sseEventIterator)
    }

    // Control event without preceding data - update state and continue
    this.#updateStateFromSSEControl(event)
    return { type: `continue` }
  }

  /**
   * Process an SSE data event by waiting for its corresponding control event.
   * In SSE protocol, control events come AFTER data events.
   * Multiple data events may arrive before a single control event - we buffer them.
   */
  async #processSSEDataEvent(
    pendingData: string,
    sseEventIterator: AsyncGenerator<SSEEvent, void, undefined>
  ): Promise<
    | {
        type: `response`
        response: Response
        newIterator?: AsyncGenerator<SSEEvent, void, undefined>
      }
    | { type: `error`; error: Error }
  > {
    // Buffer to accumulate data from multiple consecutive data events
    let bufferedData = pendingData

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    while (true) {
      const { done: controlDone, value: controlEvent } =
        await sseEventIterator.next()

      if (controlDone) {
        // Stream ended without control event - yield buffered data with current state
        const response = this.#createSSESyntheticResponse(
          bufferedData,
          this.offset,
          this.cursor,
          this.upToDate
        )

        // Try to reconnect
        try {
          const newIterator = await this.#trySSEReconnect()
          return {
            type: `response`,
            response,
            newIterator: newIterator ?? undefined,
          }
        } catch (err) {
          return {
            type: `error`,
            error:
              err instanceof Error ? err : new Error(`SSE reconnection failed`),
          }
        }
      }

      if (controlEvent.type === `control`) {
        // Update state and create response with correct metadata
        this.#updateStateFromSSEControl(controlEvent)
        const response = this.#createSSESyntheticResponse(
          bufferedData,
          controlEvent.streamNextOffset,
          controlEvent.streamCursor,
          controlEvent.upToDate ?? false
        )
        return { type: `response`, response }
      }

      // Got another data event before control - buffer it
      // Server sends multiple data events followed by one control event
      bufferedData += controlEvent.data
    }
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
              // Track SSE connection start for resilience monitoring
              this.#markSSEConnectionStart()
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
              const result = await this.#processSSEEvents(sseEventIterator)

              switch (result.type) {
                case `response`:
                  if (result.newIterator) {
                    sseEventIterator = result.newIterator
                  }
                  controller.enqueue(result.response)
                  return

                case `closed`:
                  this.#markClosed()
                  controller.close()
                  return

                case `error`:
                  this.#markError(result.error)
                  controller.error(result.error)
                  return

                case `continue`:
                  if (result.newIterator) {
                    sseEventIterator = result.newIterator
                  }
                  continue
              }
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
            // Let the next pull() decide whether to close based on upToDate
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
    this.#ensureNoConsumption(`body`)
    this.#stopAfterUpToDate = true
    const reader = this.#getResponseReader()
    const blobs: Array<Blob> = []

    try {
      let result = await reader.read()
      while (!result.done) {
        // Capture upToDate BEFORE consuming body (to avoid race with prefetch)
        const wasUpToDate = this.upToDate
        const blob = await result.value.blob()
        if (blob.size > 0) {
          blobs.push(blob)
        }
        if (wasUpToDate) break
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

  async json<T = TJson>(): Promise<Array<T>> {
    this.#ensureNoConsumption(`json`)
    this.#ensureJsonMode()
    this.#stopAfterUpToDate = true
    const reader = this.#getResponseReader()
    const items: Array<T> = []

    try {
      let result = await reader.read()
      while (!result.done) {
        // Capture upToDate BEFORE parsing (to avoid race with prefetch)
        const wasUpToDate = this.upToDate
        // Get response text first (handles empty responses gracefully)
        const text = await result.value.text()
        const content = text.trim() || `[]` // Default to empty array if no content or whitespace
        const parsed = JSON.parse(content) as T | Array<T>
        if (Array.isArray(parsed)) {
          items.push(...parsed)
        } else {
          items.push(parsed)
        }
        // Check if THIS response had upToDate set when we started reading it
        if (wasUpToDate) break
        result = await reader.read()
      }
    } finally {
      reader.releaseLock()
    }

    this.#markClosed()
    return items
  }

  async text(): Promise<string> {
    this.#ensureNoConsumption(`text`)
    this.#stopAfterUpToDate = true
    const reader = this.#getResponseReader()
    const parts: Array<string> = []

    try {
      let result = await reader.read()
      while (!result.done) {
        // Capture upToDate BEFORE consuming text (to avoid race with prefetch)
        const wasUpToDate = this.upToDate
        const text = await result.value.text()
        if (text) {
          parts.push(text)
        }
        if (wasUpToDate) break
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

  /**
   * Internal helper to create the body stream without consumption check.
   * Used by both bodyStream() and textStream().
   */
  #createBodyStreamInternal(): ReadableStream<Uint8Array> {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
    const reader = this.#getResponseReader()

    const pipeBodyStream = async (): Promise<void> => {
      try {
        let result = await reader.read()
        while (!result.done) {
          // Capture upToDate BEFORE consuming body (to avoid race with prefetch)
          const wasUpToDate = this.upToDate
          const body = result.value.body
          if (body) {
            await body.pipeTo(writable, {
              preventClose: true,
              preventAbort: true,
              preventCancel: true,
            })
          }

          if (wasUpToDate && !this.#shouldContinueLive()) {
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

  bodyStream(): ReadableStream<Uint8Array> {
    this.#ensureNoConsumption(`bodyStream`)
    return this.#createBodyStreamInternal()
  }

  jsonStream(): ReadableStream<TJson> {
    this.#ensureNoConsumption(`jsonStream`)
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

        // Parse JSON and flatten arrays (handle empty responses gracefully)
        const text = await response.text()
        const content = text.trim() || `[]` // Default to empty array if no content or whitespace
        const parsed = JSON.parse(content) as TJson | Array<TJson>
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
    this.#ensureNoConsumption(`textStream`)
    const decoder = new TextDecoder()

    return this.#createBodyStreamInternal().pipeThrough(
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

  subscribeJson<T = TJson>(
    subscriber: (batch: JsonBatch<T>) => Promise<void>
  ): () => void {
    this.#ensureNoConsumption(`subscribeJson`)
    this.#ensureJsonMode()
    const abortController = new AbortController()
    const reader = this.#getResponseReader()

    const consumeJsonSubscription = async (): Promise<void> => {
      try {
        let result = await reader.read()
        while (!result.done) {
          if (abortController.signal.aborted) break

          // Get metadata from Response headers (not from `this` which may be stale)
          const response = result.value
          const { offset, cursor, upToDate } =
            this.#getMetadataFromResponse(response)

          // Get response text first (handles empty responses gracefully)
          const text = await response.text()
          const content = text.trim() || `[]` // Default to empty array if no content or whitespace
          const parsed = JSON.parse(content) as T | Array<T>
          const items = Array.isArray(parsed) ? parsed : [parsed]

          await subscriber({
            items,
            offset,
            cursor,
            upToDate,
          })

          result = await reader.read()
        }
        this.#markClosed()
      } catch (e) {
        // Ignore abort-related and body-consumed errors
        const isAborted = abortController.signal.aborted
        const isBodyError = e instanceof TypeError && String(e).includes(`Body`)
        if (!isAborted && !isBodyError) {
          this.#markError(e instanceof Error ? e : new Error(String(e)))
        } else {
          this.#markClosed()
        }
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
    this.#ensureNoConsumption(`subscribeBytes`)
    const abortController = new AbortController()
    const reader = this.#getResponseReader()

    const consumeBytesSubscription = async (): Promise<void> => {
      try {
        let result = await reader.read()
        while (!result.done) {
          if (abortController.signal.aborted) break

          // Get metadata from Response headers (not from `this` which may be stale)
          const response = result.value
          const { offset, cursor, upToDate } =
            this.#getMetadataFromResponse(response)

          const buffer = await response.arrayBuffer()

          await subscriber({
            data: new Uint8Array(buffer),
            offset,
            cursor,
            upToDate,
          })

          result = await reader.read()
        }
        this.#markClosed()
      } catch (e) {
        // Ignore abort-related and body-consumed errors
        const isAborted = abortController.signal.aborted
        const isBodyError = e instanceof TypeError && String(e).includes(`Body`)
        if (!isAborted && !isBodyError) {
          this.#markError(e instanceof Error ? e : new Error(String(e)))
        } else {
          this.#markClosed()
        }
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
    this.#ensureNoConsumption(`subscribeText`)
    const abortController = new AbortController()
    const reader = this.#getResponseReader()

    const consumeTextSubscription = async (): Promise<void> => {
      try {
        let result = await reader.read()
        while (!result.done) {
          if (abortController.signal.aborted) break

          // Get metadata from Response headers (not from `this` which may be stale)
          const response = result.value
          const { offset, cursor, upToDate } =
            this.#getMetadataFromResponse(response)

          const text = await response.text()

          await subscriber({
            text,
            offset,
            cursor,
            upToDate,
          })

          result = await reader.read()
        }
        this.#markClosed()
      } catch (e) {
        // Ignore abort-related and body-consumed errors
        const isAborted = abortController.signal.aborted
        const isBodyError = e instanceof TypeError && String(e).includes(`Body`)
        if (!isAborted && !isBodyError) {
          this.#markError(e instanceof Error ? e : new Error(String(e)))
        } else {
          this.#markClosed()
        }
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
