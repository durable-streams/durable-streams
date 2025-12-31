import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { warnIfUsingHttpInBrowser } from "../src/index"

describe(`warnIfUsingHttpInBrowser`, () => {
  let originalWindow: typeof globalThis.window
  let originalConsole: typeof globalThis.console
  let originalProcess: typeof globalThis.process
  let consoleWarnSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    // Save original globals
    originalWindow = globalThis.window
    originalConsole = globalThis.console
    originalProcess = globalThis.process

    // Create a mock console.warn
    consoleWarnSpy = vi.fn()
  })

  afterEach(() => {
    // Restore original globals
    globalThis.window = originalWindow
    globalThis.console = originalConsole
    globalThis.process = originalProcess
  })

  describe(`in browser environment`, () => {
    beforeEach(() => {
      // Mock browser environment
      // @ts-expect-error - mocking window
      globalThis.window = {}
      globalThis.console = {
        ...console,
        warn: consoleWarnSpy,
      }
      // Remove NODE_ENV=test check
      // @ts-expect-error - mocking process
      globalThis.process = { env: {} }
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
        expect.stringContaining(`6 concurrent connections`)
      )
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining(`https://bit.ly/streams-http2`)
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
      // @ts-expect-error - removing window
      delete globalThis.window
      globalThis.console = {
        ...console,
        warn: consoleWarnSpy,
      }
      // @ts-expect-error - mocking process
      globalThis.process = { env: {} }
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
      globalThis.window = {}
      globalThis.console = {
        ...console,
        warn: consoleWarnSpy,
      }
      // Set NODE_ENV=test
      // @ts-expect-error - mocking process
      globalThis.process = { env: { NODE_ENV: `test` } }
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
      globalThis.window = {}
      // @ts-expect-error - mocking console without warn
      globalThis.console = {}
      // @ts-expect-error - mocking process
      globalThis.process = { env: {} }
    })

    it(`should not throw when console.warn is not available`, () => {
      expect(() => {
        warnIfUsingHttpInBrowser(`http://example.com/stream`)
      }).not.toThrow()
    })
  })
})
