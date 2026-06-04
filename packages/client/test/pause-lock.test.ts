import { describe, expect, it, vi } from "vitest"
import { PauseLock } from "../src/pause-lock"

describe(`PauseLock`, () => {
  it(`starts unpaused`, () => {
    const lock = new PauseLock({ onAcquired: vi.fn(), onReleased: vi.fn() })
    expect(lock.isPaused).toBe(false)
  })

  it(`fires onAcquired on 0→1 transition`, () => {
    const onAcquired = vi.fn()
    const lock = new PauseLock({ onAcquired, onReleased: vi.fn() })
    lock.acquire(`visibility`)
    expect(lock.isPaused).toBe(true)
    expect(onAcquired).toHaveBeenCalledTimes(1)
  })

  it(`does not fire onAcquired on 1→2 transition`, () => {
    const onAcquired = vi.fn()
    const lock = new PauseLock({ onAcquired, onReleased: vi.fn() })
    lock.acquire(`visibility`)
    lock.acquire(`snapshot-1`)
    expect(onAcquired).toHaveBeenCalledTimes(1)
  })

  it(`fires onReleased on 1→0 transition`, () => {
    const onReleased = vi.fn()
    const lock = new PauseLock({ onAcquired: vi.fn(), onReleased })
    lock.acquire(`visibility`)
    lock.release(`visibility`)
    expect(lock.isPaused).toBe(false)
    expect(onReleased).toHaveBeenCalledTimes(1)
  })

  it(`does not fire onReleased on 2→1 transition`, () => {
    const onReleased = vi.fn()
    const lock = new PauseLock({ onAcquired: vi.fn(), onReleased })
    lock.acquire(`visibility`)
    lock.acquire(`snapshot-1`)
    lock.release(`visibility`)
    expect(lock.isPaused).toBe(true)
    expect(onReleased).not.toHaveBeenCalled()
  })

  it(`warns on duplicate acquire`, () => {
    const warn = vi.spyOn(console, `warn`).mockImplementation(() => {})
    const lock = new PauseLock({ onAcquired: vi.fn(), onReleased: vi.fn() })
    lock.acquire(`visibility`)
    lock.acquire(`visibility`)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it(`warns on orphan release`, () => {
    const warn = vi.spyOn(console, `warn`).mockImplementation(() => {})
    const lock = new PauseLock({ onAcquired: vi.fn(), onReleased: vi.fn() })
    lock.release(`never-acquired`)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it(`isHeldBy returns correct state`, () => {
    const lock = new PauseLock({ onAcquired: vi.fn(), onReleased: vi.fn() })
    lock.acquire(`visibility`)
    expect(lock.isHeldBy(`visibility`)).toBe(true)
    expect(lock.isHeldBy(`other`)).toBe(false)
  })

  it(`releaseAllMatching removes matching holders`, () => {
    const onReleased = vi.fn()
    const lock = new PauseLock({ onAcquired: vi.fn(), onReleased })
    lock.acquire(`snapshot-1`)
    lock.acquire(`snapshot-2`)
    lock.acquire(`visibility`)
    lock.releaseAllMatching(`snapshot-`)
    expect(lock.isPaused).toBe(true)
    expect(lock.isHeldBy(`snapshot-1`)).toBe(false)
    expect(lock.isHeldBy(`snapshot-2`)).toBe(false)
  })

  it(`releaseAllMatching fires onReleased when last holder removed`, () => {
    const onReleased = vi.fn()
    const lock = new PauseLock({ onAcquired: vi.fn(), onReleased })
    lock.acquire(`snapshot-1`)
    lock.releaseAllMatching(`snapshot-`)
    expect(onReleased).toHaveBeenCalledTimes(1)
  })

  it(`releaseAllMatching does not fire onReleased when no matching holders`, () => {
    const onReleased = vi.fn()
    const lock = new PauseLock({ onAcquired: vi.fn(), onReleased })
    lock.acquire(`visibility`)
    lock.releaseAllMatching(`snapshot-`)
    expect(onReleased).not.toHaveBeenCalled()
    expect(lock.isPaused).toBe(true)
  })

  it.fails(
    `releaseAllMatching should not fire onReleased (Electric behavior)`,
    () => {
      const onReleased = vi.fn()
      const lock = new PauseLock({ onAcquired: vi.fn(), onReleased })
      lock.acquire(`snapshot-1`)
      lock.acquire(`snapshot-2`)

      // releaseAllMatching should silently remove holders without firing callback
      // (Electric behavior — prevents race condition during active request loop)
      lock.releaseAllMatching(`snapshot-`)

      // onReleased should NOT have been called
      expect(onReleased).not.toHaveBeenCalled()
      // But isPaused should be false (holders were removed)
      expect(lock.isPaused).toBe(false)
    }
  )
})
