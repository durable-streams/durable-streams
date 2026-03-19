/**
 * StreamResponse - A streaming session for reading from a durable stream.
 *
 * Represents a live session with fixed `url`, `offset`, and `live` parameters.
 * Supports multiple consumption styles: Promise helpers, ReadableStreams, and Subscribers.
 */

import { asAsyncIterableReadableStream } from "./asyncIterableReadableStream"
import {
  STREAM_CLOSED_HEADER,
  STREAM_CURSOR_HEADER,
  STREAM_OFFSET_HEADER,
  STREAM_UP_TO_DATE_HEADER,
} from "./constants"
import { DurableStreamError, FetchError } from "./error"
import { FastLoopDetector } from "./fast-loop-detection"
import { PauseLock } from "./pause-lock"
import { parseSSEStream } from "./sse"
import {
  ActiveState,
  ErrorState,
  LiveState,
  PausedState,
  ReplayingState,
  StaleRetryState,
  SyncingState,
  createCacheBuster,
} from "./stream-response-state"
import { subscribeToWakeDetection } from "./wake-detection"
import type { UpToDateTracker } from "./up-to-date-tracker"
import type { ReadableStreamAsyncIterable } from "./asyncIterableReadableStream"
import type { SSEEvent } from "./sse"
import type { StreamState } from "./stream-response-state"
import type {
  ByteChunk,
  StreamResponse as IStreamResponse,
  JsonBatch,
  LiveMode,
  Offset,
  SSEResilienceOptions,
  StreamErrorHandler,
  TextChunk,
} from "./types"

/**
 * Constant used as abort reason when pausing the stream due to visibility change.
 */
const PAUSE_STREAM = `PAUSE_STREAM`

/**
 * Constant used as abort reason when the system wakes from sleep.
 */
const SYSTEM_WAKE = `SYSTEM_WAKE`

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
  /** Initial streamClosed from first response headers */
  initialStreamClosed: boolean
  /** The held first Response object */
  firstResponse: Response
  /** Abort controller for the session */
  abortController: AbortController
  /** Function to fetch the next chunk (for long-poll) */
  fetchNext: (
    offset: Offset,
    cursor: string | undefined,
    signal: AbortSignal,
    resumingFromPause?: boolean,
    cacheBuster?: string
  ) => Promise<Response>
  /** Function to start SSE connection and return a Response with SSE body */
  startSSE?: (
    offset: Offset,
    cursor: string | undefined,
    signal: AbortSignal
  ) => Promise<Response>
  /** SSE resilience options */
  sseResilience?: SSEResilienceOptions
  /** Encoding for SSE data events */
  encoding?: `base64`
  /** Error handler for mid-stream recoverable errors */
  onError?: StreamErrorHandler
  /** Up-to-date tracker for replay mode entry */
  upToDateTracker?: UpToDateTracker
  /** Canonical stream key for up-to-date tracking */
  streamKey?: string
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

  // --- Evolving state (immutable state machine) ---
  #syncState: StreamState

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

  // --- Visibility/Pause State ---
  #pauseLock: PauseLock
  #requestAbortController?: AbortController
  #unsubscribeFromVisibilityChanges?: () => void
  #unsubscribeFromWakeDetection?: () => void
  #pauseResolve?: () => void

  // --- SSE Resilience Config ---
  #sseResilience: Required<SSEResilienceOptions>

  // --- SSE Encoding State ---
  #encoding?: `base64`

  // --- Error Recovery ---
  #onError?: StreamErrorHandler

  // --- Fast Loop Detection ---
  #fastLoopDetector: FastLoopDetector

  // --- Replay Mode / Up-to-date Tracking ---
  #upToDateTracker?: UpToDateTracker
  #streamKey?: string

  // --- Duplicate URL Guard ---
  #duplicateUrlCount = 0

  // Core primitive: a ReadableStream of Response objects
  #responseStream: ReadableStream<Response>

  constructor(config: StreamResponseConfig) {
    this.url = config.url
    this.contentType = config.contentType
    this.live = config.live
    this.startOffset = config.startOffset

    // Initialize immutable state machine — SyncingState since we already
    // have the first response metadata.
    this.#syncState = new SyncingState({
      offset: config.initialOffset,
      cursor: config.initialCursor,
      upToDate: config.initialUpToDate,
      streamClosed: config.initialStreamClosed,
    })

    // Check replay mode entry (one-shot, after first response)
    if (
      config.upToDateTracker &&
      config.streamKey &&
      !this.#syncState.upToDate
    ) {
      const replayCursor = config.upToDateTracker.shouldEnterReplayMode(
        config.streamKey
      )
      if (replayCursor && this.#syncState.canEnterReplayMode()) {
        this.#syncState = new ReplayingState(
          {
            offset: this.#syncState.offset,
            cursor: this.#syncState.cursor,
            upToDate: this.#syncState.upToDate,
            streamClosed: this.#syncState.streamClosed,
          },
          replayCursor
        )
      }
    }

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

    // Initialize SSE encoding
    this.#encoding = config.encoding

    // Initialize error handler
    this.#onError = config.onError

    // Initialize fast loop detector
    this.#fastLoopDetector = new FastLoopDetector()

    // Initialize replay mode tracking
    this.#upToDateTracker = config.upToDateTracker
    this.#streamKey = config.streamKey

    this.#closed = new Promise((resolve, reject) => {
      this.#closedResolve = resolve
      this.#closedReject = reject
    })

    // Initialize PauseLock for visibility-based pause/resume
    this.#pauseLock = new PauseLock({
      onAcquired: () => {
        this.#syncState = this.#syncState.pause()
        this.#requestAbortController?.abort(PAUSE_STREAM)
      },
      onReleased: () => {
        this.#pauseResolve?.()
        this.#pauseResolve = undefined
      },
    })

    // Create the core response stream
    this.#responseStream = this.#createResponseStream(config.firstResponse)

    // Install single abort listener that propagates to current request controller
    // and unblocks any paused pull() (avoids accumulating one listener per request)
    this.#abortController.signal.addEventListener(
      `abort`,
      () => {
        this.#requestAbortController?.abort(this.#abortController.signal.reason)
        // Unblock pull() if paused, so it can see the abort and close
        this.#pauseResolve?.()
        this.#pauseResolve = undefined
      },
      { once: true }
    )

    // Subscribe to visibility changes for pause/resume (browser only)
    this.#subscribeToVisibilityChanges()
  }

  /**
   * Subscribe to document visibility changes to pause/resume syncing.
   * When the page is hidden, we pause to save battery and bandwidth.
   * When visible again, we resume syncing.
   */
  #subscribeToVisibilityChanges(): void {
    // Only subscribe in browser environments
    if (
      typeof document === `object` &&
      typeof document.hidden === `boolean` &&
      typeof document.addEventListener === `function`
    ) {
      const visibilityHandler = (): void => {
        if (document.hidden) {
          this.#pauseLock.acquire(`visibility`)
        } else {
          if (this.#abortController.signal.aborted) {
            return
          }
          this.#pauseLock.release(`visibility`)
        }
      }

      document.addEventListener(`visibilitychange`, visibilityHandler)

      // Store cleanup function to remove the event listener
      // Check document still exists (may be undefined in tests after cleanup)
      this.#unsubscribeFromVisibilityChanges = () => {
        if (typeof document === `object`) {
          document.removeEventListener(`visibilitychange`, visibilityHandler)
        }
      }

      // Check initial state - page might already be hidden when stream starts
      if (document.hidden) {
        this.#pauseLock.acquire(`visibility`)
      }
    }
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

  // --- Evolving state getters (delegated to state machine) ---

  get offset(): Offset {
    return this.#syncState.offset
  }

  get cursor(): string | undefined {
    return this.#syncState.cursor
  }

  get upToDate(): boolean {
    return this.#syncState.upToDate
  }

  get streamClosed(): boolean {
    return this.#syncState.streamClosed
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
    this.#unsubscribeFromVisibilityChanges?.()
    this.#unsubscribeFromWakeDetection?.()
    this.#unsubscribeFromWakeDetection = undefined
    this.#closedResolve()
  }

  #markError(err: Error): void {
    this.#unsubscribeFromVisibilityChanges?.()
    this.#unsubscribeFromWakeDetection?.()
    this.#unsubscribeFromWakeDetection = undefined
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
   * and whether we've received upToDate or streamClosed.
   */
  #shouldContinueLive(): boolean {
    if (this.#stopAfterUpToDate && this.#syncState.upToDate) return false
    if (this.live === false) return false
    if (this.#syncState.streamClosed) return false
    return true
  }

  /**
   * Update state from response headers.
   */
  #updateStateFromResponse(response: Response): void {
    // Immutable state transition via new state machine
    const transition = this.#syncState.handleResponseMetadata({
      offset: response.headers.get(STREAM_OFFSET_HEADER) || undefined,
      cursor: response.headers.get(STREAM_CURSOR_HEADER) || undefined,
      upToDate: response.headers.has(STREAM_UP_TO_DATE_HEADER),
      streamClosed:
        response.headers.get(STREAM_CLOSED_HEADER)?.toLowerCase() === `true`,
    })
    this.#syncState = transition.state

    // Record cursor on up-to-date for replay mode dedup
    if (
      this.#upToDateTracker &&
      this.#streamKey &&
      this.#syncState.upToDate &&
      this.#syncState.cursor
    ) {
      this.#upToDateTracker.recordUpToDate(
        this.#streamKey,
        this.#syncState.cursor
      )
    }

    // Update response metadata to reflect latest server response
    this.#headers = response.headers
    this.#status = response.status
    this.#statusText = response.statusText
    this.#ok = response.ok
  }

  /**
   * Update instance state from an SSE control event.
   * Maps SSE control fields to a response metadata update.
   */
  #updateStateFromSSEControl(controlEvent: {
    streamNextOffset: Offset
    streamCursor?: string
    upToDate?: boolean
    streamClosed?: boolean
  }): void {
    const streamClosed = controlEvent.streamClosed ?? false
    const transition = this.#syncState.handleResponseMetadata({
      offset: controlEvent.streamNextOffset,
      cursor: controlEvent.streamCursor,
      upToDate: streamClosed ? true : (controlEvent.upToDate ?? false),
      streamClosed,
    })
    this.#syncState = transition.state
  }

  /**
   * SSE connection start time for duration tracking.
   */
  #sseConnectionStartTime: number | undefined

  /**
   * Mark the start of an SSE connection for duration tracking.
   * If the state is not yet LiveState, transition to it (we're now live via SSE).
   */
  #markSSEConnectionStart(): void {
    if (!(this.#syncState instanceof LiveState)) {
      this.#syncState = new LiveState({
        offset: this.#syncState.offset,
        cursor: this.#syncState.cursor,
        upToDate: this.#syncState.upToDate,
        streamClosed: this.#syncState.streamClosed,
      })
    }
    this.#sseConnectionStartTime = Date.now()
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
    // Check if we should fall back to long-poll
    const sseEnabled = this.#startSSE !== undefined
    if (
      !(this.#syncState instanceof LiveState) ||
      !this.#syncState.shouldUseSse({
        liveSseEnabled: sseEnabled,
        resumingFromPause: false,
      })
    ) {
      return null
    }

    if (!this.#shouldContinueLive() || !this.#startSSE) {
      return null
    }

    // Check connection duration via LiveState
    const connectionDuration =
      this.#sseConnectionStartTime !== undefined
        ? Date.now() - this.#sseConnectionStartTime
        : 0
    const result = this.#syncState.handleSseConnectionClosed({
      connectionDuration,
      wasAborted: this.#abortController.signal.aborted,
      minConnectionDuration: this.#sseResilience.minConnectionDuration,
      maxShortConnections: this.#sseResilience.maxShortConnections,
    })
    this.#syncState = result.state

    // Check if we fell back to long-polling
    const sseCloseResult = result as {
      state: LiveState
      fellBackToLongPolling?: boolean
      wasShortConnection?: boolean
    }
    if (sseCloseResult.fellBackToLongPolling) {
      if (this.#sseResilience.logWarnings) {
        console.warn(
          `[Durable Streams] SSE connections are closing immediately (possibly due to proxy buffering or misconfiguration). ` +
            `Falling back to long polling. ` +
            `Your proxy must support streaming SSE responses (not buffer the complete response). ` +
            `Configuration: Nginx add 'X-Accel-Buffering: no', Caddy add 'flush_interval -1' to reverse_proxy.`
        )
      }
      return null
    }

    // If it was a short connection but not yet at threshold, apply backoff
    if (sseCloseResult.wasShortConnection) {
      const backoffAttempt = (result.state as LiveState)
        .consecutiveShortConnections
      const maxDelay = Math.min(
        this.#sseResilience.backoffMaxDelay,
        this.#sseResilience.backoffBaseDelay * Math.pow(2, backoffAttempt)
      )
      const delayMs = Math.floor(Math.random() * maxDelay)
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }

    // Track new connection start
    this.#markSSEConnectionStart()

    // Create new per-request abort controller for this SSE connection
    this.#requestAbortController = new AbortController()

    const newSSEResponse = await this.#startSSE(
      this.offset,
      this.cursor,
      this.#requestAbortController.signal
    )
    if (newSSEResponse.body) {
      return parseSSEStream(
        newSSEResponse.body,
        this.#requestAbortController.signal
      )
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

    // Control event without preceding data - update state
    this.#updateStateFromSSEControl(event)

    // If upToDate is signaled, yield an empty response so subscribers receive the signal
    // This is important for empty streams and for subscribers waiting for catch-up completion
    if (event.upToDate) {
      const response = createSSESyntheticResponse(
        ``,
        event.streamNextOffset,
        event.streamCursor,
        true,
        event.streamClosed ?? false,
        this.contentType,
        this.#encoding
      )
      return { type: `response`, response }
    }

    return { type: `continue` }
  }

  /**
   * Process an SSE data event by waiting for its corresponding control event.
   * In SSE protocol, control events come AFTER data events.
   * Multiple data events may arrive before a single control event - we buffer them.
   *
   * For base64 mode, each data event is independently base64 encoded, so we
   * collect them as an array and decode each separately.
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
    // For base64 mode, we collect as array since each event is independently encoded
    const bufferedDataParts: Array<string> = [pendingData]

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    while (true) {
      const { done: controlDone, value: controlEvent } =
        await sseEventIterator.next()

      if (controlDone) {
        // Stream ended without control event - yield buffered data with current state
        const response = createSSESyntheticResponseFromParts(
          bufferedDataParts,
          this.offset,
          this.cursor,
          this.upToDate,
          this.streamClosed,
          this.contentType,
          this.#encoding,
          this.#isJsonMode
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
        const response = createSSESyntheticResponseFromParts(
          bufferedDataParts,
          controlEvent.streamNextOffset,
          controlEvent.streamCursor,
          controlEvent.upToDate ?? false,
          controlEvent.streamClosed ?? false,
          this.contentType,
          this.#encoding,
          this.#isJsonMode
        )
        return { type: `response`, response }
      }

      // Got another data event before control - buffer it
      // Server sends multiple data events followed by one control event
      bufferedDataParts.push(controlEvent.data)
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
    let lastRequestUrl: string | undefined

    return new ReadableStream<Response>({
      pull: async (controller) => {
        if (!this.#unsubscribeFromWakeDetection) {
          this.#unsubscribeFromWakeDetection = subscribeToWakeDetection({
            onWake: () => this.#requestAbortController?.abort(SYSTEM_WAKE),
          })
        }

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
              // Create per-request abort controller for SSE connection
              this.#requestAbortController = new AbortController()
              // Start parsing SSE events
              sseEventIterator = parseSSEStream(
                firstResponse.body,
                this.#requestAbortController.signal
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
            // Check for pause state before processing SSE events
            if (this.#pauseLock.isPaused) {
              await new Promise<void>((resolve) => {
                this.#pauseResolve = resolve
              })
              // Unwrap PausedState after resume
              if (this.#syncState instanceof PausedState) {
                this.#syncState = this.#syncState.resume()
              }
              // After resume, check if we should still continue
              if (this.#abortController.signal.aborted) {
                this.#markClosed()
                controller.close()
                return
              }
              // Reconnect SSE after resume
              const newIterator = await this.#trySSEReconnect()
              if (newIterator) {
                sseEventIterator = newIterator
              } else {
                // Could not reconnect - close the stream
                this.#markClosed()
                controller.close()
                return
              }
            }

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
            // Determine if we're resuming from pause — local variable replaces
            // the old #justResumedFromPause one-shot field. If we enter the pause
            // branch and wake up without abort, we just resumed.
            let resumingFromPause = false
            if (this.#pauseLock.isPaused) {
              await new Promise<void>((resolve) => {
                this.#pauseResolve = resolve
              })
              // Unwrap PausedState after resume
              if (this.#syncState instanceof PausedState) {
                this.#syncState = this.#syncState.resume()
              }
              // After resume, check if we should still continue
              if (this.#abortController.signal.aborted) {
                this.#markClosed()
                controller.close()
                return
              }
              resumingFromPause = true
            }

            if (this.#abortController.signal.aborted) {
              this.#markClosed()
              controller.close()
              return
            }

            // Fast loop detection for non-live (catch-up) requests
            const isLiveRequest = this.#syncState instanceof LiveState
            if (!isLiveRequest) {
              const loopResult = this.#fastLoopDetector.check(
                this.#syncState.offset
              )
              switch (loopResult.action) {
                case `ok`:
                  break
                case `clear-and-reset`:
                  console.warn(
                    `[durable-streams] Detected fast retry loop. Adding cache buster.`
                  )
                  this.#syncState = new StaleRetryState(
                    {
                      offset: this.#syncState.offset,
                      cursor: this.#syncState.cursor,
                      upToDate: this.#syncState.upToDate,
                      streamClosed: this.#syncState.streamClosed,
                    },
                    createCacheBuster()
                  )
                  break
                case `backoff`:
                  await new Promise((resolve) =>
                    setTimeout(resolve, loopResult.delayMs)
                  )
                  break
                case `fatal`:
                  throw new FetchError(
                    502,
                    loopResult.message,
                    undefined,
                    {},
                    this.url
                  )
              }
            }

            // Duplicate-URL guard: detect when the same request would be made repeatedly
            let cacheBuster: string | undefined
            const requestKey = `${this.offset}|${this.cursor ?? ``}`
            if (!isLiveRequest && lastRequestUrl === requestKey) {
              this.#duplicateUrlCount++
              if (this.#duplicateUrlCount >= 5) {
                throw new FetchError(
                  502,
                  undefined,
                  undefined,
                  {},
                  this.url,
                  `Same URL requested 5 times consecutively. This indicates a proxy or CDN misconfiguration.`
                )
              }
              cacheBuster = createCacheBuster()
            } else {
              this.#duplicateUrlCount = 0
            }
            lastRequestUrl = requestKey

            // Create a new AbortController for this request (so we can abort on pause)
            this.#requestAbortController = new AbortController()

            const prevOffset = this.offset
            const response = await this.#fetchNext(
              this.offset,
              this.cursor,
              this.#requestAbortController.signal,
              resumingFromPause,
              cacheBuster
            )

            this.#updateStateFromResponse(response)

            // Reset fast loop detector on offset advance or live request
            if (
              this.offset !== prevOffset ||
              this.#syncState instanceof LiveState
            ) {
              this.#fastLoopDetector.reset()
            }

            controller.enqueue(response)
            // Let the next pull() decide whether to close based on upToDate
            return
          }

          // No more data
          this.#markClosed()
          controller.close()
        } catch (err) {
          // Check if this was a pause-triggered abort
          // Treat PAUSE_STREAM aborts as benign regardless of current state
          // (handles race where resume() was called before abort completed)
          if (
            this.#requestAbortController?.signal.aborted &&
            this.#requestAbortController.signal.reason === PAUSE_STREAM
          ) {
            return
          }

          if (this.#requestAbortController?.signal.reason === SYSTEM_WAKE) {
            // System woke from sleep — restart from current offset
            return // pull() will be called again, triggering a fresh request
          }

          if (this.#abortController.signal.aborted) {
            this.#markClosed()
            controller.close()
          } else {
            // Recoverable error — try onError handler
            if (this.#onError) {
              const errorObj =
                err instanceof Error ? err : new Error(String(err))
              if (this.#syncState instanceof ActiveState) {
                this.#syncState = this.#syncState.toErrorState(errorObj)
              }
              try {
                const retryOpts = await this.#onError(
                  err instanceof Error ? err : new Error(String(err))
                )
                if (retryOpts !== undefined) {
                  // User wants to retry — unwrap ErrorState
                  if (this.#syncState instanceof ErrorState) {
                    this.#syncState = this.#syncState.retry()
                  }
                  return // pull() will be called again
                }
              } catch {
                // onError handler itself threw — fall through to fatal
              }
            }

            // Fatal — propagate error
            this.#markError(err instanceof Error ? err : new Error(String(err)))
            controller.error(err)
          }
        }
      },

      cancel: () => {
        this.#abortController.abort()
        this.#unsubscribeFromVisibilityChanges?.()
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
        let parsed: T | Array<T>
        try {
          parsed = JSON.parse(content) as T | Array<T>
        } catch (err) {
          const preview =
            content.length > 100 ? content.slice(0, 100) + `...` : content
          throw new DurableStreamError(
            `Failed to parse JSON response: ${err instanceof Error ? err.message : String(err)}. Data: ${preview}`,
            `PARSE_ERROR`
          )
        }
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

  bodyStream(): ReadableStreamAsyncIterable<Uint8Array> {
    this.#ensureNoConsumption(`bodyStream`)
    return asAsyncIterableReadableStream(this.#createBodyStreamInternal())
  }

  jsonStream(): ReadableStreamAsyncIterable<TJson> {
    this.#ensureNoConsumption(`jsonStream`)
    this.#ensureJsonMode()
    const reader = this.#getResponseReader()
    let pendingItems: Array<TJson> = []

    const stream = new ReadableStream<TJson>({
      pull: async (controller) => {
        // Drain pending items first
        if (pendingItems.length > 0) {
          controller.enqueue(pendingItems.shift())
          return
        }

        // Keep reading until we can enqueue at least one item.
        // This avoids stalling when a response contains an empty JSON array.
        let result = await reader.read()
        while (!result.done) {
          const response = result.value

          // Parse JSON and flatten arrays (handle empty responses gracefully)
          const text = await response.text()
          const content = text.trim() || `[]` // Default to empty array if no content or whitespace
          let parsed: TJson | Array<TJson>
          try {
            parsed = JSON.parse(content) as TJson | Array<TJson>
          } catch (err) {
            const preview =
              content.length > 100 ? content.slice(0, 100) + `...` : content
            throw new DurableStreamError(
              `Failed to parse JSON response: ${err instanceof Error ? err.message : String(err)}. Data: ${preview}`,
              `PARSE_ERROR`
            )
          }
          pendingItems = Array.isArray(parsed) ? parsed : [parsed]

          if (pendingItems.length > 0) {
            controller.enqueue(pendingItems.shift())
            return
          }

          // Empty JSON batch; read the next response.
          result = await reader.read()
        }

        this.#markClosed()
        controller.close()
        return
      },

      cancel: () => {
        reader.releaseLock()
        this.cancel()
      },
    })

    return asAsyncIterableReadableStream(stream)
  }

  textStream(): ReadableStreamAsyncIterable<string> {
    this.#ensureNoConsumption(`textStream`)
    const decoder = new TextDecoder()

    const stream = this.#createBodyStreamInternal().pipeThrough(
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

    return asAsyncIterableReadableStream(stream)
  }

  // =====================
  // 3) Subscriber APIs
  // =====================

  subscribeJson<T = TJson>(
    subscriber: (batch: JsonBatch<T>) => void | Promise<void>
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
          const { offset, cursor, upToDate, streamClosed } =
            getMetadataFromResponse(
              response,
              this.offset,
              this.cursor,
              this.streamClosed
            )

          // Get response text first (handles empty responses gracefully)
          const text = await response.text()
          const content = text.trim() || `[]` // Default to empty array if no content or whitespace
          let parsed: T | Array<T>
          try {
            parsed = JSON.parse(content) as T | Array<T>
          } catch (err) {
            const preview =
              content.length > 100 ? content.slice(0, 100) + `...` : content
            throw new DurableStreamError(
              `Failed to parse JSON response: ${err instanceof Error ? err.message : String(err)}. Data: ${preview}`,
              `PARSE_ERROR`
            )
          }
          const items = Array.isArray(parsed) ? parsed : [parsed]

          // Await callback (handles both sync and async)
          await subscriber({
            items,
            offset,
            cursor,
            upToDate,
            streamClosed,
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

  subscribeBytes(
    subscriber: (chunk: ByteChunk) => void | Promise<void>
  ): () => void {
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
          const { offset, cursor, upToDate, streamClosed } =
            getMetadataFromResponse(
              response,
              this.offset,
              this.cursor,
              this.streamClosed
            )

          const buffer = await response.arrayBuffer()

          // Await callback (handles both sync and async)
          await subscriber({
            data: new Uint8Array(buffer),
            offset,
            cursor,
            upToDate,
            streamClosed,
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

  subscribeText(
    subscriber: (chunk: TextChunk) => void | Promise<void>
  ): () => void {
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
          const { offset, cursor, upToDate, streamClosed } =
            getMetadataFromResponse(
              response,
              this.offset,
              this.cursor,
              this.streamClosed
            )

          const text = await response.text()

          // Await callback (handles both sync and async)
          await subscriber({
            text,
            offset,
            cursor,
            upToDate,
            streamClosed,
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
    this.#unsubscribeFromVisibilityChanges?.()
    this.#markClosed()
  }

  get closed(): Promise<void> {
    return this.#closed
  }
}

// =================================
// Pure helper functions
// =================================

/**
 * Extract stream metadata from Response headers.
 * Falls back to the provided defaults when headers are absent.
 */
function getMetadataFromResponse(
  response: Response,
  fallbackOffset: Offset,
  fallbackCursor: string | undefined,
  fallbackStreamClosed: boolean
): {
  offset: Offset
  cursor: string | undefined
  upToDate: boolean
  streamClosed: boolean
} {
  const offset = response.headers.get(STREAM_OFFSET_HEADER)
  const cursor = response.headers.get(STREAM_CURSOR_HEADER)
  const upToDate = response.headers.has(STREAM_UP_TO_DATE_HEADER)
  const streamClosed =
    response.headers.get(STREAM_CLOSED_HEADER)?.toLowerCase() === `true`
  return {
    offset: offset ?? fallbackOffset,
    cursor: cursor ?? fallbackCursor,
    upToDate,
    streamClosed: streamClosed || fallbackStreamClosed,
  }
}

/**
 * Decode base64 string to Uint8Array.
 * Per protocol: concatenate data lines, remove \n and \r, then decode.
 */
function decodeBase64(base64Str: string): Uint8Array {
  // Remove all newlines and carriage returns per protocol
  const cleaned = base64Str.replace(/[\n\r]/g, ``)

  // Empty string is valid
  if (cleaned.length === 0) {
    return new Uint8Array(0)
  }

  // Validate length is multiple of 4
  if (cleaned.length % 4 !== 0) {
    throw new DurableStreamError(
      `Invalid base64 data: length ${cleaned.length} is not a multiple of 4`,
      `PARSE_ERROR`
    )
  }

  try {
    // Prefer Buffer (native C++ in Node) over atob (requires JS charCodeAt loop)
    if (typeof Buffer !== `undefined`) {
      return new Uint8Array(Buffer.from(cleaned, `base64`))
    } else {
      const binaryStr = atob(cleaned)
      const bytes = new Uint8Array(binaryStr.length)
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i)
      }
      return bytes
    }
  } catch (err) {
    throw new DurableStreamError(
      `Failed to decode base64 data: ${err instanceof Error ? err.message : String(err)}`,
      `PARSE_ERROR`
    )
  }
}

/**
 * Create a synthetic Response from SSE data with proper headers.
 * Includes offset/cursor/upToDate/streamClosed in headers so subscribers can read them.
 */
function createSSESyntheticResponse(
  data: string,
  offset: Offset,
  cursor: string | undefined,
  upToDate: boolean,
  streamClosed: boolean,
  contentType: string | undefined,
  encoding: `base64` | undefined
): Response {
  return createSSESyntheticResponseFromParts(
    [data],
    offset,
    cursor,
    upToDate,
    streamClosed,
    contentType,
    encoding
  )
}

/**
 * Create a synthetic Response from multiple SSE data parts.
 * For base64 mode, each part is independently encoded, so we decode each
 * separately and concatenate the binary results.
 * For text mode, parts are simply concatenated as strings.
 */
function createSSESyntheticResponseFromParts(
  dataParts: Array<string>,
  offset: Offset,
  cursor: string | undefined,
  upToDate: boolean,
  streamClosed: boolean,
  contentType: string | undefined,
  encoding: `base64` | undefined,
  isJsonMode?: boolean
): Response {
  const headers: Record<string, string> = {
    "content-type": contentType ?? `application/json`,
    [STREAM_OFFSET_HEADER]: String(offset),
  }
  if (cursor) {
    headers[STREAM_CURSOR_HEADER] = cursor
  }
  if (upToDate) {
    headers[STREAM_UP_TO_DATE_HEADER] = `true`
  }
  if (streamClosed) {
    headers[STREAM_CLOSED_HEADER] = `true`
  }

  // Decode base64 if encoding is used
  let body: BodyInit
  if (encoding === `base64`) {
    // Each data part is independently base64 encoded, decode each separately
    const decodedParts = dataParts
      .filter((part) => part.length > 0)
      .map((part) => decodeBase64(part))

    if (decodedParts.length === 0) {
      // No data - return empty body
      body = new ArrayBuffer(0)
    } else if (decodedParts.length === 1) {
      // Single part - use directly
      const decoded = decodedParts[0]!
      body = decoded.buffer.slice(
        decoded.byteOffset,
        decoded.byteOffset + decoded.byteLength
      ) as ArrayBuffer
    } else {
      // Multiple parts - concatenate binary data
      const totalLength = decodedParts.reduce(
        (sum, part) => sum + part.length,
        0
      )
      const combined = new Uint8Array(totalLength)
      let byteOffset = 0
      for (const part of decodedParts) {
        combined.set(part, byteOffset)
        byteOffset += part.length
      }
      body = combined.buffer
    }
  } else if (isJsonMode) {
    const mergedParts: Array<string> = []
    for (const part of dataParts) {
      const trimmed = part.trim()
      if (trimmed.length === 0) continue

      if (trimmed.startsWith(`[`) && trimmed.endsWith(`]`)) {
        const inner = trimmed.slice(1, -1).trim()
        if (inner.length > 0) {
          mergedParts.push(inner)
        }
      } else {
        mergedParts.push(trimmed)
      }
    }
    body = `[${mergedParts.join(`,`)}]`
  } else {
    body = dataParts.join(``)
  }

  return new Response(body, { status: 200, headers })
}
