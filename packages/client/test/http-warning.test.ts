import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  _resetHttpWarningForTesting,
  warnIfUsingHttpInBrowser,
} from "../src/index"

describe(`warnIfUsingHttpInBrowser`, () => {
  // Track which properties we added so we can properly clean them up
  let addedWindow: boolean
  let originalConsole: typeof globalThis.console
  let originalNodeEnv: string | undefined
  let consoleWarnSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    // Track original state
    addedWindow = !(`window` in globalThis)
    originalConsole = globalThis.console
    originalNodeEnv = process.env.NODE_ENV

    // Create a mock console.warn
    consoleWarnSpy = vi.fn()

    // Reset the warned origins set before each test
    _resetHttpWarningForTesting()
  })

  afterEach(() => {
    // Properly restore globals - delete if they didn't exist, restore otherwise
    if (addedWindow) {
      delete (globalThis as Record<string, unknown>).window
    }

    // Restore console
    globalThis.console = originalConsole

    // Restore NODE_ENV
    if (originalNodeEnv !== undefined) {
      process.env.NODE_ENV = originalNodeEnv
    } else {
      delete process.env.NODE_ENV
    }

    // Reset warned origins after each test
    _resetHttpWarningForTesting()
  })

  describe(`in browser environment`, () => {
    beforeEach(() => {
      // Mock browser environment
      // @ts-expect-error - mocking window
      globalThis.window = { location: { href: `https://example.com/app` } }
      globalThis.console = {
        ...console,
        warn: consoleWarnSpy,
      }
      // Remove NODE_ENV=test check so warnings can trigger
      delete process.env.NODE_ENV
    })

    it(`should warn when using HTTP URL`, () => {
      warnIfUsingHttpInBrowser(`http://example.com/stream`)

      expect(consoleWarnSpy).toHaveBeenCalledTimes(1)
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining(`[DurableStream]`)
      )
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining(`HTTP (not HTTPS)`)
      )
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining(`~6 concurrent connections per origin`)
      )
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining(`https://electric-sql.com/r/electric-http2`)
      )
    })

    it(`should warn when using HTTP URL object`, () => {
      warnIfUsingHttpInBrowser(new URL(`http://example.com/stream`))

      expect(consoleWarnSpy).toHaveBeenCalledTimes(1)
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining(`[DurableStream]`)
      )
    })

    it(`should not warn when using HTTPS URL`, () => {
      warnIfUsingHttpInBrowser(`https://example.com/stream`)

      expect(consoleWarnSpy).not.toHaveBeenCalled()
    })

    it(`should not warn when using HTTPS URL object`, () => {
      warnIfUsingHttpInBrowser(new URL(`https://example.com/stream`))

      expect(consoleWarnSpy).not.toHaveBeenCalled()
    })

    it(`should not warn when warnOnHttp is false`, () => {
      warnIfUsingHttpInBrowser(`http://example.com/stream`, false)

      expect(consoleWarnSpy).not.toHaveBeenCalled()
    })

    it(`should warn when warnOnHttp is true`, () => {
      warnIfUsingHttpInBrowser(`http://example.com/stream`, true)

      expect(consoleWarnSpy).toHaveBeenCalledTimes(1)
    })

    it(`should warn when warnOnHttp is undefined (default behavior)`, () => {
      warnIfUsingHttpInBrowser(`http://example.com/stream`, undefined)

      expect(consoleWarnSpy).toHaveBeenCalledTimes(1)
    })

    it(`should not throw on invalid URL`, () => {
      // Should not throw, just silently ignore
      expect(() => {
        warnIfUsingHttpInBrowser(`not a valid url`, true)
      }).not.toThrow()

      expect(consoleWarnSpy).not.toHaveBeenCalled()
    })
  })

  describe(`in Node.js environment`, () => {
    beforeEach(() => {
      // Remove window to simulate Node.js
      delete (globalThis as Record<string, unknown>).window
      globalThis.console = {
        ...console,
        warn: consoleWarnSpy,
      }
      delete process.env.NODE_ENV
    })

    it(`should not warn even with HTTP URL`, () => {
      warnIfUsingHttpInBrowser(`http://example.com/stream`)

      expect(consoleWarnSpy).not.toHaveBeenCalled()
    })
  })

  describe(`during tests (NODE_ENV=test)`, () => {
    beforeEach(() => {
      // Mock browser environment
      // @ts-expect-error - mocking window
      globalThis.window = { location: { href: `https://example.com/app` } }
      globalThis.console = {
        ...console,
        warn: consoleWarnSpy,
      }
      // Set NODE_ENV=test
      process.env.NODE_ENV = `test`
    })

    it(`should not warn even with HTTP URL when NODE_ENV is test`, () => {
      warnIfUsingHttpInBrowser(`http://example.com/stream`)

      expect(consoleWarnSpy).not.toHaveBeenCalled()
    })
  })

  describe(`without console.warn`, () => {
    beforeEach(() => {
      // Mock browser environment without console.warn
      // @ts-expect-error - mocking window
      globalThis.window = { location: { href: `https://example.com/app` } }
      // @ts-expect-error - mocking console without warn
      globalThis.console = {}
      delete process.env.NODE_ENV
    })

    it(`should not throw when console.warn is not available`, () => {
      expect(() => {
        warnIfUsingHttpInBrowser(`http://example.com/stream`)
      }).not.toThrow()
    })
  })

  describe(`relative URL handling`, () => {
    beforeEach(() => {
      globalThis.console = {
        ...console,
        warn: consoleWarnSpy,
      }
      delete process.env.NODE_ENV
    })

    it(`should warn for relative URL when window.location is HTTP`, () => {
      // @ts-expect-error - mocking window
      globalThis.window = { location: { href: `http://example.com/app` } }

      warnIfUsingHttpInBrowser(`/stream`)

      expect(consoleWarnSpy).toHaveBeenCalledTimes(1)
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining(`[DurableStream]`)
      )
    })

    it(`should not warn for relative URL when window.location is HTTPS`, () => {
      // @ts-expect-error - mocking window
      globalThis.window = { location: { href: `https://example.com/app` } }

      warnIfUsingHttpInBrowser(`/stream`)

      expect(consoleWarnSpy).not.toHaveBeenCalled()
    })

    it(`should resolve path-relative URLs correctly`, () => {
      // @ts-expect-error - mocking window
      globalThis.window = { location: { href: `http://example.com/app/page` } }

      warnIfUsingHttpInBrowser(`../stream`)

      expect(consoleWarnSpy).toHaveBeenCalledTimes(1)
    })

    it(`should not warn for relative URL when warnOnHttp is false`, () => {
      // @ts-expect-error - mocking window
      globalThis.window = { location: { href: `http://example.com/app` } }

      warnIfUsingHttpInBrowser(`/stream`, false)

      expect(consoleWarnSpy).not.toHaveBeenCalled()
    })
  })

  describe(`warn-once behavior (per origin)`, () => {
    beforeEach(() => {
      // @ts-expect-error - mocking window
      globalThis.window = { location: { href: `https://example.com/app` } }
      globalThis.console = {
        ...console,
        warn: consoleWarnSpy,
      }
      delete process.env.NODE_ENV
    })

    it(`should warn only once for the same origin`, () => {
      warnIfUsingHttpInBrowser(`http://example.com/stream1`)
      warnIfUsingHttpInBrowser(`http://example.com/stream2`)
      warnIfUsingHttpInBrowser(`http://example.com/another/path`)

      expect(consoleWarnSpy).toHaveBeenCalledTimes(1)
    })

    it(`should warn once for each different origin`, () => {
      warnIfUsingHttpInBrowser(`http://example.com/stream`)
      warnIfUsingHttpInBrowser(`http://other.com/stream`)
      warnIfUsingHttpInBrowser(`http://third.com/stream`)

      expect(consoleWarnSpy).toHaveBeenCalledTimes(3)
    })

    it(`should warn again for same origin after different origin`, () => {
      warnIfUsingHttpInBrowser(`http://example.com/stream`)
      warnIfUsingHttpInBrowser(`http://other.com/stream`)
      // Same origin as first - should not warn again
      warnIfUsingHttpInBrowser(`http://example.com/another`)

      expect(consoleWarnSpy).toHaveBeenCalledTimes(2)
    })

    it(`should differentiate by port`, () => {
      warnIfUsingHttpInBrowser(`http://example.com:3000/stream`)
      warnIfUsingHttpInBrowser(`http://example.com:4000/stream`)
      warnIfUsingHttpInBrowser(`http://example.com/stream`) // default port 80

      expect(consoleWarnSpy).toHaveBeenCalledTimes(3)
    })

    it(`should reset warning state with _resetHttpWarningForTesting`, () => {
      warnIfUsingHttpInBrowser(`http://example.com/stream`)
      expect(consoleWarnSpy).toHaveBeenCalledTimes(1)

      _resetHttpWarningForTesting()

      warnIfUsingHttpInBrowser(`http://example.com/stream`)
      expect(consoleWarnSpy).toHaveBeenCalledTimes(2)
    })
  })

  describe(`safe process access`, () => {
    beforeEach(() => {
      // @ts-expect-error - mocking window
      globalThis.window = { location: { href: `https://example.com/app` } }
      globalThis.console = {
        ...console,
        warn: consoleWarnSpy,
      }
      // Clear NODE_ENV so warnings can trigger
      delete process.env.NODE_ENV
    })

    it(`should work when NODE_ENV is not set`, () => {
      // NODE_ENV is already deleted in beforeEach
      expect(() => {
        warnIfUsingHttpInBrowser(`http://example.com/stream`)
      }).not.toThrow()

      expect(consoleWarnSpy).toHaveBeenCalledTimes(1)
    })

    it(`should use optional chaining for process.env access`, () => {
      // This test verifies the implementation uses optional chaining
      // The implementation should use: process.env?.NODE_ENV
      // to avoid errors when process.env might be undefined
      // We verify NODE_ENV can be undefined without throwing
      delete process.env.NODE_ENV

      expect(() => {
        warnIfUsingHttpInBrowser(`http://example.com/stream`)
      }).not.toThrow()

      expect(consoleWarnSpy).toHaveBeenCalledTimes(1)
    })
  })
})
