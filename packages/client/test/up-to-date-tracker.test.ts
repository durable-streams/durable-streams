import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  InMemoryUpToDateStorage,
  LocalStorageUpToDateStorage,
  UpToDateTracker,
  canonicalStreamKey,
} from "../src/up-to-date-tracker"
import { LiveState, ReplayingState } from "../src/stream-response-state"

describe(`UpToDateTracker`, () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it(`recordUpToDate stores cursor for stream key`, () => {
    const tracker = new UpToDateTracker()
    tracker.recordUpToDate(`stream-1`, `cursor-abc`)
    const cursor = tracker.shouldEnterReplayMode(`stream-1`)
    expect(cursor).toBe(`cursor-abc`)
  })

  it(`shouldEnterReplayMode returns cursor when entry is fresh (<60s)`, () => {
    const tracker = new UpToDateTracker()
    vi.setSystemTime(new Date(1000))
    tracker.recordUpToDate(`stream-1`, `cursor-abc`)

    // Advance 30 seconds — still fresh
    vi.setSystemTime(new Date(31_000))
    const cursor = tracker.shouldEnterReplayMode(`stream-1`)
    expect(cursor).toBe(`cursor-abc`)
  })

  it(`shouldEnterReplayMode returns null when entry is stale (>60s)`, () => {
    const tracker = new UpToDateTracker()
    vi.setSystemTime(new Date(1000))
    tracker.recordUpToDate(`stream-1`, `cursor-abc`)

    // Advance 61 seconds — stale
    vi.setSystemTime(new Date(62_000))
    const cursor = tracker.shouldEnterReplayMode(`stream-1`)
    expect(cursor).toBeNull()
  })

  it(`shouldEnterReplayMode returns null when no entry exists`, () => {
    const tracker = new UpToDateTracker()
    const cursor = tracker.shouldEnterReplayMode(`nonexistent`)
    expect(cursor).toBeNull()
  })

  it(`delete removes entry`, () => {
    const tracker = new UpToDateTracker()
    tracker.recordUpToDate(`stream-1`, `cursor-abc`)
    expect(tracker.shouldEnterReplayMode(`stream-1`)).toBe(`cursor-abc`)

    tracker.delete(`stream-1`)
    expect(tracker.shouldEnterReplayMode(`stream-1`)).toBeNull()
  })

  it(`LRU eviction after 250 entries`, () => {
    const tracker = new UpToDateTracker()
    vi.setSystemTime(new Date(1000))

    // Fill 250 entries
    for (let i = 0; i < 250; i++) {
      tracker.recordUpToDate(`stream-${i}`, `cursor-${i}`)
    }

    // All 250 should be present
    expect(tracker.shouldEnterReplayMode(`stream-0`)).toBe(`cursor-0`)
    expect(tracker.shouldEnterReplayMode(`stream-249`)).toBe(`cursor-249`)

    // Add one more — stream-0 should be evicted (it was the LRU after initial fill,
    // but we just accessed it above so it's no longer LRU. Let's use a fresh tracker.)
    const tracker2 = new UpToDateTracker()
    for (let i = 0; i < 250; i++) {
      tracker2.recordUpToDate(`stream-${i}`, `cursor-${i}`)
    }
    // stream-0 is the oldest (LRU)
    tracker2.recordUpToDate(`stream-new`, `cursor-new`)
    expect(tracker2.shouldEnterReplayMode(`stream-0`)).toBeNull()
    expect(tracker2.shouldEnterReplayMode(`stream-1`)).toBe(`cursor-1`)
    expect(tracker2.shouldEnterReplayMode(`stream-new`)).toBe(`cursor-new`)
  })

  it(`stale entry is cleaned up from storage on access`, () => {
    const storage = new InMemoryUpToDateStorage()
    const tracker = new UpToDateTracker(storage)

    vi.setSystemTime(new Date(1000))
    tracker.recordUpToDate(`stream-1`, `cursor-abc`)
    expect(storage.get(`stream-1`)).not.toBeNull()

    // Advance past TTL
    vi.setSystemTime(new Date(62_000))
    tracker.shouldEnterReplayMode(`stream-1`)
    // Storage entry should have been deleted
    expect(storage.get(`stream-1`)).toBeNull()
  })

  it(`recordUpToDate updates existing entry (cursor and timestamp)`, () => {
    const tracker = new UpToDateTracker()
    vi.setSystemTime(new Date(1000))
    tracker.recordUpToDate(`stream-1`, `cursor-1`)

    vi.setSystemTime(new Date(50_000))
    tracker.recordUpToDate(`stream-1`, `cursor-2`)

    // Should return the new cursor
    expect(tracker.shouldEnterReplayMode(`stream-1`)).toBe(`cursor-2`)

    // And the timestamp should be refreshed — should still be valid at 50s + 59s
    vi.setSystemTime(new Date(109_000))
    expect(tracker.shouldEnterReplayMode(`stream-1`)).toBe(`cursor-2`)

    // But not at 50s + 61s
    vi.setSystemTime(new Date(111_001))
    expect(tracker.shouldEnterReplayMode(`stream-1`)).toBeNull()
  })
})

describe(`InMemoryUpToDateStorage`, () => {
  it(`get returns null for missing key`, () => {
    const storage = new InMemoryUpToDateStorage()
    expect(storage.get(`missing`)).toBeNull()
  })

  it(`set and get round-trip`, () => {
    const storage = new InMemoryUpToDateStorage()
    const value = { cursor: `abc`, timestamp: 12345 }
    storage.set(`key-1`, value)
    expect(storage.get(`key-1`)).toEqual(value)
  })

  it(`delete removes the entry`, () => {
    const storage = new InMemoryUpToDateStorage()
    storage.set(`key-1`, { cursor: `abc`, timestamp: 12345 })
    storage.delete(`key-1`)
    expect(storage.get(`key-1`)).toBeNull()
  })

  it(`set overwrites existing entry`, () => {
    const storage = new InMemoryUpToDateStorage()
    storage.set(`key-1`, { cursor: `old`, timestamp: 1 })
    storage.set(`key-1`, { cursor: `new`, timestamp: 2 })
    expect(storage.get(`key-1`)).toEqual({ cursor: `new`, timestamp: 2 })
  })
})

describe(`LocalStorageUpToDateStorage`, () => {
  let mockStorage: Record<string, string>

  beforeEach(() => {
    mockStorage = {}
    const localStorageMock = {
      getItem: vi.fn((key: string) => mockStorage[key] ?? null),
      setItem: vi.fn((key: string, value: string) => {
        mockStorage[key] = value
      }),
      removeItem: vi.fn((key: string) => {
        delete mockStorage[key]
      }),
    }
    vi.stubGlobal(`localStorage`, localStorageMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it(`get returns null for missing key`, () => {
    const storage = new LocalStorageUpToDateStorage()
    expect(storage.get(`missing`)).toBeNull()
  })

  it(`set and get round-trip`, () => {
    const storage = new LocalStorageUpToDateStorage()
    const value = { cursor: `abc`, timestamp: 12345 }
    storage.set(`key-1`, value)
    expect(storage.get(`key-1`)).toEqual(value)
  })

  it(`uses prefix for localStorage keys`, () => {
    const storage = new LocalStorageUpToDateStorage(`my-prefix-`)
    storage.set(`key-1`, { cursor: `abc`, timestamp: 12345 })
    expect(mockStorage[`my-prefix-key-1`]).toBeDefined()
    expect(mockStorage[`key-1`]).toBeUndefined()
  })

  it(`delete removes the entry`, () => {
    const storage = new LocalStorageUpToDateStorage()
    storage.set(`key-1`, { cursor: `abc`, timestamp: 12345 })
    storage.delete(`key-1`)
    expect(storage.get(`key-1`)).toBeNull()
  })

  it(`get wraps errors in try/catch and returns null`, () => {
    const throwingStorage = {
      getItem: vi.fn(() => {
        throw new Error(`localStorage unavailable`)
      }),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    }
    vi.stubGlobal(`localStorage`, throwingStorage)

    const storage = new LocalStorageUpToDateStorage()
    expect(storage.get(`key`)).toBeNull()
  })

  it(`set wraps errors in try/catch (no throw)`, () => {
    const throwingStorage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(() => {
        throw new Error(`quota exceeded`)
      }),
      removeItem: vi.fn(),
    }
    vi.stubGlobal(`localStorage`, throwingStorage)

    const storage = new LocalStorageUpToDateStorage()
    // Should not throw
    expect(() =>
      storage.set(`key`, { cursor: `abc`, timestamp: 1 })
    ).not.toThrow()
  })

  it(`delete wraps errors in try/catch (no throw)`, () => {
    const throwingStorage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(() => {
        throw new Error(`SSR`)
      }),
    }
    vi.stubGlobal(`localStorage`, throwingStorage)

    const storage = new LocalStorageUpToDateStorage()
    expect(() => storage.delete(`key`)).not.toThrow()
  })
})

describe(`canonicalStreamKey`, () => {
  it(`strips offset param`, () => {
    const key = canonicalStreamKey(
      `https://example.com/stream?offset=5_0&foo=bar`
    )
    expect(key).toBe(`https://example.com/stream?foo=bar`)
  })

  it(`strips cursor param`, () => {
    const key = canonicalStreamKey(
      `https://example.com/stream?cursor=abc&foo=bar`
    )
    expect(key).toBe(`https://example.com/stream?foo=bar`)
  })

  it(`strips live param`, () => {
    const key = canonicalStreamKey(
      `https://example.com/stream?live=long-poll&foo=bar`
    )
    expect(key).toBe(`https://example.com/stream?foo=bar`)
  })

  it(`strips cache_buster param`, () => {
    const key = canonicalStreamKey(
      `https://example.com/stream?cache_buster=123&foo=bar`
    )
    expect(key).toBe(`https://example.com/stream?foo=bar`)
  })

  it(`strips all protocol params at once`, () => {
    const key = canonicalStreamKey(
      `https://example.com/stream?offset=1&cursor=c&live=sse&cache_buster=x&custom=y`
    )
    expect(key).toBe(`https://example.com/stream?custom=y`)
  })

  it(`preserves other params`, () => {
    const key = canonicalStreamKey(
      `https://example.com/stream?table=users&where=active`
    )
    expect(key).toBe(`https://example.com/stream?table=users&where=active`)
  })

  it(`works with URL objects`, () => {
    const url = new URL(`https://example.com/stream?offset=5&table=users`)
    const key = canonicalStreamKey(url)
    expect(key).toBe(`https://example.com/stream?table=users`)
  })

  it(`works with no params`, () => {
    const key = canonicalStreamKey(`https://example.com/stream`)
    expect(key).toBe(`https://example.com/stream`)
  })

  it(`works when only protocol params present`, () => {
    const key = canonicalStreamKey(
      `https://example.com/stream?offset=1&cursor=c&live=sse&cache_buster=x`
    )
    expect(key).toBe(`https://example.com/stream`)
  })
})

// ============================================================================
// Group 4: CDN replay infinite loop prevention (ported from Electric)
// ============================================================================

describe(`CDN replay infinite loop prevention`, () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it(`should not cause infinite suppression — one-shot gate`, () => {
    // This test verifies that after replay mode suppresses one batch,
    // the next identical response should NOT be suppressed (one-shot gate).
    //
    // The ReplayingState transitions to LiveState after the first upToDate
    // batch, regardless of whether it was suppressed. This ensures the
    // suppression is one-shot.
    //
    // Bug scenario (if broken):
    // 1. User had cursor=X in tracker from previous session
    // 2. CDN returns cursor=X on first request (suppressed — replay mode)
    // 3. CDN returns cursor=X again on second request
    // 4. If still in replay mode, this would also be suppressed -> infinite loop
    //
    // Correct behavior:
    // 1. First batch with matching cursor: suppressed, transitions to LiveState
    // 2. Second batch: LiveState does not suppress anything

    const state = new ReplayingState(
      {
        offset: `5_0`,
        cursor: `old-cursor`,
        upToDate: false,
        streamClosed: false,
      },
      `replay-cursor-match`
    )

    // First upToDate batch with matching cursor -> suppressed, transitions to LiveState
    const result1 = state.handleMessageBatch({
      hasMessages: true,
      hasUpToDateMessage: true,
      isSse: false,
      currentCursor: `replay-cursor-match`,
    })
    expect(result1.suppressBatch).toBe(true)
    expect(result1.becameUpToDate).toBe(true)
    expect(result1.state).toBeInstanceOf(LiveState)

    // Second identical batch on the LiveState -> NOT suppressed
    const liveState = result1.state
    const result2 = liveState.handleMessageBatch({
      hasMessages: true,
      hasUpToDateMessage: false,
      isSse: false,
      currentCursor: `replay-cursor-match`,
    })
    expect(result2.suppressBatch).toBe(false)
  })
})
