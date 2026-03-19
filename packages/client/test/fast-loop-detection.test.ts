import { describe, expect, it, vi } from "vitest"
import { FastLoopDetector } from "../src/fast-loop-detection"

describe(`FastLoopDetector`, () => {
  it(`returns ok for requests at different offsets`, () => {
    const detector = new FastLoopDetector()
    expect(detector.check(`0_0`).action).toBe(`ok`)
    expect(detector.check(`1_0`).action).toBe(`ok`)
    expect(detector.check(`2_0`).action).toBe(`ok`)
  })

  it(`returns ok when same offset but under threshold`, () => {
    const detector = new FastLoopDetector({ threshold: 5 })
    for (let i = 0; i < 4; i++) {
      expect(detector.check(`0_0`).action).toBe(`ok`)
    }
  })

  it(`returns clear-and-reset on first detection`, () => {
    const detector = new FastLoopDetector({ threshold: 5, windowMs: 10000 })
    for (let i = 0; i < 4; i++) {
      detector.check(`0_0`)
    }
    const result = detector.check(`0_0`)
    expect(result.action).toBe(`clear-and-reset`)
  })

  it(`returns backoff on detections 2-4`, () => {
    const detector = new FastLoopDetector({ threshold: 5, windowMs: 10000 })
    // First detection
    for (let i = 0; i < 5; i++) detector.check(`0_0`)
    // Second detection
    for (let i = 0; i < 5; i++) detector.check(`0_0`)
    const result = detector.check(`0_0`)
    // Should be backoff (consecutiveCount === 2, not yet fatal)
    // Actually, after clear-and-reset clears entries, need 5 more
    // The exact flow: 5 checks → clear-and-reset (entries cleared, count=1)
    // Then 5 more checks → count=2 → backoff
    expect(result.action).toBe(`backoff`)
  })

  it(`returns fatal after maxCount detections`, () => {
    const detector = new FastLoopDetector({
      threshold: 5,
      windowMs: 10000,
      maxCount: 5,
    })
    // Drive enough checks to exhaust maxCount detections
    let fatalReturned = false
    for (let i = 0; i < 30; i++) {
      const result = detector.check(`0_0`)
      if (result.action === `fatal`) {
        fatalReturned = true
        break
      }
    }
    expect(fatalReturned).toBe(true)
  })

  it(`reset clears all state`, () => {
    const detector = new FastLoopDetector({ threshold: 5, windowMs: 10000 })
    for (let i = 0; i < 4; i++) detector.check(`0_0`)
    detector.reset()
    // After reset, should be back to ok
    expect(detector.check(`0_0`).action).toBe(`ok`)
  })

  it(`prunes entries older than window`, () => {
    vi.useFakeTimers()
    const detector = new FastLoopDetector({ threshold: 5, windowMs: 500 })
    for (let i = 0; i < 4; i++) detector.check(`0_0`)
    // Advance past window
    vi.advanceTimersByTime(600)
    // Old entries pruned, starts fresh
    expect(detector.check(`0_0`).action).toBe(`ok`)
    vi.useRealTimers()
  })
})

// ============================================================================
// Group 6: Backoff zero-delay test (should FAIL — exposing bug)
// ============================================================================

describe(`backoff delay minimum floor`, () => {
  // EXPECTED TO FAIL — exposes bug #11
  // The backoff delay calculation uses `Math.floor(Math.random() * maxDelay)`.
  // When Math.random() returns a very small value (close to 0), the delay can be 0ms,
  // effectively turning the backoff into no delay at all.
  //
  // The delay should always be >= backoffBaseMs to ensure meaningful backoff.
  it.fails(`backoff delay should have a minimum floor`, () => {
    // Mock Math.random to return a very small value
    const originalRandom = Math.random
    Math.random = () => 0.0001

    try {
      const detector = new FastLoopDetector({
        threshold: 3,
        windowMs: 10000,
        maxCount: 10,
        backoffBaseMs: 100,
        backoffMaxMs: 5000,
      })

      // Drive to first detection (clear-and-reset at consecutiveCount=1)
      for (let i = 0; i < 3; i++) detector.check(`0_0`)

      // Drive to second detection (backoff at consecutiveCount=2)
      for (let i = 0; i < 3; i++) detector.check(`0_0`)
      const result = detector.check(`0_0`)

      expect(result.action).toBe(`backoff`)
      if (result.action === `backoff`) {
        // BUG: With Math.random() returning 0.0001, the delay calculation is:
        //   maxDelay = min(5000, 100 * 2^2) = 400
        //   delayMs = floor(0.0001 * 400) = floor(0.04) = 0
        //
        // A delay of 0ms defeats the purpose of backoff.
        // Expected: delay should be at least backoffBaseMs (100ms)
        expect(result.delayMs).toBeGreaterThanOrEqual(100)
      }
    } finally {
      Math.random = originalRandom
    }
  })
})
