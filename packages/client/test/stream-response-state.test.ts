import { describe, expect, it } from "vitest"
import {
  LongPollState,
  PausedState,
  SSEState,
} from "../src/stream-response-state"
import type { SSEControlEvent } from "../src/sse"
import type { SSEResilienceOptions } from "../src/types"
import type { SyncFields } from "../src/stream-response-state"

// ── Helpers ──────────────────────────────────────────────────────────────

function makeSyncFields(overrides?: Partial<SyncFields>): SyncFields {
  return {
    offset: `0_0`,
    cursor: undefined,
    upToDate: false,
    streamClosed: false,
    ...overrides,
  }
}

function makeSSEConfig(
  overrides?: Partial<SSEResilienceOptions>
): Required<SSEResilienceOptions> {
  return {
    minConnectionDuration: 1000,
    maxShortConnections: 3,
    backoffBaseDelay: 100,
    backoffMaxDelay: 5000,
    logWarnings: false,
    ...overrides,
  }
}

function makeControlEvent(
  overrides?: Partial<Omit<SSEControlEvent, `type`>>
): SSEControlEvent {
  return {
    type: `control`,
    streamNextOffset: `1_10`,
    ...overrides,
  }
}

// ── LongPollState ────────────────────────────────────────────────────────

describe(`LongPollState`, () => {
  describe(`withResponseMetadata`, () => {
    it(`updates offset/cursor/upToDate/streamClosed`, () => {
      const state = new LongPollState(makeSyncFields())
      const next = state.withResponseMetadata({
        offset: `5_100`,
        cursor: `abc`,
        upToDate: true,
        streamClosed: false,
      })
      expect(next.offset).toBe(`5_100`)
      expect(next.cursor).toBe(`abc`)
      expect(next.upToDate).toBe(true)
      expect(next.streamClosed).toBe(false)
      expect(next).toBeInstanceOf(LongPollState)
    })

    it(`preserves cursor when response has no cursor header`, () => {
      const state = new LongPollState(makeSyncFields({ cursor: `existing` }))
      const next = state.withResponseMetadata({
        offset: `2_0`,
        cursor: undefined,
        upToDate: false,
        streamClosed: false,
      })
      expect(next.cursor).toBe(`existing`)
    })

    it(`preserves offset when response has no offset header`, () => {
      const state = new LongPollState(makeSyncFields({ offset: `3_50` }))
      const next = state.withResponseMetadata({
        offset: undefined,
        cursor: undefined,
        upToDate: false,
        streamClosed: false,
      })
      expect(next.offset).toBe(`3_50`)
    })

    it(`streamClosed once true stays true`, () => {
      const state = new LongPollState(makeSyncFields({ streamClosed: true }))
      const next = state.withResponseMetadata({
        offset: `1_0`,
        upToDate: false,
        streamClosed: false,
      })
      expect(next.streamClosed).toBe(true)
    })

    it(`does not mutate the original state`, () => {
      const state = new LongPollState(makeSyncFields())
      state.withResponseMetadata({
        offset: `9_0`,
        cursor: `new`,
        upToDate: true,
        streamClosed: true,
      })
      expect(state.offset).toBe(`0_0`)
      expect(state.cursor).toBeUndefined()
      expect(state.upToDate).toBe(false)
      expect(state.streamClosed).toBe(false)
    })
  })

  describe(`withSSEControl`, () => {
    it(`updates offset/cursor/upToDate/streamClosed`, () => {
      const state = new LongPollState(makeSyncFields())
      const next = state.withSSEControl(
        makeControlEvent({
          streamNextOffset: `3_20`,
          streamCursor: `cur1`,
          upToDate: true,
        })
      )
      expect(next.offset).toBe(`3_20`)
      expect(next.cursor).toBe(`cur1`)
      expect(next.upToDate).toBe(true)
      expect(next.streamClosed).toBe(false)
    })

    it(`streamClosed also sets upToDate`, () => {
      const state = new LongPollState(makeSyncFields())
      const next = state.withSSEControl(
        makeControlEvent({ streamClosed: true })
      )
      expect(next.streamClosed).toBe(true)
      expect(next.upToDate).toBe(true)
    })

    it(`preserves cursor when control event has no cursor`, () => {
      const state = new LongPollState(makeSyncFields({ cursor: `old` }))
      const next = state.withSSEControl(
        makeControlEvent({ streamCursor: undefined })
      )
      expect(next.cursor).toBe(`old`)
    })

    it(`preserves upToDate when control event has undefined upToDate`, () => {
      const state = new LongPollState(makeSyncFields({ upToDate: true }))
      const next = state.withSSEControl(
        makeControlEvent({ upToDate: undefined })
      )
      expect(next.upToDate).toBe(true)
    })
  })

  describe(`shouldUseSse`, () => {
    it(`returns false`, () => {
      const state = new LongPollState(makeSyncFields())
      expect(state.shouldUseSse()).toBe(false)
    })
  })

  describe(`pause`, () => {
    it(`returns a PausedState wrapping the LongPollState`, () => {
      const state = new LongPollState(makeSyncFields())
      const paused = state.pause()
      expect(paused).toBeInstanceOf(PausedState)
      expect(paused.offset).toBe(state.offset)
    })
  })
})

// ── SSEState ─────────────────────────────────────────────────────────────

describe(`SSEState`, () => {
  describe(`withSSEControl`, () => {
    it(`updates offset/cursor/upToDate/streamClosed`, () => {
      const state = new SSEState(makeSyncFields())
      const next = state.withSSEControl(
        makeControlEvent({
          streamNextOffset: `4_50`,
          streamCursor: `sse-cur`,
          upToDate: true,
        })
      )
      expect(next.offset).toBe(`4_50`)
      expect(next.cursor).toBe(`sse-cur`)
      expect(next.upToDate).toBe(true)
      expect(next).toBeInstanceOf(SSEState)
    })

    it(`streamClosed also sets upToDate`, () => {
      const state = new SSEState(makeSyncFields())
      const next = state.withSSEControl(
        makeControlEvent({ streamClosed: true, upToDate: undefined })
      )
      expect(next.streamClosed).toBe(true)
      expect(next.upToDate).toBe(true)
    })

    it(`preserves SSE-specific fields across sync updates`, () => {
      const state = new SSEState({
        ...makeSyncFields(),
        consecutiveShortConnections: 2,
        connectionStartTime: 1000,
      })
      const next = state.withSSEControl(makeControlEvent({ upToDate: true }))
      expect(next.consecutiveShortConnections).toBe(2)
      expect(next.connectionStartTime).toBe(1000)
    })
  })

  describe(`withResponseMetadata`, () => {
    it(`preserves SSE-specific fields`, () => {
      const state = new SSEState({
        ...makeSyncFields(),
        consecutiveShortConnections: 1,
        connectionStartTime: 500,
      })
      const next = state.withResponseMetadata({
        offset: `2_0`,
        upToDate: true,
        streamClosed: false,
      })
      expect(next.consecutiveShortConnections).toBe(1)
      expect(next.connectionStartTime).toBe(500)
      expect(next).toBeInstanceOf(SSEState)
    })
  })

  describe(`shouldUseSse`, () => {
    it(`returns true`, () => {
      const state = new SSEState(makeSyncFields())
      expect(state.shouldUseSse()).toBe(true)
    })
  })

  describe(`startConnection`, () => {
    it(`records timestamp`, () => {
      const state = new SSEState(makeSyncFields())
      const next = state.startConnection(42000)
      expect(next.connectionStartTime).toBe(42000)
      expect(next.offset).toBe(state.offset)
    })

    it(`preserves other fields`, () => {
      const state = new SSEState({
        ...makeSyncFields({ cursor: `c` }),
        consecutiveShortConnections: 2,
      })
      const next = state.startConnection(1000)
      expect(next.cursor).toBe(`c`)
      expect(next.consecutiveShortConnections).toBe(2)
    })
  })

  describe(`handleConnectionEnd`, () => {
    const config = makeSSEConfig()

    it(`treats missing connectionStartTime as healthy`, () => {
      const state = new SSEState(makeSyncFields())
      const result = state.handleConnectionEnd(5000, false, config)
      expect(result.action).toBe(`healthy`)
      expect(result.state).toBe(state) // identity preserved
    })

    it(`short connection increments counter`, () => {
      const state = new SSEState({
        ...makeSyncFields(),
        connectionStartTime: 1000,
        consecutiveShortConnections: 0,
      })
      // Duration = 500ms < 1000ms threshold
      const result = state.handleConnectionEnd(1500, false, config)
      expect(result.action).toBe(`reconnect`)
      if (result.action === `reconnect`) {
        expect(result.state.consecutiveShortConnections).toBe(1)
        expect(result.backoffAttempt).toBe(1)
      }
    })

    it(`counter reaches threshold → transitions to LongPollState`, () => {
      const state = new SSEState({
        ...makeSyncFields(),
        connectionStartTime: 1000,
        consecutiveShortConnections: 2, // Next increment → 3 = maxShortConnections
      })
      const result = state.handleConnectionEnd(1500, false, config)
      expect(result.action).toBe(`fallback`)
      expect(result.state).toBeInstanceOf(LongPollState)
      expect(result.state.shouldUseSse()).toBe(false)
    })

    it(`after fallback, state preserves sync fields`, () => {
      const state = new SSEState({
        ...makeSyncFields({ offset: `7_0`, cursor: `c`, upToDate: true }),
        connectionStartTime: 1000,
        consecutiveShortConnections: 2,
      })
      const result = state.handleConnectionEnd(1500, false, config)
      expect(result.state.offset).toBe(`7_0`)
      expect(result.state.cursor).toBe(`c`)
      expect(result.state.upToDate).toBe(true)
    })

    it(`healthy connection resets counter to 0`, () => {
      const state = new SSEState({
        ...makeSyncFields(),
        connectionStartTime: 1000,
        consecutiveShortConnections: 2,
      })
      // Duration = 2000ms >= 1000ms threshold
      const result = state.handleConnectionEnd(3000, false, config)
      expect(result.action).toBe(`healthy`)
      if (result.action === `healthy`) {
        expect(result.state.consecutiveShortConnections).toBe(0)
      }
    })

    it(`aborted connection doesn't increment counter`, () => {
      const state = new SSEState({
        ...makeSyncFields(),
        connectionStartTime: 1000,
        consecutiveShortConnections: 1,
      })
      // Short duration but aborted
      const result = state.handleConnectionEnd(1500, true, config)
      expect(result.action).toBe(`healthy`)
      expect(result.state.consecutiveShortConnections).toBe(1)
      expect(result.state).toBe(state) // identity preserved for no-op
    })

    it(`backoffAttempt matches new counter value`, () => {
      const state = new SSEState({
        ...makeSyncFields(),
        connectionStartTime: 1000,
        consecutiveShortConnections: 1,
      })
      const result = state.handleConnectionEnd(1500, false, config)
      if (result.action === `reconnect`) {
        expect(result.backoffAttempt).toBe(2) // was 1, now 2
      }
    })
  })

  describe(`pause`, () => {
    it(`returns a PausedState wrapping the SSEState`, () => {
      const state = new SSEState(makeSyncFields())
      const paused = state.pause()
      expect(paused).toBeInstanceOf(PausedState)
      expect(paused.shouldUseSse()).toBe(true)
    })
  })
})

// ── PausedState ──────────────────────────────────────────────────────────

describe(`PausedState`, () => {
  it(`delegates offset/cursor/upToDate/streamClosed to inner state`, () => {
    const inner = new LongPollState(
      makeSyncFields({
        offset: `10_0`,
        cursor: `paused-cursor`,
        upToDate: true,
        streamClosed: true,
      })
    )
    const paused = new PausedState(inner)
    expect(paused.offset).toBe(`10_0`)
    expect(paused.cursor).toBe(`paused-cursor`)
    expect(paused.upToDate).toBe(true)
    expect(paused.streamClosed).toBe(true)
  })

  it(`resume() returns inner state with identity preserved`, () => {
    const inner = new SSEState(makeSyncFields({ offset: `5_0` }))
    const paused = new PausedState(inner)
    const result = paused.resume()
    expect(result.state).toBe(inner) // identity check
    expect(result.justResumed).toBe(true)
  })

  it(`resume() returns justResumed: true`, () => {
    const inner = new LongPollState(makeSyncFields())
    const paused = new PausedState(inner)
    expect(paused.resume().justResumed).toBe(true)
  })

  it(`shouldUseSse() delegates to inner (LongPollState)`, () => {
    const paused = new PausedState(new LongPollState(makeSyncFields()))
    expect(paused.shouldUseSse()).toBe(false)
  })

  it(`shouldUseSse() delegates to inner (SSEState)`, () => {
    const paused = new PausedState(new SSEState(makeSyncFields()))
    expect(paused.shouldUseSse()).toBe(true)
  })

  it(`pause() on already-paused state returns self`, () => {
    const paused = new PausedState(new LongPollState(makeSyncFields()))
    expect(paused.pause()).toBe(paused)
  })

  it(`withResponseMetadata delegates and returns new PausedState`, () => {
    const inner = new LongPollState(makeSyncFields())
    const paused = new PausedState(inner)
    const next = paused.withResponseMetadata({
      offset: `99_0`,
      upToDate: true,
      streamClosed: false,
    })
    expect(next).toBeInstanceOf(PausedState)
    expect(next.offset).toBe(`99_0`)
    expect(next.upToDate).toBe(true)
    // Original paused unchanged
    expect(paused.offset).toBe(`0_0`)
  })

  it(`withSSEControl delegates and returns new PausedState`, () => {
    const inner = new SSEState(makeSyncFields())
    const paused = new PausedState(inner)
    const next = paused.withSSEControl(
      makeControlEvent({ streamNextOffset: `8_0`, upToDate: true })
    )
    expect(next).toBeInstanceOf(PausedState)
    expect(next.offset).toBe(`8_0`)
  })
})

// ── shouldContinueLive ───────────────────────────────────────────────────

describe(`shouldContinueLive`, () => {
  it(`returns false when stopAfterUpToDate && upToDate`, () => {
    const state = new LongPollState(makeSyncFields({ upToDate: true }))
    expect(state.shouldContinueLive(true, true)).toBe(false)
  })

  it(`returns false when liveMode === false`, () => {
    const state = new LongPollState(makeSyncFields())
    expect(state.shouldContinueLive(false, false)).toBe(false)
  })

  it(`returns false when streamClosed`, () => {
    const state = new LongPollState(makeSyncFields({ streamClosed: true }))
    expect(state.shouldContinueLive(false, true)).toBe(false)
  })

  it(`returns true otherwise`, () => {
    const state = new LongPollState(makeSyncFields())
    expect(state.shouldContinueLive(false, true)).toBe(true)
  })

  it(`returns true when upToDate but not stopAfterUpToDate`, () => {
    const state = new LongPollState(makeSyncFields({ upToDate: true }))
    expect(state.shouldContinueLive(false, true)).toBe(true)
  })

  it(`returns true with live mode "long-poll"`, () => {
    const state = new LongPollState(makeSyncFields())
    expect(state.shouldContinueLive(false, `long-poll`)).toBe(true)
  })

  it(`returns true with live mode "sse"`, () => {
    const state = new LongPollState(makeSyncFields())
    expect(state.shouldContinueLive(false, `sse`)).toBe(true)
  })

  it(`works on SSEState`, () => {
    const state = new SSEState(makeSyncFields({ streamClosed: true }))
    expect(state.shouldContinueLive(false, true)).toBe(false)
  })

  it(`works on PausedState`, () => {
    const state = new PausedState(
      new LongPollState(makeSyncFields({ upToDate: true }))
    )
    expect(state.shouldContinueLive(true, true)).toBe(false)
  })
})

// ── State transitions ────────────────────────────────────────────────────

describe(`state transitions`, () => {
  it(`LongPollState → PausedState → resume → LongPollState`, () => {
    const initial = new LongPollState(makeSyncFields({ offset: `1_0` }))
    const paused = initial.pause()
    expect(paused).toBeInstanceOf(PausedState)

    const { state: resumed } = paused.resume()
    expect(resumed).toBe(initial) // identity preserved
    expect(resumed).toBeInstanceOf(LongPollState)
  })

  it(`SSEState → PausedState → resume → SSEState`, () => {
    const initial = new SSEState({
      ...makeSyncFields(),
      consecutiveShortConnections: 2,
      connectionStartTime: 1000,
    })
    const paused = initial.pause()
    expect(paused.shouldUseSse()).toBe(true)

    const { state: resumed } = paused.resume()
    expect(resumed).toBe(initial)
    expect(resumed).toBeInstanceOf(SSEState)
    expect((resumed as SSEState).consecutiveShortConnections).toBe(2)
  })

  it(`SSEState → handleConnectionEnd fallback → LongPollState`, () => {
    const config = makeSSEConfig({ maxShortConnections: 1 })
    const state = new SSEState({
      ...makeSyncFields({ offset: `5_0` }),
      connectionStartTime: 1000,
    })
    const result = state.handleConnectionEnd(1100, false, config)
    expect(result.action).toBe(`fallback`)
    expect(result.state).toBeInstanceOf(LongPollState)
    expect(result.state.offset).toBe(`5_0`)
    expect(result.state.shouldUseSse()).toBe(false)
  })

  it(`SSEState → handleConnectionEnd reconnect → SSEState`, () => {
    const config = makeSSEConfig()
    const state = new SSEState({
      ...makeSyncFields(),
      connectionStartTime: 1000,
    })
    const result = state.handleConnectionEnd(1100, false, config)
    expect(result.action).toBe(`reconnect`)
    expect(result.state).toBeInstanceOf(SSEState)
    expect(result.state.shouldUseSse()).toBe(true)
  })

  it(`SSEState → handleConnectionEnd healthy → SSEState`, () => {
    const config = makeSSEConfig()
    const state = new SSEState({
      ...makeSyncFields(),
      connectionStartTime: 1000,
    })
    const result = state.handleConnectionEnd(3000, false, config)
    expect(result.action).toBe(`healthy`)
    expect(result.state).toBeInstanceOf(SSEState)
  })
})
