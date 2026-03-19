/**
 * 7-State stream response state machine.
 *
 * Every transition returns a new state — no mutation.
 *
 * Hierarchy:
 *   StreamState (abstract)
 *   ├── ActiveState (abstract)
 *   │   ├── FetchingState (abstract)
 *   │   │   ├── InitialState
 *   │   │   ├── SyncingState
 *   │   │   └── StaleRetryState
 *   │   ├── LiveState
 *   │   └── ReplayingState
 *   ├── PausedState
 *   └── ErrorState
 */

import {
  CACHE_BUSTER_QUERY_PARAM,
  CURSOR_QUERY_PARAM,
  LIVE_QUERY_PARAM,
  OFFSET_QUERY_PARAM,
} from "./constants"
import type { LiveMode, Offset } from "./types"

// --- State Kind ---

export type StreamStateKind =
  | `initial`
  | `syncing`
  | `stale-retry`
  | `live`
  | `replaying`
  | `paused`
  | `error`

// --- Shared Fields ---

export interface SharedStateFields {
  readonly offset: Offset
  readonly cursor: string | undefined
  readonly upToDate: boolean
  readonly streamClosed: boolean
}

// --- Input Types ---

export interface ResponseMetadataInput {
  readonly offset?: string
  readonly cursor?: string
  readonly upToDate: boolean
  readonly streamClosed: boolean
}

export interface MessageBatchInput {
  readonly hasMessages: boolean
  readonly hasUpToDateMessage: boolean
  readonly isSse: boolean
  readonly currentCursor?: string
}

export interface SseCloseInput {
  readonly connectionDuration: number
  readonly wasAborted: boolean
  readonly minConnectionDuration: number
  readonly maxShortConnections: number
}

// --- Transition Types ---

export type ResponseTransition =
  | { readonly action: `accepted`; readonly state: ActiveState }
  | { readonly action: `ignored`; readonly state: StreamState }

export type MessageBatchTransition =
  | {
      readonly state: ActiveState
      readonly suppressBatch: boolean
      readonly becameUpToDate: boolean
    }
  | {
      readonly state: StreamState
      readonly suppressBatch: false
      readonly becameUpToDate: false
    }

export type SseCloseTransition =
  | {
      readonly state: LiveState
      readonly fellBackToLongPolling: boolean
      readonly wasShortConnection: boolean
    }
  | { readonly state: StreamState }

// --- Abstract Base: StreamState ---

export abstract class StreamState implements SharedStateFields {
  abstract readonly kind: StreamStateKind
  abstract readonly offset: Offset
  abstract readonly cursor: string | undefined
  abstract readonly upToDate: boolean
  abstract readonly streamClosed: boolean

  abstract handleResponseMetadata(
    input: ResponseMetadataInput
  ): ResponseTransition
  abstract handleMessageBatch(input: MessageBatchInput): MessageBatchTransition
  abstract handleSseConnectionClosed(input: SseCloseInput): SseCloseTransition
  abstract pause(): StreamState
  abstract shouldUseSse(opts?: {
    liveSseEnabled: boolean
    resumingFromPause: boolean
  }): boolean
}

// --- Abstract Base: ActiveState ---

export abstract class ActiveState extends StreamState {
  readonly offset: Offset
  readonly cursor: string | undefined
  readonly upToDate: boolean
  readonly streamClosed: boolean

  constructor(fields: SharedStateFields) {
    super()
    this.offset = fields.offset
    this.cursor = fields.cursor
    this.upToDate = fields.upToDate
    this.streamClosed = fields.streamClosed
  }

  pause(): PausedState {
    return new PausedState(this)
  }

  toErrorState(error: Error): ErrorState {
    return new ErrorState(this, error)
  }

  shouldContinueLive(stopAfterUpToDate: boolean, liveMode: LiveMode): boolean {
    if (stopAfterUpToDate && this.upToDate) return false
    if (liveMode === false) return false
    if (this.streamClosed) return false
    return true
  }

  shouldUseSse(): boolean {
    return false
  }

  canEnterReplayMode(): boolean {
    return true
  }

  applyUrlParams(url: URL): void {
    url.searchParams.set(OFFSET_QUERY_PARAM, this.offset)
    if (this.cursor !== undefined) {
      url.searchParams.set(CURSOR_QUERY_PARAM, this.cursor)
    }
  }

  handleResponseMetadata(input: ResponseMetadataInput): ResponseTransition {
    const shared: SharedStateFields = {
      offset: input.offset ?? this.offset,
      cursor: input.cursor ?? this.cursor,
      upToDate: input.upToDate,
      streamClosed: this.streamClosed || input.streamClosed,
    }
    const syncing = new SyncingState(shared)
    return { action: `accepted`, state: syncing }
  }

  handleMessageBatch(_input: MessageBatchInput): MessageBatchTransition {
    return {
      state: this,
      suppressBatch: false,
      becameUpToDate: false,
    }
  }

  handleSseConnectionClosed(_input: SseCloseInput): SseCloseTransition {
    return { state: this }
  }
}

// --- Abstract: FetchingState ---

export abstract class FetchingState extends ActiveState {
  shouldUseSse(): boolean {
    return false
  }

  handleResponseMetadata(input: ResponseMetadataInput): ResponseTransition {
    const shared: SharedStateFields = {
      offset: input.offset ?? this.offset,
      cursor: input.cursor ?? this.cursor,
      upToDate: input.upToDate,
      streamClosed: this.streamClosed || input.streamClosed,
    }
    const syncing = new SyncingState(shared)
    return { action: `accepted`, state: syncing }
  }
}

// --- InitialState ---

export class InitialState extends FetchingState {
  readonly kind = `initial` as const
}

// --- SyncingState ---

export class SyncingState extends FetchingState {
  readonly kind = `syncing` as const

  handleMessageBatch(input: MessageBatchInput): MessageBatchTransition {
    if (input.hasUpToDateMessage) {
      const shared: SharedStateFields = {
        offset: this.offset,
        cursor: this.cursor,
        upToDate: true,
        streamClosed: this.streamClosed,
      }
      const live = new LiveState(shared)
      return {
        state: live,
        suppressBatch: false,
        becameUpToDate: true,
      }
    }
    return {
      state: this,
      suppressBatch: false,
      becameUpToDate: false,
    }
  }
}

// --- StaleRetryState ---

export class StaleRetryState extends FetchingState {
  readonly kind = `stale-retry` as const
  readonly #cacheBuster: string

  constructor(fields: SharedStateFields, cacheBuster: string) {
    super(fields)
    this.#cacheBuster = cacheBuster
  }

  get cacheBuster(): string {
    return this.#cacheBuster
  }

  canEnterReplayMode(): boolean {
    return false
  }

  applyUrlParams(url: URL): void {
    super.applyUrlParams(url)
    url.searchParams.set(CACHE_BUSTER_QUERY_PARAM, this.#cacheBuster)
  }
}

// --- LiveState ---

export class LiveState extends ActiveState {
  readonly kind = `live` as const
  readonly #consecutiveShortConnections: number
  readonly #sseFallbackToLongPolling: boolean

  constructor(
    fields: SharedStateFields,
    options?: {
      consecutiveShortConnections?: number
      sseFallbackToLongPolling?: boolean
    }
  ) {
    super(fields)
    this.#consecutiveShortConnections =
      options?.consecutiveShortConnections ?? 0
    this.#sseFallbackToLongPolling = options?.sseFallbackToLongPolling ?? false
  }

  get consecutiveShortConnections(): number {
    return this.#consecutiveShortConnections
  }

  get sseFallbackToLongPolling(): boolean {
    return this.#sseFallbackToLongPolling
  }

  shouldUseSse(opts?: {
    liveSseEnabled: boolean
    resumingFromPause: boolean
  }): boolean {
    if (!opts) return false
    return (
      opts.liveSseEnabled &&
      !opts.resumingFromPause &&
      !this.#sseFallbackToLongPolling
    )
  }

  canEnterReplayMode(): boolean {
    return true
  }

  applyUrlParams(url: URL): void {
    super.applyUrlParams(url)
    if (this.#sseFallbackToLongPolling) {
      url.searchParams.set(LIVE_QUERY_PARAM, `long-poll`)
    } else {
      url.searchParams.set(LIVE_QUERY_PARAM, `true`)
    }
  }

  handleResponseMetadata(input: ResponseMetadataInput): ResponseTransition {
    const shared: SharedStateFields = {
      offset: input.offset ?? this.offset,
      cursor: input.cursor ?? this.cursor,
      upToDate: input.upToDate,
      streamClosed: this.streamClosed || input.streamClosed,
    }
    const live = new LiveState(shared, {
      consecutiveShortConnections: this.#consecutiveShortConnections,
      sseFallbackToLongPolling: this.#sseFallbackToLongPolling,
    })
    return { action: `accepted`, state: live }
  }

  handleMessageBatch(_input: MessageBatchInput): MessageBatchTransition {
    const shared: SharedStateFields = {
      offset: this.offset,
      cursor: this.cursor,
      upToDate: this.upToDate,
      streamClosed: this.streamClosed,
    }
    const live = new LiveState(shared, {
      consecutiveShortConnections: this.#consecutiveShortConnections,
      sseFallbackToLongPolling: this.#sseFallbackToLongPolling,
    })
    return {
      state: live,
      suppressBatch: false,
      becameUpToDate: false,
    }
  }

  handleSseConnectionClosed(input: SseCloseInput): SseCloseTransition {
    const {
      connectionDuration,
      wasAborted,
      minConnectionDuration,
      maxShortConnections,
    } = input

    if (connectionDuration < minConnectionDuration && !wasAborted) {
      const newCount = this.#consecutiveShortConnections + 1

      if (newCount >= maxShortConnections) {
        const live = new LiveState(
          {
            offset: this.offset,
            cursor: this.cursor,
            upToDate: this.upToDate,
            streamClosed: this.streamClosed,
          },
          {
            consecutiveShortConnections: newCount,
            sseFallbackToLongPolling: true,
          }
        )
        return {
          state: live,
          fellBackToLongPolling: true,
          wasShortConnection: true,
        }
      }

      const live = new LiveState(
        {
          offset: this.offset,
          cursor: this.cursor,
          upToDate: this.upToDate,
          streamClosed: this.streamClosed,
        },
        {
          consecutiveShortConnections: newCount,
          sseFallbackToLongPolling: false,
        }
      )
      return {
        state: live,
        fellBackToLongPolling: false,
        wasShortConnection: true,
      }
    }

    if (connectionDuration >= minConnectionDuration) {
      const live = new LiveState(
        {
          offset: this.offset,
          cursor: this.cursor,
          upToDate: this.upToDate,
          streamClosed: this.streamClosed,
        },
        {
          consecutiveShortConnections: 0,
          sseFallbackToLongPolling: this.#sseFallbackToLongPolling,
        }
      )
      return {
        state: live,
        fellBackToLongPolling: false,
        wasShortConnection: false,
      }
    }

    return {
      state: this,
      fellBackToLongPolling: false,
      wasShortConnection: false,
    }
  }
}

// --- ReplayingState ---

export class ReplayingState extends ActiveState {
  readonly kind = `replaying` as const
  readonly #replayCursor: string

  constructor(fields: SharedStateFields, replayCursor: string) {
    super(fields)
    this.#replayCursor = replayCursor
  }

  get replayCursor(): string {
    return this.#replayCursor
  }

  canEnterReplayMode(): boolean {
    return false
  }

  handleResponseMetadata(input: ResponseMetadataInput): ResponseTransition {
    return {
      action: `accepted`,
      state: new ReplayingState(
        {
          offset: input.offset ?? this.offset,
          cursor: input.cursor ?? this.cursor,
          upToDate: input.upToDate,
          streamClosed: this.streamClosed || input.streamClosed,
        },
        this.#replayCursor
      ),
    }
  }

  handleMessageBatch(input: MessageBatchInput): MessageBatchTransition {
    if (input.hasUpToDateMessage) {
      const cursorMatch =
        input.currentCursor !== undefined &&
        input.currentCursor === this.#replayCursor
      const suppress = cursorMatch && !input.isSse

      const shared: SharedStateFields = {
        offset: this.offset,
        cursor: this.cursor,
        upToDate: true,
        streamClosed: this.streamClosed,
      }
      const live = new LiveState(shared)
      return {
        state: live,
        suppressBatch: suppress,
        becameUpToDate: true,
      }
    }
    return {
      state: this,
      suppressBatch: false,
      becameUpToDate: false,
    }
  }
}

// --- PausedState ---

export class PausedState extends StreamState {
  readonly kind = `paused` as const
  readonly #previousState: ActiveState | ErrorState

  constructor(previousState: ActiveState | ErrorState) {
    super()
    if (previousState instanceof PausedState) {
      this.#previousState = previousState.#previousState
    } else {
      this.#previousState = previousState
    }
  }

  get previousState(): ActiveState | ErrorState {
    return this.#previousState
  }

  get offset(): Offset {
    return this.#previousState.offset
  }

  get cursor(): string | undefined {
    return this.#previousState.cursor
  }

  get upToDate(): boolean {
    return this.#previousState.upToDate
  }

  get streamClosed(): boolean {
    return this.#previousState.streamClosed
  }

  pause(): PausedState {
    return this
  }

  resume(): ActiveState | ErrorState {
    return this.#previousState
  }

  shouldUseSse(opts?: {
    liveSseEnabled: boolean
    resumingFromPause: boolean
  }): boolean {
    return this.#previousState.shouldUseSse(opts)
  }

  handleResponseMetadata(input: ResponseMetadataInput): ResponseTransition {
    const inner = this.#previousState.handleResponseMetadata(input)
    if (inner.action === `accepted`) {
      return {
        action: `accepted`,
        state: new PausedState(inner.state) as unknown as ActiveState,
      }
    }
    return { action: `ignored`, state: this }
  }

  handleMessageBatch(_input: MessageBatchInput): MessageBatchTransition {
    return { state: this, suppressBatch: false, becameUpToDate: false }
  }

  handleSseConnectionClosed(_input: SseCloseInput): SseCloseTransition {
    return { state: this }
  }
}

// --- ErrorState ---

export class ErrorState extends StreamState {
  readonly kind = `error` as const
  readonly #previousState: ActiveState | PausedState
  readonly error: Error

  constructor(previousState: ActiveState | PausedState, error: Error) {
    super()
    if (previousState instanceof ErrorState) {
      this.#previousState = previousState.#previousState
    } else {
      this.#previousState = previousState
    }
    this.error = error
  }

  get previousState(): ActiveState | PausedState {
    return this.#previousState
  }

  get offset(): Offset {
    return this.#previousState.offset
  }

  get cursor(): string | undefined {
    return this.#previousState.cursor
  }

  get upToDate(): boolean {
    return this.#previousState.upToDate
  }

  get streamClosed(): boolean {
    return this.#previousState.streamClosed
  }

  retry(): ActiveState | PausedState {
    return this.#previousState
  }

  pause(): PausedState {
    return new PausedState(this)
  }

  shouldUseSse(opts?: {
    liveSseEnabled: boolean
    resumingFromPause: boolean
  }): boolean {
    return this.#previousState.shouldUseSse(opts)
  }

  handleResponseMetadata(_input: ResponseMetadataInput): ResponseTransition {
    return { action: `ignored`, state: this }
  }

  handleMessageBatch(_input: MessageBatchInput): MessageBatchTransition {
    return { state: this, suppressBatch: false, becameUpToDate: false }
  }

  handleSseConnectionClosed(_input: SseCloseInput): SseCloseTransition {
    return { state: this }
  }
}

// --- Factory Functions ---

export function createInitialState(opts: { offset: Offset }): InitialState {
  return new InitialState({
    offset: opts.offset,
    cursor: undefined,
    upToDate: false,
    streamClosed: false,
  })
}

export function createCacheBuster(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}
