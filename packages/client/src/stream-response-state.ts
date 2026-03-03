/**
 * Explicit state machine for StreamResponseImpl.
 *
 * Every transition returns a new state — no mutation.
 *
 * Hierarchy:
 *   StreamResponseState (abstract)
 *   ├── LongPollState         shouldUseSse() → false
 *   ├── SSEState              shouldUseSse() → true
 *   └── PausedState           delegates to wrapped inner state
 */

import type { SSEControlEvent } from "./sse"
import type { LiveMode, Offset, SSEResilienceOptions } from "./types"

/**
 * Shared sync fields across all state types.
 */
export interface SyncFields {
  readonly offset: Offset
  readonly cursor: string | undefined
  readonly upToDate: boolean
  readonly streamClosed: boolean
}

/**
 * Extracted metadata from an HTTP response for state transitions.
 * undefined values mean "not present in response, preserve current value".
 */
export interface ResponseMetadataUpdate {
  readonly offset?: string
  readonly cursor?: string
  readonly upToDate: boolean
  readonly streamClosed: boolean
}

/**
 * Result of SSEState.handleConnectionEnd().
 */
export type SSEConnectionEndResult =
  | {
      readonly action: `reconnect`
      readonly state: SSEState
      readonly backoffAttempt: number
    }
  | { readonly action: `fallback`; readonly state: LongPollState }
  | { readonly action: `healthy`; readonly state: SSEState }

/**
 * Abstract base class for stream response state.
 * All state transitions return new immutable state objects.
 */
export abstract class StreamResponseState implements SyncFields {
  abstract readonly offset: Offset
  abstract readonly cursor: string | undefined
  abstract readonly upToDate: boolean
  abstract readonly streamClosed: boolean

  abstract shouldUseSse(): boolean
  abstract withResponseMetadata(
    update: ResponseMetadataUpdate
  ): StreamResponseState
  abstract withSSEControl(event: SSEControlEvent): StreamResponseState
  abstract pause(): StreamResponseState

  shouldContinueLive(stopAfterUpToDate: boolean, liveMode: LiveMode): boolean {
    if (stopAfterUpToDate && this.upToDate) return false
    if (liveMode === false) return false
    if (this.streamClosed) return false
    return true
  }
}

/**
 * State for long-poll mode. shouldUseSse() returns false.
 */
export class LongPollState extends StreamResponseState {
  readonly offset: Offset
  readonly cursor: string | undefined
  readonly upToDate: boolean
  readonly streamClosed: boolean

  constructor(fields: SyncFields) {
    super()
    this.offset = fields.offset
    this.cursor = fields.cursor
    this.upToDate = fields.upToDate
    this.streamClosed = fields.streamClosed
  }

  shouldUseSse(): boolean {
    return false
  }

  withResponseMetadata(update: ResponseMetadataUpdate): LongPollState {
    return new LongPollState({
      offset: update.offset ?? this.offset,
      cursor: update.cursor ?? this.cursor,
      upToDate: update.upToDate,
      streamClosed: this.streamClosed || update.streamClosed,
    })
  }

  withSSEControl(event: SSEControlEvent): LongPollState {
    const streamClosed = this.streamClosed || (event.streamClosed ?? false)
    return new LongPollState({
      offset: event.streamNextOffset,
      cursor: event.streamCursor || this.cursor,
      upToDate:
        (event.streamClosed ?? false)
          ? true
          : (event.upToDate ?? this.upToDate),
      streamClosed,
    })
  }

  pause(): PausedState {
    return new PausedState(this)
  }
}

/**
 * State for SSE mode. shouldUseSse() returns true.
 * Tracks SSE connection resilience (short connection detection).
 */
export class SSEState extends StreamResponseState {
  readonly offset: Offset
  readonly cursor: string | undefined
  readonly upToDate: boolean
  readonly streamClosed: boolean
  readonly consecutiveShortConnections: number
  readonly connectionStartTime: number | undefined

  constructor(
    fields: SyncFields & {
      consecutiveShortConnections?: number
      connectionStartTime?: number
    }
  ) {
    super()
    this.offset = fields.offset
    this.cursor = fields.cursor
    this.upToDate = fields.upToDate
    this.streamClosed = fields.streamClosed
    this.consecutiveShortConnections = fields.consecutiveShortConnections ?? 0
    this.connectionStartTime = fields.connectionStartTime
  }

  shouldUseSse(): boolean {
    return true
  }

  withResponseMetadata(update: ResponseMetadataUpdate): SSEState {
    return new SSEState({
      offset: update.offset ?? this.offset,
      cursor: update.cursor ?? this.cursor,
      upToDate: update.upToDate,
      streamClosed: this.streamClosed || update.streamClosed,
      consecutiveShortConnections: this.consecutiveShortConnections,
      connectionStartTime: this.connectionStartTime,
    })
  }

  withSSEControl(event: SSEControlEvent): SSEState {
    const streamClosed = this.streamClosed || (event.streamClosed ?? false)
    return new SSEState({
      offset: event.streamNextOffset,
      cursor: event.streamCursor || this.cursor,
      upToDate:
        (event.streamClosed ?? false)
          ? true
          : (event.upToDate ?? this.upToDate),
      streamClosed,
      consecutiveShortConnections: this.consecutiveShortConnections,
      connectionStartTime: this.connectionStartTime,
    })
  }

  startConnection(now: number): SSEState {
    return new SSEState({
      offset: this.offset,
      cursor: this.cursor,
      upToDate: this.upToDate,
      streamClosed: this.streamClosed,
      consecutiveShortConnections: this.consecutiveShortConnections,
      connectionStartTime: now,
    })
  }

  handleConnectionEnd(
    now: number,
    wasAborted: boolean,
    config: Required<SSEResilienceOptions>
  ): SSEConnectionEndResult {
    if (this.connectionStartTime === undefined) {
      return { action: `healthy`, state: this }
    }

    const duration = now - this.connectionStartTime

    if (duration < config.minConnectionDuration && !wasAborted) {
      // Connection was too short — likely proxy buffering or misconfiguration
      const newCount = this.consecutiveShortConnections + 1

      if (newCount >= config.maxShortConnections) {
        // Threshold reached → permanent fallback to long-poll
        return {
          action: `fallback`,
          state: new LongPollState({
            offset: this.offset,
            cursor: this.cursor,
            upToDate: this.upToDate,
            streamClosed: this.streamClosed,
          }),
        }
      }

      // Reconnect with backoff
      return {
        action: `reconnect`,
        state: new SSEState({
          offset: this.offset,
          cursor: this.cursor,
          upToDate: this.upToDate,
          streamClosed: this.streamClosed,
          consecutiveShortConnections: newCount,
          connectionStartTime: this.connectionStartTime,
        }),
        backoffAttempt: newCount,
      }
    }

    if (duration >= config.minConnectionDuration) {
      // Healthy connection — reset counter
      return {
        action: `healthy`,
        state: new SSEState({
          offset: this.offset,
          cursor: this.cursor,
          upToDate: this.upToDate,
          streamClosed: this.streamClosed,
          consecutiveShortConnections: 0,
          connectionStartTime: this.connectionStartTime,
        }),
      }
    }

    // Aborted connection — don't change counter
    return { action: `healthy`, state: this }
  }

  pause(): PausedState {
    return new PausedState(this)
  }
}

/**
 * Paused state wrapper. Delegates all sync field access to the inner state.
 * resume() returns the wrapped state unchanged (identity preserved).
 */
export class PausedState extends StreamResponseState {
  readonly #inner: LongPollState | SSEState

  constructor(inner: LongPollState | SSEState) {
    super()
    this.#inner = inner
  }

  get offset(): Offset {
    return this.#inner.offset
  }

  get cursor(): string | undefined {
    return this.#inner.cursor
  }

  get upToDate(): boolean {
    return this.#inner.upToDate
  }

  get streamClosed(): boolean {
    return this.#inner.streamClosed
  }

  shouldUseSse(): boolean {
    return this.#inner.shouldUseSse()
  }

  withResponseMetadata(update: ResponseMetadataUpdate): PausedState {
    const newInner = this.#inner.withResponseMetadata(update)
    return new PausedState(newInner)
  }

  withSSEControl(event: SSEControlEvent): PausedState {
    const newInner = this.#inner.withSSEControl(event)
    return new PausedState(newInner)
  }

  pause(): PausedState {
    return this
  }

  resume(): { state: LongPollState | SSEState; justResumed: true } {
    return { state: this.#inner, justResumed: true }
  }
}
