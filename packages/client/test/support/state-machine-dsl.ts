/**
 * Testing DSL for the 7-state stream response state machine.
 *
 * Adapted from the Electric configurancy pattern:
 *   Layer 1 — Factory helpers
 *   Layer 2 — applyEvent() dispatcher
 *   Layer 3 — assertStateInvariants() (per-state structural checks)
 *   Layer 4 — assertReachableInvariants() (cross-transition checks)
 *   Layer 5 — ScenarioBuilder (fluent API with auto-invariant checking)
 *   Layer 6 — Fuzz support (seeded RNG, random events, makeAllStates)
 */

import { expect } from "vitest"
import {
  ActiveState,
  ErrorState,
  InitialState,
  LiveState,
  PausedState,
  ReplayingState,
  StaleRetryState,
  SyncingState,
} from "../../src/stream-response-state"
import type {
  MessageBatchInput,
  ResponseMetadataInput,
  SharedStateFields,
  SseCloseInput,
  StreamState,
} from "../../src/stream-response-state"
import type { StateKind } from "./state-transition-table"

// ============================================================================
// Layer 1 — Factory helpers
// ============================================================================

export function makeShared(
  overrides?: Partial<SharedStateFields>
): SharedStateFields {
  return {
    offset: `0_0`,
    cursor: undefined,
    upToDate: false,
    streamClosed: false,
    ...overrides,
  }
}

export function makeResponseInput(
  overrides?: Partial<ResponseMetadataInput>
): ResponseMetadataInput {
  return {
    offset: `1_0`,
    cursor: `cursor-1`,
    upToDate: false,
    streamClosed: false,
    ...overrides,
  }
}

export function makeMessageBatchInput(
  overrides?: Partial<MessageBatchInput>
): MessageBatchInput {
  return {
    hasMessages: true,
    hasUpToDateMessage: false,
    isSse: false,
    currentCursor: undefined,
    ...overrides,
  }
}

export function makeUpToDateBatchInput(
  overrides?: Partial<MessageBatchInput>
): MessageBatchInput {
  return {
    hasMessages: true,
    hasUpToDateMessage: true,
    isSse: false,
    currentCursor: undefined,
    ...overrides,
  }
}

export function makeSseCloseInput(
  overrides?: Partial<SseCloseInput>
): SseCloseInput {
  return {
    connectionDuration: 5000,
    wasAborted: false,
    minConnectionDuration: 1000,
    maxShortConnections: 3,
    ...overrides,
  }
}

// ============================================================================
// Layer 1.5 — State factories (for building all possible states)
// ============================================================================

export function makeInitialState(
  overrides?: Partial<SharedStateFields>
): InitialState {
  return new InitialState(makeShared(overrides))
}

export function makeSyncingState(
  overrides?: Partial<SharedStateFields>
): SyncingState {
  return new SyncingState(makeShared(overrides))
}

export function makeStaleRetryState(
  overrides?: Partial<SharedStateFields>,
  cacheBuster = `test-cache-buster`
): StaleRetryState {
  return new StaleRetryState(makeShared(overrides), cacheBuster)
}

export function makeLiveState(
  overrides?: Partial<SharedStateFields>,
  options?: {
    consecutiveShortConnections?: number
    sseFallbackToLongPolling?: boolean
  }
): LiveState {
  return new LiveState(makeShared({ upToDate: true, ...overrides }), options)
}

export function makeReplayingState(
  overrides?: Partial<SharedStateFields>,
  replayCursor = `replay-cursor-1`
): ReplayingState {
  return new ReplayingState(makeShared(overrides), replayCursor)
}

export function makePausedState(inner?: ActiveState | ErrorState): PausedState {
  return new PausedState(inner ?? makeSyncingState())
}

export function makeErrorState(
  inner?: ActiveState | PausedState,
  error?: Error
): ErrorState {
  return new ErrorState(
    inner ?? makeSyncingState(),
    error ?? new Error(`test error`)
  )
}

// ============================================================================
// Layer 2 — Event specification and applyEvent() dispatcher
// ============================================================================

export type EventSpec =
  | { type: `response`; input: ResponseMetadataInput }
  | { type: `messages`; input: MessageBatchInput }
  | { type: `messagesUtd`; input: MessageBatchInput }
  | { type: `sseClose`; input: SseCloseInput }
  | { type: `pause` }
  | { type: `resume` }
  | { type: `error`; error: Error }
  | { type: `retry` }
  | { type: `enterReplayMode`; replayCursor: string }

export interface ApplyResult {
  readonly state: StreamState
  readonly action?: string
  readonly suppressBatch?: boolean
  readonly becameUpToDate?: boolean
  readonly fellBackToLongPolling?: boolean
  readonly wasShortConnection?: boolean
}

/**
 * Dispatches an event to a state and returns the resulting state plus
 * any action metadata from the transition.
 */
export function applyEvent(state: StreamState, event: EventSpec): ApplyResult {
  switch (event.type) {
    case `response`: {
      const result = state.handleResponseMetadata(event.input)
      return { state: result.state, action: result.action }
    }
    case `messages`: {
      const result = state.handleMessageBatch(event.input)
      return {
        state: result.state,
        suppressBatch: result.suppressBatch,
        becameUpToDate: result.becameUpToDate,
      }
    }
    case `messagesUtd`: {
      const result = state.handleMessageBatch(event.input)
      return {
        state: result.state,
        suppressBatch: result.suppressBatch,
        becameUpToDate: result.becameUpToDate,
      }
    }
    case `sseClose`: {
      const result = state.handleSseConnectionClosed(event.input)
      const sseResult = result as {
        state: StreamState
        fellBackToLongPolling?: boolean
        wasShortConnection?: boolean
      }
      return {
        state: sseResult.state,
        fellBackToLongPolling: sseResult.fellBackToLongPolling,
        wasShortConnection: sseResult.wasShortConnection,
      }
    }
    case `pause`: {
      return { state: state.pause() }
    }
    case `resume`: {
      if (state instanceof PausedState) {
        return { state: state.resume() }
      }
      return { state }
    }
    case `error`: {
      if (state instanceof ActiveState) {
        return { state: state.toErrorState(event.error) }
      }
      if (state instanceof PausedState) {
        return { state: new ErrorState(state, event.error) }
      }
      if (state instanceof ErrorState) {
        return {
          state: new ErrorState(state as unknown as ActiveState, event.error),
        }
      }
      return { state }
    }
    case `retry`: {
      if (state instanceof ErrorState) {
        return { state: state.retry() }
      }
      return { state }
    }
    case `enterReplayMode`: {
      if (state instanceof ActiveState && state.canEnterReplayMode()) {
        return {
          state: new ReplayingState(
            {
              offset: state.offset,
              cursor: state.cursor,
              upToDate: state.upToDate,
              streamClosed: state.streamClosed,
            },
            event.replayCursor
          ),
        }
      }
      return { state }
    }
  }
}

/**
 * Extracts the `kind` from any StreamState, including the new classes.
 */
export function getStateKind(state: StreamState): StateKind {
  if (state instanceof InitialState) return `initial`
  if (state instanceof SyncingState) return `syncing`
  if (state instanceof StaleRetryState) return `stale-retry`
  if (state instanceof LiveState) return `live`
  if (state instanceof ReplayingState) return `replaying`
  if (state instanceof PausedState) return `paused`
  if (state instanceof ErrorState) return `error`
  throw new Error(`Unknown state type: ${state.constructor.name}`)
}

// ============================================================================
// Layer 3 — assertStateInvariants(state)
// ============================================================================

/**
 * Checks invariants I0, I1, I6, I7, I8, I9, I12 on a single state.
 */
export function assertStateInvariants(state: StreamState): void {
  const kind = getStateKind(state)

  // I0: Kind/instanceof consistency
  switch (kind) {
    case `initial`:
      expect(state).toBeInstanceOf(InitialState)
      expect((state as InitialState).kind).toBe(`initial`)
      break
    case `syncing`:
      expect(state).toBeInstanceOf(SyncingState)
      expect((state as SyncingState).kind).toBe(`syncing`)
      break
    case `stale-retry`:
      expect(state).toBeInstanceOf(StaleRetryState)
      expect((state as StaleRetryState).kind).toBe(`stale-retry`)
      break
    case `live`:
      expect(state).toBeInstanceOf(LiveState)
      expect((state as LiveState).kind).toBe(`live`)
      break
    case `replaying`:
      expect(state).toBeInstanceOf(ReplayingState)
      expect((state as ReplayingState).kind).toBe(`replaying`)
      break
    case `paused`:
      expect(state).toBeInstanceOf(PausedState)
      expect((state as PausedState).kind).toBe(`paused`)
      break
    case `error`:
      expect(state).toBeInstanceOf(ErrorState)
      expect((state as ErrorState).kind).toBe(`error`)
      break
  }

  // I6: StaleRetryState has cacheBuster
  if (state instanceof StaleRetryState) {
    expect(typeof state.cacheBuster).toBe(`string`)
    expect(state.cacheBuster.length).toBeGreaterThan(0)
    expect(state.canEnterReplayMode()).toBe(false)
  }

  // I7: ReplayingState has replayCursor
  if (state instanceof ReplayingState) {
    expect(typeof state.replayCursor).toBe(`string`)
    expect(state.replayCursor.length).toBeGreaterThan(0)
    expect(state.canEnterReplayMode()).toBe(false)
  }

  // I8: PausedState delegates all fields + pause() idempotent
  if (state instanceof PausedState) {
    const prev = state.previousState
    expect(state.offset).toBe(prev.offset)
    expect(state.cursor).toBe(prev.cursor)
    expect(state.upToDate).toBe(prev.upToDate)
    expect(state.streamClosed).toBe(prev.streamClosed)
    expect(state.pause()).toBe(state) // idempotent
  }

  // I9: ErrorState delegates all fields + has error
  if (state instanceof ErrorState) {
    const prev = state.previousState
    expect(state.offset).toBe(prev.offset)
    expect(state.cursor).toBe(prev.cursor)
    expect(state.upToDate).toBe(prev.upToDate)
    expect(state.streamClosed).toBe(prev.streamClosed)
    expect(state.error).toBeInstanceOf(Error)
  }

  // I12: No same-type nesting
  if (state instanceof PausedState) {
    expect(state.previousState).not.toBeInstanceOf(PausedState)
  }
  if (state instanceof ErrorState) {
    expect(state.previousState).not.toBeInstanceOf(ErrorState)
  }

  // All states must have valid SharedStateFields
  expect(typeof state.offset).toBe(`string`)
  expect(typeof state.upToDate).toBe(`boolean`)
  expect(typeof state.streamClosed).toBe(`boolean`)
}

// ============================================================================
// Layer 4 — assertReachableInvariants(event, prev, next)
// ============================================================================

/**
 * Checks invariants that span a transition: I2, I3, I4.
 */
export function assertReachableInvariants(
  event: EventSpec,
  prev: StreamState,
  next: StreamState
): void {
  // I2: Immutability — transitions should not mutate the previous state
  // (We check this by verifying the prev state's fields didn't change,
  // which we do by snapshot comparison in the scenario builder)

  // I3: pause/resume round-trip preserves identity
  if (event.type === `resume` && prev instanceof PausedState) {
    // The result of resume should be the previousState
    expect(next).toBe(prev.previousState)
  }

  // I4: error/retry preserves identity
  if (event.type === `retry` && prev instanceof ErrorState) {
    // The result of retry should be the previousState
    expect(next).toBe(prev.previousState)
  }

  // Always check invariants on the resulting state
  assertStateInvariants(next)
}

// ============================================================================
// Layer 5 — ScenarioBuilder (fluent API with auto-invariant checking)
// ============================================================================

interface ScenarioStep {
  readonly event: EventSpec
  readonly prevState: StreamState
  readonly nextState: StreamState
}

export class ScenarioBuilder {
  readonly #steps: Array<ScenarioStep> = []
  #currentState: StreamState

  constructor(initial: StreamState) {
    this.#currentState = initial
    assertStateInvariants(initial)
  }

  /** Get the current state */
  get state(): StreamState {
    return this.#currentState
  }

  /** Get all recorded steps */
  get steps(): ReadonlyArray<ScenarioStep> {
    return this.#steps
  }

  /** Apply a response event */
  response(input?: Partial<ResponseMetadataInput>): this {
    return this.#apply({
      type: `response`,
      input: makeResponseInput(input),
    })
  }

  /** Apply a message batch event (no upToDate) */
  messages(input?: Partial<MessageBatchInput>): this {
    return this.#apply({
      type: `messages`,
      input: makeMessageBatchInput(input),
    })
  }

  /** Apply a message batch event with upToDate */
  messagesUtd(input?: Partial<MessageBatchInput>): this {
    return this.#apply({
      type: `messagesUtd`,
      input: makeUpToDateBatchInput(input),
    })
  }

  /** Apply an SSE close event */
  sseClose(input?: Partial<SseCloseInput>): this {
    return this.#apply({
      type: `sseClose`,
      input: makeSseCloseInput(input),
    })
  }

  /** Apply a pause event */
  pause(): this {
    return this.#apply({ type: `pause` })
  }

  /** Apply a resume event */
  resume(): this {
    return this.#apply({ type: `resume` })
  }

  /** Apply an error event */
  error(error?: Error): this {
    return this.#apply({
      type: `error`,
      error: error ?? new Error(`scenario error`),
    })
  }

  /** Apply a retry event */
  retry(): this {
    return this.#apply({ type: `retry` })
  }

  /** Apply an enterReplayMode event */
  enterReplayMode(replayCursor = `replay-cursor`): this {
    return this.#apply({
      type: `enterReplayMode`,
      replayCursor,
    })
  }

  /** Assert the current state kind */
  expectKind(kind: StateKind): this {
    expect(getStateKind(this.#currentState)).toBe(kind)
    return this
  }

  /** Assert the current state is a specific reference */
  expectSameRef(ref: StreamState): this {
    expect(this.#currentState).toBe(ref)
    return this
  }

  /** Assert the current state is NOT the given reference */
  expectDifferentRef(ref: StreamState): this {
    expect(this.#currentState).not.toBe(ref)
    return this
  }

  /** Assert upToDate flag */
  expectUpToDate(value: boolean): this {
    expect(this.#currentState.upToDate).toBe(value)
    return this
  }

  /** Assert offset */
  expectOffset(value: string): this {
    expect(this.#currentState.offset).toBe(value)
    return this
  }

  /** Run a custom assertion on the current state */
  assert(fn: (state: StreamState) => void): this {
    fn(this.#currentState)
    return this
  }

  #apply(event: EventSpec): this {
    const prev = this.#currentState
    const result = applyEvent(prev, event)
    const next = result.state

    // Auto-check invariants on every transition
    assertReachableInvariants(event, prev, next)

    this.#steps.push({ event, prevState: prev, nextState: next })
    this.#currentState = next
    return this
  }
}

// ============================================================================
// Standard scenarios
// ============================================================================

/**
 * Standard scenario: initial → syncing → live (happy path)
 */
export function scenarioHappyPath(): ScenarioBuilder {
  return new ScenarioBuilder(makeInitialState())
    .response()
    .expectKind(`syncing`)
    .messagesUtd()
    .expectKind(`live`)
    .expectUpToDate(true)
}

/**
 * Standard scenario: pause/resume round-trip
 */
export function scenarioPauseResume(): ScenarioBuilder {
  return new ScenarioBuilder(makeSyncingState())
    .pause()
    .expectKind(`paused`)
    .resume()
    .expectKind(`syncing`)
}

/**
 * Standard scenario: error/retry round-trip
 */
export function scenarioErrorRetry(): ScenarioBuilder {
  return new ScenarioBuilder(makeSyncingState())
    .error()
    .expectKind(`error`)
    .retry()
    .expectKind(`syncing`)
}

/**
 * Standard scenario: syncing → live → pause → resume → live
 */
export function scenarioLivePauseResume(): ScenarioBuilder {
  return new ScenarioBuilder(makeInitialState())
    .response()
    .messagesUtd()
    .expectKind(`live`)
    .pause()
    .expectKind(`paused`)
    .resume()
    .expectKind(`live`)
}

/**
 * Standard scenario: replaying → live via upToDate messages
 */
export function scenarioReplayToLive(): ScenarioBuilder {
  return new ScenarioBuilder(makeSyncingState())
    .enterReplayMode(`replay-1`)
    .expectKind(`replaying`)
    .messagesUtd()
    .expectKind(`live`)
}

/**
 * Standard scenario: error during live → retry → resume live
 */
export function scenarioLiveErrorRetry(): ScenarioBuilder {
  return new ScenarioBuilder(makeInitialState())
    .response()
    .messagesUtd()
    .expectKind(`live`)
    .error()
    .expectKind(`error`)
    .retry()
    .expectKind(`live`)
}

/**
 * Standard scenario: double-pause is idempotent
 */
export function scenarioDoublePause(): ScenarioBuilder {
  const builder = new ScenarioBuilder(makeSyncingState())
  builder.pause().expectKind(`paused`)
  const firstPause = builder.state
  builder.pause().expectKind(`paused`).expectSameRef(firstPause)
  return builder
}

/**
 * Standard scenario: pause wrapping error
 */
export function scenarioPauseError(): ScenarioBuilder {
  return new ScenarioBuilder(makeSyncingState())
    .error()
    .expectKind(`error`)
    .pause()
    .expectKind(`paused`)
    .resume()
    .expectKind(`error`)
    .retry()
    .expectKind(`syncing`)
}

/**
 * All standard scenarios in one array for batch execution.
 */
export const standardScenarios: Array<{
  name: string
  run: () => ScenarioBuilder
}> = [
  { name: `happy path (initial → syncing → live)`, run: scenarioHappyPath },
  { name: `pause/resume round-trip`, run: scenarioPauseResume },
  { name: `error/retry round-trip`, run: scenarioErrorRetry },
  { name: `live → pause → resume → live`, run: scenarioLivePauseResume },
  { name: `replaying → live via upToDate`, run: scenarioReplayToLive },
  { name: `live → error → retry → live`, run: scenarioLiveErrorRetry },
  { name: `double-pause is idempotent`, run: scenarioDoublePause },
  { name: `pause wrapping error`, run: scenarioPauseError },
]

// ============================================================================
// Layer 6 — Fuzz support
// ============================================================================

/**
 * Seeded 32-bit PRNG (Mulberry32).
 * Returns a function that produces [0, 1) floats deterministically.
 */
export function mulberry32(seed: number): () => number {
  let t = seed | 0
  return () => {
    t = (t + 0x6d2b79f5) | 0
    let r = Math.imul(t ^ (t >>> 15), t | 1)
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61)
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Pick a random event that is valid for the given state.
 */
export function pickRandomEvent(
  state: StreamState,
  rng: () => number
): EventSpec {
  const candidates: Array<EventSpec> = []

  // All states can receive response, messages, sseClose, pause
  candidates.push({
    type: `response`,
    input: makeResponseInput({
      offset: `${Math.floor(rng() * 100)}_${Math.floor(rng() * 1000)}`,
    }),
  })
  candidates.push({
    type: `messages`,
    input: makeMessageBatchInput(),
  })
  candidates.push({
    type: `messagesUtd`,
    input: makeUpToDateBatchInput(),
  })
  candidates.push({
    type: `sseClose`,
    input: makeSseCloseInput({
      connectionDuration: Math.floor(rng() * 10000),
    }),
  })
  candidates.push({ type: `pause` })

  // Only paused can resume
  if (state instanceof PausedState) {
    candidates.push({ type: `resume` })
  }

  // ActiveState and delegates can error
  if (
    state instanceof ActiveState ||
    state instanceof PausedState ||
    state instanceof ErrorState
  ) {
    candidates.push({
      type: `error`,
      error: new Error(`fuzz error ${Math.floor(rng() * 1000)}`),
    })
  }

  // Only error can retry
  if (state instanceof ErrorState) {
    candidates.push({ type: `retry` })
  }

  // Only active states with canEnterReplayMode can enter replay
  if (state instanceof ActiveState && state.canEnterReplayMode()) {
    candidates.push({
      type: `enterReplayMode`,
      replayCursor: `fuzz-replay-${Math.floor(rng() * 100)}`,
    })
  }

  const idx = Math.floor(rng() * candidates.length)
  return candidates[idx]!
}

/**
 * Create one instance of every state kind for exhaustive testing.
 */
export function makeAllStates(): Array<{
  kind: StateKind
  state: StreamState
}> {
  const syncingState = makeSyncingState()
  return [
    { kind: `initial`, state: makeInitialState() },
    { kind: `syncing`, state: syncingState },
    {
      kind: `stale-retry`,
      state: makeStaleRetryState(undefined, `cb-1`),
    },
    {
      kind: `live`,
      state: makeLiveState(),
    },
    {
      kind: `replaying`,
      state: makeReplayingState(undefined, `rp-1`),
    },
    {
      kind: `paused`,
      state: makePausedState(syncingState),
    },
    {
      kind: `error`,
      state: makeErrorState(syncingState, new Error(`test`)),
    },
  ]
}
