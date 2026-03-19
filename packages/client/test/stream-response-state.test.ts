/**
 * State machine tests for the 7-state stream response state machine.
 *
 * Five-tier structure:
 *   Tier 1 — Scenario builder tests (standard + custom)
 *   Tier 2 — Truth table tests (exhaustive transition verification)
 *   Tier 3 — Algebraic property tests
 *   Tier 4 — Fuzz tests
 *   Tier 5 — Dedicated tests (SSE fallback, shouldUseSse, applyUrlParams, etc.)
 */

import { describe, expect, it } from "vitest"
import {
  ActiveState,
  ErrorState,
  FetchingState,
  InitialState,
  LiveState,
  PausedState,
  StreamState,
  createInitialState,
} from "../src/stream-response-state"
import { TRANSITION_TABLE } from "./support/state-transition-table"
import {
  ScenarioBuilder,
  applyEvent,
  assertStateInvariants,
  getStateKind,
  makeAllStates,
  makeErrorState,
  makeInitialState,
  makeLiveState,
  makeMessageBatchInput,
  makePausedState,
  makeReplayingState,
  makeResponseInput,
  makeSseCloseInput,
  makeStaleRetryState,
  makeSyncingState,
  makeUpToDateBatchInput,
  mulberry32,
  pickRandomEvent,
  standardScenarios,
} from "./support/state-machine-dsl"
import type { EventType, StateKind } from "./support/state-transition-table"
import type { EventSpec } from "./support/state-machine-dsl"

// ============================================================================
// Tier 1 — Scenario builder tests
// ============================================================================

describe(`Tier 1: Scenario builder tests`, () => {
  describe(`standard scenarios`, () => {
    for (const { name, run } of standardScenarios) {
      it(name, () => {
        run()
      })
    }
  })

  describe(`custom scenarios`, () => {
    it(`initial → response → messages (no utd) → messages (utd) → live`, () => {
      new ScenarioBuilder(makeInitialState())
        .response()
        .expectKind(`syncing`)
        .messages()
        .expectKind(`syncing`)
        .messagesUtd()
        .expectKind(`live`)
        .expectUpToDate(true)
    })

    it(`stale-retry → response → syncing → live`, () => {
      new ScenarioBuilder(makeStaleRetryState())
        .response()
        .expectKind(`syncing`)
        .messagesUtd()
        .expectKind(`live`)
    })

    it(`live → error → pause → resume (error) → retry → live`, () => {
      new ScenarioBuilder(makeLiveState())
        .error()
        .expectKind(`error`)
        .pause()
        .expectKind(`paused`)
        .resume()
        .expectKind(`error`)
        .retry()
        .expectKind(`live`)
    })

    it(`replaying → response → replaying (stays in replay until upToDate)`, () => {
      new ScenarioBuilder(makeReplayingState())
        .response()
        .expectKind(`replaying`)
    })

    it(`error state ignores response, messages, sseClose`, () => {
      const builder = new ScenarioBuilder(makeErrorState())
      const errorRef = builder.state
      builder
        .response()
        .expectSameRef(errorRef)
        .messages()
        .expectSameRef(errorRef)
        .sseClose()
        .expectSameRef(errorRef)
    })

    it(`paused state ignores messages and sseClose`, () => {
      const builder = new ScenarioBuilder(makePausedState())
      const pausedRef = builder.state
      builder
        .messages()
        .expectSameRef(pausedRef)
        .sseClose()
        .expectSameRef(pausedRef)
    })

    it(`paused state forwards response to inner state`, () => {
      new ScenarioBuilder(makePausedState(makeSyncingState()))
        .response({ offset: `5_0` })
        .expectKind(`paused`)
        .expectOffset(`5_0`)
    })

    it(`createInitialState factory`, () => {
      const state = createInitialState({ offset: `-1` })
      expect(state).toBeInstanceOf(InitialState)
      expect(state.offset).toBe(`-1`)
      expect(state.cursor).toBeUndefined()
      expect(state.upToDate).toBe(false)
      expect(state.streamClosed).toBe(false)
      assertStateInvariants(state)
    })
  })
})

// ============================================================================
// Tier 2 — Truth table tests
// ============================================================================

describe(`Tier 2: Truth table exhaustive tests`, () => {
  /**
   * Build a state from a kind for truth table testing.
   */
  function stateForKind(kind: StateKind): StreamState {
    switch (kind) {
      case `initial`:
        return makeInitialState()
      case `syncing`:
        return makeSyncingState()
      case `stale-retry`:
        return makeStaleRetryState()
      case `live`:
        return makeLiveState()
      case `replaying`:
        return makeReplayingState()
      case `paused`:
        return makePausedState(makeSyncingState())
      case `error`:
        return makeErrorState(makeSyncingState())
    }
  }

  /**
   * Build an EventSpec from an EventType.
   */
  function eventForType(type: EventType): EventSpec {
    switch (type) {
      case `response`:
        return { type: `response`, input: makeResponseInput() }
      case `messages`:
        return { type: `messages`, input: makeMessageBatchInput() }
      case `messagesUtd`:
        return {
          type: `messagesUtd`,
          input: makeUpToDateBatchInput(),
        }
      case `sseClose`:
        return { type: `sseClose`, input: makeSseCloseInput() }
      case `pause`:
        return { type: `pause` }
      case `resume`:
        return { type: `resume` }
      case `error`:
        return { type: `error`, error: new Error(`truth-table error`) }
      case `retry`:
        return { type: `retry` }
      case `enterReplayMode`:
        return { type: `enterReplayMode`, replayCursor: `tt-replay` }
    }
  }

  const stateKinds: Array<StateKind> = [
    `initial`,
    `syncing`,
    `stale-retry`,
    `live`,
    `replaying`,
    `paused`,
    `error`,
  ]

  const eventTypes: Array<EventType> = [
    `response`,
    `messages`,
    `messagesUtd`,
    `sseClose`,
    `pause`,
    `resume`,
    `error`,
    `retry`,
    `enterReplayMode`,
  ]

  for (const stateKind of stateKinds) {
    describe(`${stateKind}`, () => {
      for (const eventType of eventTypes) {
        const expected = TRANSITION_TABLE[stateKind][eventType]

        it(`+ ${eventType} → ${expected.resultKind}${expected.note ? ` (${expected.note})` : ``}`, () => {
          const state = stateForKind(stateKind)
          const event = eventForType(eventType)

          // Skip events that are not applicable
          if (expected.notApplicable) {
            // For N/A events, the applyEvent dispatcher returns the same state
            // when the method doesn't exist
            const result = applyEvent(state, event)
            if (expected.resultKind === `same`) {
              // The state should be unchanged
              assertStateInvariants(result.state)
            }
            return
          }

          const result = applyEvent(state, event)
          assertStateInvariants(result.state)

          // Check the result kind
          if (expected.resultKind === `same`) {
            if (expected.sameReference) {
              expect(result.state).toBe(state)
            }
          } else {
            // For paused/error resume/retry, the result kind depends on
            // the inner state. We used syncing as the inner state.
            if (
              (stateKind === `paused` && eventType === `resume`) ||
              (stateKind === `error` && eventType === `retry`)
            ) {
              expect(getStateKind(result.state)).toBe(`syncing`)
            } else {
              expect(getStateKind(result.state)).toBe(expected.resultKind)
            }
          }

          // Check action if specified
          if (expected.action) {
            expect(result.action).toBe(expected.action)
          }
        })
      }
    })
  }
})

// ============================================================================
// Tier 3 — Algebraic property tests
// ============================================================================

describe(`Tier 3: Algebraic property tests`, () => {
  describe(`I3: pause/resume round-trip preserves identity`, () => {
    const allActiveStates: Array<{ name: string; state: ActiveState }> = [
      { name: `InitialState`, state: makeInitialState() },
      { name: `SyncingState`, state: makeSyncingState() },
      { name: `StaleRetryState`, state: makeStaleRetryState() },
      { name: `LiveState`, state: makeLiveState() },
      { name: `ReplayingState`, state: makeReplayingState() },
    ]

    for (const { name, state } of allActiveStates) {
      it(`${name}: pause().resume() === original`, () => {
        const paused = state.pause()
        expect(paused).toBeInstanceOf(PausedState)
        const resumed = paused.resume()
        expect(resumed).toBe(state)
      })
    }

    it(`ErrorState: pause().resume() === original`, () => {
      const errorState = makeErrorState()
      const paused = errorState.pause()
      expect(paused).toBeInstanceOf(PausedState)
      const resumed = paused.resume()
      expect(resumed).toBe(errorState)
    })
  })

  describe(`I4: error/retry preserves identity`, () => {
    const allActiveStates: Array<{ name: string; state: ActiveState }> = [
      { name: `InitialState`, state: makeInitialState() },
      { name: `SyncingState`, state: makeSyncingState() },
      { name: `StaleRetryState`, state: makeStaleRetryState() },
      { name: `LiveState`, state: makeLiveState() },
      { name: `ReplayingState`, state: makeReplayingState() },
    ]

    for (const { name, state } of allActiveStates) {
      it(`${name}: toErrorState(e).retry() === original`, () => {
        const err = new Error(`test`)
        const errState = state.toErrorState(err)
        expect(errState).toBeInstanceOf(ErrorState)
        expect(errState.error).toBe(err)
        const retried = errState.retry()
        expect(retried).toBe(state)
      })
    }

    it(`PausedState: new ErrorState(paused, e).retry() === paused`, () => {
      const paused = makePausedState()
      const err = new Error(`test`)
      const errState = new ErrorState(paused, err)
      const retried = errState.retry()
      expect(retried).toBe(paused)
    })
  })

  describe(`I12: no same-type nesting`, () => {
    it(`PausedState(PausedState(...)) flattens`, () => {
      const inner = makeSyncingState()
      const paused1 = new PausedState(inner)
      const paused2 = new PausedState(paused1 as any)
      expect(paused2.previousState).not.toBeInstanceOf(PausedState)
      expect(paused2.previousState).toBe(inner)
      assertStateInvariants(paused2)
    })

    it(`ErrorState(ErrorState(...)) flattens`, () => {
      const inner = makeSyncingState()
      const err1 = new ErrorState(inner, new Error(`e1`))
      const err2 = new ErrorState(err1 as any, new Error(`e2`))
      expect(err2.previousState).not.toBeInstanceOf(ErrorState)
      expect(err2.previousState).toBe(inner)
      assertStateInvariants(err2)
    })
  })

  describe(`I2: immutability — transitions create new objects`, () => {
    it(`SyncingState.handleResponseMetadata creates new state`, () => {
      const state = makeSyncingState({ offset: `0_0` })
      const result = state.handleResponseMetadata(
        makeResponseInput({ offset: `5_0` })
      )
      expect(result.state).not.toBe(state)
      expect(state.offset).toBe(`0_0`) // original unchanged
    })

    it(`LiveState.handleMessageBatch creates new state`, () => {
      const state = makeLiveState()
      const result = state.handleMessageBatch(makeMessageBatchInput())
      expect(result.state).not.toBe(state)
    })

    it(`pause on PausedState returns this (identity no-op)`, () => {
      const paused = makePausedState()
      expect(paused.pause()).toBe(paused)
    })
  })

  describe(`hierarchy checks`, () => {
    it(`FetchingState subtypes have shouldUseSse() → false`, () => {
      const states: Array<FetchingState> = [
        makeInitialState(),
        makeSyncingState(),
        makeStaleRetryState(),
      ]
      for (const s of states) {
        expect(s.shouldUseSse()).toBe(false)
        expect(s).toBeInstanceOf(FetchingState)
        expect(s).toBeInstanceOf(ActiveState)
        expect(s).toBeInstanceOf(StreamState)
      }
    })

    it(`LiveState and ReplayingState are ActiveState but not FetchingState`, () => {
      const live = makeLiveState()
      const replaying = makeReplayingState()
      expect(live).toBeInstanceOf(ActiveState)
      expect(live).not.toBeInstanceOf(FetchingState)
      expect(replaying).toBeInstanceOf(ActiveState)
      expect(replaying).not.toBeInstanceOf(FetchingState)
    })

    it(`PausedState and ErrorState are StreamState but not ActiveState`, () => {
      const paused = makePausedState()
      const error = makeErrorState()
      expect(paused).toBeInstanceOf(StreamState)
      expect(paused).not.toBeInstanceOf(ActiveState)
      expect(error).toBeInstanceOf(StreamState)
      expect(error).not.toBeInstanceOf(ActiveState)
    })
  })
})

// ============================================================================
// Tier 4 — Fuzz tests
// ============================================================================

describe(`Tier 4: Fuzz tests`, () => {
  it(`100 random events from initial state — invariants hold on every step`, () => {
    const rng = mulberry32(42)
    let state: StreamState = makeInitialState()
    assertStateInvariants(state)

    for (let i = 0; i < 100; i++) {
      const event = pickRandomEvent(state, rng)
      const result = applyEvent(state, event)
      state = result.state
      assertStateInvariants(state)
    }
  })

  it(`200 random events from live state — invariants hold on every step`, () => {
    const rng = mulberry32(12345)
    let state: StreamState = makeLiveState()
    assertStateInvariants(state)

    for (let i = 0; i < 200; i++) {
      const event = pickRandomEvent(state, rng)
      const result = applyEvent(state, event)
      state = result.state
      assertStateInvariants(state)
    }
  })

  it(`fuzz from every starting state with different seeds`, () => {
    const allStates = makeAllStates()
    for (const { kind, state: startState } of allStates) {
      const rng = mulberry32(kind.length * 7919) // different seed per kind
      let state: StreamState = startState
      assertStateInvariants(state)

      for (let i = 0; i < 50; i++) {
        const event = pickRandomEvent(state, rng)
        const result = applyEvent(state, event)
        state = result.state
        assertStateInvariants(state)
      }
    }
  })
})

// ============================================================================
// Tier 5 — Dedicated tests
// ============================================================================

describe(`Tier 5: Dedicated tests`, () => {
  describe(`SSE fallback logic (LiveState.handleSseConnectionClosed)`, () => {
    it(`healthy connection (long duration) resets counter to 0`, () => {
      const state = makeLiveState(undefined, {
        consecutiveShortConnections: 2,
      })
      const result = state.handleSseConnectionClosed(
        makeSseCloseInput({ connectionDuration: 5000 })
      )
      const next = result.state as LiveState
      expect(next).toBeInstanceOf(LiveState)
      expect(next.consecutiveShortConnections).toBe(0)
      assertStateInvariants(next)
    })

    it(`short connection increments counter`, () => {
      const state = makeLiveState(undefined, {
        consecutiveShortConnections: 0,
      })
      const result = state.handleSseConnectionClosed(
        makeSseCloseInput({
          connectionDuration: 500,
          minConnectionDuration: 1000,
        })
      )
      const resultWithTracking = result as {
        state: LiveState
        wasShortConnection: boolean
        fellBackToLongPolling: boolean
      }
      expect(resultWithTracking.state.consecutiveShortConnections).toBe(1)
      expect(resultWithTracking.wasShortConnection).toBe(true)
      expect(resultWithTracking.fellBackToLongPolling).toBe(false)
      assertStateInvariants(resultWithTracking.state)
    })

    it(`reaching threshold enables sseFallbackToLongPolling`, () => {
      const state = makeLiveState(undefined, {
        consecutiveShortConnections: 2,
      })
      const result = state.handleSseConnectionClosed(
        makeSseCloseInput({
          connectionDuration: 500,
          minConnectionDuration: 1000,
          maxShortConnections: 3,
        })
      )
      const resultWithTracking = result as {
        state: LiveState
        wasShortConnection: boolean
        fellBackToLongPolling: boolean
      }
      expect(resultWithTracking.fellBackToLongPolling).toBe(true)
      expect(resultWithTracking.state.sseFallbackToLongPolling).toBe(true)
      assertStateInvariants(resultWithTracking.state)
    })

    it(`aborted connection does not increment counter`, () => {
      const state = makeLiveState(undefined, {
        consecutiveShortConnections: 1,
      })
      const result = state.handleSseConnectionClosed(
        makeSseCloseInput({
          connectionDuration: 500,
          minConnectionDuration: 1000,
          wasAborted: true,
        })
      )
      expect(result.state).toBe(state) // same reference — no change
    })

    it(`sync fields preserved across SSE fallback`, () => {
      const state = makeLiveState(
        { offset: `7_0`, cursor: `c`, upToDate: true },
        { consecutiveShortConnections: 2 }
      )
      const result = state.handleSseConnectionClosed(
        makeSseCloseInput({
          connectionDuration: 500,
          minConnectionDuration: 1000,
          maxShortConnections: 3,
        })
      )
      const next = result.state as LiveState
      expect(next.offset).toBe(`7_0`)
      expect(next.cursor).toBe(`c`)
      expect(next.upToDate).toBe(true)
    })
  })

  describe(`shouldUseSse`, () => {
    it(`FetchingState subtypes always return false`, () => {
      expect(makeInitialState().shouldUseSse()).toBe(false)
      expect(makeSyncingState().shouldUseSse()).toBe(false)
      expect(makeStaleRetryState().shouldUseSse()).toBe(false)
    })

    it(`LiveState returns false without options`, () => {
      expect(makeLiveState().shouldUseSse()).toBe(false)
    })

    it(`LiveState returns true when liveSseEnabled and not resuming`, () => {
      const live = makeLiveState()
      expect(
        live.shouldUseSse({
          liveSseEnabled: true,
          resumingFromPause: false,
        })
      ).toBe(true)
    })

    it(`LiveState returns false when resumingFromPause`, () => {
      const live = makeLiveState()
      expect(
        live.shouldUseSse({
          liveSseEnabled: true,
          resumingFromPause: true,
        })
      ).toBe(false)
    })

    it(`LiveState returns false when liveSseEnabled is false`, () => {
      const live = makeLiveState()
      expect(
        live.shouldUseSse({
          liveSseEnabled: false,
          resumingFromPause: false,
        })
      ).toBe(false)
    })

    it(`LiveState returns false when sseFallbackToLongPolling is true`, () => {
      const live = makeLiveState(undefined, {
        sseFallbackToLongPolling: true,
      })
      expect(
        live.shouldUseSse({
          liveSseEnabled: true,
          resumingFromPause: false,
        })
      ).toBe(false)
    })

    it(`PausedState delegates shouldUseSse to inner state`, () => {
      const live = makeLiveState()
      const paused = new PausedState(live)
      expect(
        paused.shouldUseSse({
          liveSseEnabled: true,
          resumingFromPause: false,
        })
      ).toBe(true)
    })

    it(`ErrorState delegates shouldUseSse to inner state`, () => {
      const live = makeLiveState()
      const error = new ErrorState(live, new Error(`test`))
      expect(
        error.shouldUseSse({
          liveSseEnabled: true,
          resumingFromPause: false,
        })
      ).toBe(true)
    })

    it(`ReplayingState returns false`, () => {
      expect(makeReplayingState().shouldUseSse()).toBe(false)
    })
  })

  describe(`applyUrlParams`, () => {
    it(`InitialState sets offset`, () => {
      const state = makeInitialState({ offset: `-1` })
      const url = new URL(`https://example.com/stream`)
      state.applyUrlParams(url)
      expect(url.searchParams.get(`offset`)).toBe(`-1`)
      expect(url.searchParams.has(`cursor`)).toBe(false)
    })

    it(`SyncingState sets offset and cursor`, () => {
      const state = makeSyncingState({ offset: `5_0`, cursor: `abc` })
      const url = new URL(`https://example.com/stream`)
      state.applyUrlParams(url)
      expect(url.searchParams.get(`offset`)).toBe(`5_0`)
      expect(url.searchParams.get(`cursor`)).toBe(`abc`)
    })

    it(`StaleRetryState sets offset and cache_buster`, () => {
      const state = makeStaleRetryState({ offset: `3_0` }, `my-cache-buster`)
      const url = new URL(`https://example.com/stream`)
      state.applyUrlParams(url)
      expect(url.searchParams.get(`offset`)).toBe(`3_0`)
      expect(url.searchParams.get(`cache_buster`)).toBe(`my-cache-buster`)
    })

    it(`LiveState sets offset and live=true`, () => {
      const state = makeLiveState({ offset: `10_0` })
      const url = new URL(`https://example.com/stream`)
      state.applyUrlParams(url)
      expect(url.searchParams.get(`offset`)).toBe(`10_0`)
      expect(url.searchParams.get(`live`)).toBe(`true`)
    })

    it(`LiveState with sseFallbackToLongPolling sets live=long-poll`, () => {
      const state = makeLiveState(
        { offset: `10_0` },
        { sseFallbackToLongPolling: true }
      )
      const url = new URL(`https://example.com/stream`)
      state.applyUrlParams(url)
      expect(url.searchParams.get(`live`)).toBe(`long-poll`)
    })
  })

  describe(`canEnterReplayMode`, () => {
    it(`InitialState → true`, () => {
      expect(makeInitialState().canEnterReplayMode()).toBe(true)
    })

    it(`SyncingState → true`, () => {
      expect(makeSyncingState().canEnterReplayMode()).toBe(true)
    })

    it(`StaleRetryState → false`, () => {
      expect(makeStaleRetryState().canEnterReplayMode()).toBe(false)
    })

    it(`LiveState → true`, () => {
      expect(makeLiveState().canEnterReplayMode()).toBe(true)
    })

    it(`ReplayingState → false`, () => {
      expect(makeReplayingState().canEnterReplayMode()).toBe(false)
    })
  })

  describe(`shouldContinueLive`, () => {
    it(`returns false when stopAfterUpToDate && upToDate`, () => {
      const state = makeLiveState({ upToDate: true })
      expect(state.shouldContinueLive(true, true)).toBe(false)
    })

    it(`returns false when liveMode is false`, () => {
      const state = makeSyncingState()
      expect(state.shouldContinueLive(false, false)).toBe(false)
    })

    it(`returns false when streamClosed`, () => {
      const state = makeSyncingState({ streamClosed: true })
      expect(state.shouldContinueLive(false, true)).toBe(false)
    })

    it(`returns true otherwise`, () => {
      const state = makeSyncingState()
      expect(state.shouldContinueLive(false, true)).toBe(true)
    })

    it(`returns true when upToDate but not stopAfterUpToDate`, () => {
      const state = makeLiveState({ upToDate: true })
      expect(state.shouldContinueLive(false, true)).toBe(true)
    })

    it(`returns true with live mode "long-poll"`, () => {
      const state = makeSyncingState()
      expect(state.shouldContinueLive(false, `long-poll`)).toBe(true)
    })
  })

  describe(`ReplayingState message batch handling`, () => {
    it(`transitions to LiveState on upToDate`, () => {
      const state = makeReplayingState({ offset: `5_0` }, `rp-cursor`)
      const result = state.handleMessageBatch(
        makeUpToDateBatchInput({ currentCursor: `other` })
      )
      expect(result.state).toBeInstanceOf(LiveState)
      expect(result.becameUpToDate).toBe(true)
      expect(result.state.upToDate).toBe(true)
    })

    it(`suppresses batch when cursor matches and not SSE`, () => {
      const state = makeReplayingState({ offset: `5_0` }, `rp-cursor`)
      const result = state.handleMessageBatch(
        makeUpToDateBatchInput({
          currentCursor: `rp-cursor`,
          isSse: false,
        })
      )
      expect(result.suppressBatch).toBe(true)
      expect(result.becameUpToDate).toBe(true)
    })

    it(`does not suppress batch when cursor matches but is SSE`, () => {
      const state = makeReplayingState({ offset: `5_0` }, `rp-cursor`)
      const result = state.handleMessageBatch(
        makeUpToDateBatchInput({
          currentCursor: `rp-cursor`,
          isSse: true,
        })
      )
      expect(result.suppressBatch).toBe(false)
      expect(result.becameUpToDate).toBe(true)
    })

    it(`does not suppress batch when cursor does not match`, () => {
      const state = makeReplayingState({ offset: `5_0` }, `rp-cursor`)
      const result = state.handleMessageBatch(
        makeUpToDateBatchInput({
          currentCursor: `different-cursor`,
          isSse: false,
        })
      )
      expect(result.suppressBatch).toBe(false)
    })

    it(`stays in replaying when no upToDate`, () => {
      const state = makeReplayingState()
      const result = state.handleMessageBatch(makeMessageBatchInput())
      expect(result.state).toBe(state)
      expect(result.becameUpToDate).toBe(false)
    })
  })

  describe(`SyncingState message batch handling`, () => {
    it(`transitions to LiveState on upToDate`, () => {
      const state = makeSyncingState({ offset: `3_0` })
      const result = state.handleMessageBatch(makeUpToDateBatchInput())
      expect(result.state).toBeInstanceOf(LiveState)
      expect(result.becameUpToDate).toBe(true)
      expect(result.state.upToDate).toBe(true)
    })

    it(`stays in syncing when no upToDate`, () => {
      const state = makeSyncingState()
      const result = state.handleMessageBatch(makeMessageBatchInput())
      expect(result.state).toBe(state)
      expect(result.becameUpToDate).toBe(false)
    })
  })

  describe(`LiveState response metadata handling`, () => {
    it(`preserves SSE tracking fields across response`, () => {
      const state = makeLiveState(
        { offset: `1_0` },
        { consecutiveShortConnections: 2, sseFallbackToLongPolling: true }
      )
      const result = state.handleResponseMetadata(
        makeResponseInput({ offset: `5_0` })
      )
      expect(result.action).toBe(`accepted`)
      const next = result.state as LiveState
      expect(next.consecutiveShortConnections).toBe(2)
      expect(next.sseFallbackToLongPolling).toBe(true)
      expect(next.offset).toBe(`5_0`)
    })
  })

  describe(`response metadata field preservation`, () => {
    it(`preserves cursor when response has no cursor`, () => {
      const state = makeSyncingState({ cursor: `existing` })
      const result = state.handleResponseMetadata(
        makeResponseInput({ cursor: undefined })
      )
      expect(result.state.cursor).toBe(`existing`)
    })

    it(`preserves offset when response has no offset`, () => {
      const state = makeSyncingState({ offset: `3_50` })
      const result = state.handleResponseMetadata(
        makeResponseInput({ offset: undefined })
      )
      expect(result.state.offset).toBe(`3_50`)
    })

    it(`streamClosed once true stays true`, () => {
      const state = makeSyncingState({ streamClosed: true })
      const result = state.handleResponseMetadata(
        makeResponseInput({ streamClosed: false })
      )
      expect(result.state.streamClosed).toBe(true)
    })
  })

  describe(`PausedState response delegation`, () => {
    it(`delegates response to inner and wraps in PausedState`, () => {
      const inner = makeSyncingState({ offset: `1_0` })
      const paused = new PausedState(inner)
      const result = paused.handleResponseMetadata(
        makeResponseInput({ offset: `10_0` })
      )
      expect(result.action).toBe(`accepted`)
      expect(result.state).toBeInstanceOf(PausedState)
      expect(result.state.offset).toBe(`10_0`)
    })

    it(`returns ignored when inner returns ignored`, () => {
      // ErrorState wrapping — paused wrapping an error
      const errInner = makeErrorState()
      const paused = new PausedState(errInner)
      const result = paused.handleResponseMetadata(makeResponseInput())
      // ErrorState.handleResponseMetadata returns ignored
      expect(result.action).toBe(`ignored`)
      expect(result.state).toBe(paused)
    })
  })
})

// ============================================================================
// Group 5: Type safety test — PausedState.handleResponseMetadata return type
// ============================================================================

describe(`PausedState type safety`, () => {
  // EXPECTED TO FAIL — exposes bug #10
  // PausedState.handleResponseMetadata delegates to inner state and wraps result.
  // When the inner handleResponseMetadata returns { action: 'accepted', state: ActiveState },
  // PausedState wraps it with `new PausedState(inner.state) as unknown as ActiveState`.
  //
  // The `as unknown as ActiveState` cast lies to the type system. The returned
  // state is a PausedState (which is NOT an ActiveState), but the type signature
  // says it's ActiveState. This can cause runtime errors if callers rely on
  // ActiveState methods that PausedState doesn't have.
  it(`PausedState.handleResponseMetadata returns PausedState, not ActiveState`, () => {
    const inner = makeSyncingState({ offset: `1_0` })
    const paused = new PausedState(inner)
    const result = paused.handleResponseMetadata(
      makeResponseInput({ offset: `10_0` })
    )

    // The transition says 'accepted' and we get a state back
    expect(result.action).toBe(`accepted`)
    expect(result.state.offset).toBe(`10_0`)

    // Verify the returned state IS a PausedState (correct runtime behavior)
    expect(result.state).toBeInstanceOf(PausedState)

    // Verify it is NOT actually an ActiveState (exposes the type cast lie)
    // The ResponseTransition type says `state: ActiveState` for 'accepted',
    // but the actual value is a PausedState which extends StreamState, not ActiveState.
    expect(result.state).not.toBeInstanceOf(ActiveState)

    // The key issue: if someone calls ActiveState-specific methods on the result,
    // it would fail at runtime despite the types saying it's fine.
    // For example, ActiveState has toErrorState(), canEnterReplayMode(), etc.
    // PausedState does NOT have these methods.
    const state = result.state
    expect(typeof (state as any).toErrorState).toBe(`undefined`)
    expect(typeof (state as any).canEnterReplayMode).toBe(`undefined`)
  })
})
