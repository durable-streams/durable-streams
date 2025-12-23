import { describe, expect, it } from "vitest"
import { asAsyncIterableReadableStream } from "../src/asyncIterableReadableStream"
import type { ReadableStreamAsyncIterable } from "../src/asyncIterableReadableStream"

describe(`asAsyncIterableReadableStream`, () => {
  describe(`adds async iterator when missing`, () => {
    it(`should add [Symbol.asyncIterator] to a stream without one`, () => {
      // Create a basic ReadableStream
      const stream = new ReadableStream<number>({
        start(controller) {
          controller.enqueue(1)
          controller.close()
        },
      })

      // Simulate environment without native async iterator by deleting it
      // Note: In modern environments this may already exist, but we test the function works
      const originalIterator = (stream as unknown as Record<symbol, unknown>)[
        Symbol.asyncIterator
      ]

      // If no iterator exists, asAsyncIterableReadableStream should add one
      const result = asAsyncIterableReadableStream(stream)

      // After calling, the stream should have an async iterator
      expect(
        typeof (result as unknown as Record<symbol, unknown>)[
          Symbol.asyncIterator
        ]
      ).toBe(`function`)

      // Result should be the same object (not wrapped)
      expect(result).toBe(stream)

      // If there was an original iterator, it should be preserved
      if (originalIterator !== undefined) {
        expect(
          (result as unknown as Record<symbol, unknown>)[Symbol.asyncIterator]
        ).toBe(originalIterator)
      }
    })

    it(`should not overwrite an existing async iterator`, () => {
      // Create a stream with a custom async iterator marker
      const stream = new ReadableStream<number>({
        start(controller) {
          controller.enqueue(1)
          controller.close()
        },
      })

      // Get the original iterator (if any) or define a custom one
      const hasNativeIterator =
        typeof (stream as unknown as Record<symbol, unknown>)[
          Symbol.asyncIterator
        ] === `function`

      if (hasNativeIterator) {
        const originalIterator = (stream as unknown as Record<symbol, unknown>)[
          Symbol.asyncIterator
        ]

        // Call the helper
        const result = asAsyncIterableReadableStream(stream)

        // Should preserve the original iterator
        expect(
          (result as unknown as Record<symbol, unknown>)[Symbol.asyncIterator]
        ).toBe(originalIterator)
      } else {
        // If no native iterator, add a custom one first
        const customIterator = function () {
          return { custom: true }
        }
        Object.defineProperty(stream, Symbol.asyncIterator, {
          value: customIterator,
          configurable: true,
        })

        // Call the helper
        const result = asAsyncIterableReadableStream(stream)

        // Should preserve the custom iterator
        expect(
          (result as unknown as Record<symbol, unknown>)[Symbol.asyncIterator]
        ).toBe(customIterator)
      }
    })
  })

  describe(`iteration yields expected chunks`, () => {
    it(`should yield all chunks from the stream via for await`, async () => {
      // Create a ReadableStream that enqueues 1, 2, 3 then closes
      const stream = new ReadableStream<number>({
        start(controller) {
          controller.enqueue(1)
          controller.enqueue(2)
          controller.enqueue(3)
          controller.close()
        },
      })

      const result = asAsyncIterableReadableStream(stream)
      const collected: Array<number> = []

      for await (const chunk of result) {
        collected.push(chunk)
      }

      expect(collected).toEqual([1, 2, 3])
    })

    it(`should work with string chunks`, async () => {
      const stream = new ReadableStream<string>({
        start(controller) {
          controller.enqueue(`hello`)
          controller.enqueue(` `)
          controller.enqueue(`world`)
          controller.close()
        },
      })

      const result = asAsyncIterableReadableStream(stream)
      const collected: Array<string> = []

      for await (const chunk of result) {
        collected.push(chunk)
      }

      expect(collected).toEqual([`hello`, ` `, `world`])
    })

    it(`should work with Uint8Array chunks`, async () => {
      const chunk1 = new Uint8Array([1, 2, 3])
      const chunk2 = new Uint8Array([4, 5, 6])

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(chunk1)
          controller.enqueue(chunk2)
          controller.close()
        },
      })

      const result = asAsyncIterableReadableStream(stream)
      const collected: Array<Uint8Array> = []

      for await (const chunk of result) {
        collected.push(chunk)
      }

      expect(collected).toHaveLength(2)
      expect(collected[0]).toEqual(chunk1)
      expect(collected[1]).toEqual(chunk2)
    })

    it(`should handle empty streams`, async () => {
      const stream = new ReadableStream<number>({
        start(controller) {
          controller.close()
        },
      })

      const result = asAsyncIterableReadableStream(stream)
      const collected: Array<number> = []

      for await (const chunk of result) {
        collected.push(chunk)
      }

      expect(collected).toEqual([])
    })
  })

  describe(`preserves instanceof`, () => {
    it(`should return the same object (not wrapped)`, () => {
      const stream = new ReadableStream<number>({
        start(controller) {
          controller.enqueue(1)
          controller.close()
        },
      })

      const result = asAsyncIterableReadableStream(stream)

      // Result should be the exact same object
      expect(result).toBe(stream)
    })

    it(`should preserve instanceof ReadableStream`, () => {
      const stream = new ReadableStream<number>({
        start(controller) {
          controller.enqueue(1)
          controller.close()
        },
      })

      const result = asAsyncIterableReadableStream(stream)

      // Should still be an instanceof ReadableStream
      expect(result instanceof ReadableStream).toBe(true)
    })
  })

  describe(`early break calls cancel`, () => {
    it(`should release lock and cancel when breaking early`, async () => {
      let cancelCalled = false

      const stream = new ReadableStream<number>({
        start(controller) {
          controller.enqueue(1)
          controller.enqueue(2)
          controller.enqueue(3)
          controller.enqueue(4)
          controller.enqueue(5)
          // Note: we don't close immediately to simulate an infinite stream
        },
        cancel() {
          cancelCalled = true
        },
      })

      const result = asAsyncIterableReadableStream(stream)
      const collected: Array<number> = []

      for await (const chunk of result) {
        collected.push(chunk)
        if (collected.length >= 2) {
          break // Early exit after 2 items
        }
      }

      // Should have collected only 2 items
      expect(collected).toEqual([1, 2])

      // Wait a tick to ensure cleanup happened
      await new Promise((resolve) => setTimeout(resolve, 0))

      // Cancel should have been called (the iterator's return() method is called on break)
      expect(cancelCalled).toBe(true)
    })

    it(`should handle throw during iteration`, async () => {
      let cancelCalled = false

      const stream = new ReadableStream<number>({
        start(controller) {
          controller.enqueue(1)
          controller.enqueue(2)
          controller.enqueue(3)
        },
        cancel() {
          cancelCalled = true
        },
      })

      const result = asAsyncIterableReadableStream(stream)
      const collected: Array<number> = []

      try {
        for await (const chunk of result) {
          collected.push(chunk)
          if (collected.length >= 2) {
            throw new Error(`Test error`)
          }
        }
      } catch (e) {
        expect((e as Error).message).toBe(`Test error`)
      }

      // Should have collected only 2 items before error
      expect(collected).toEqual([1, 2])

      // Wait a tick to ensure cleanup happened
      await new Promise((resolve) => setTimeout(resolve, 0))

      // Cancel should have been called
      expect(cancelCalled).toBe(true)
    })
  })

  describe(`type safety`, () => {
    it(`should return a type that is both ReadableStream and AsyncIterable`, () => {
      const stream = new ReadableStream<string>({
        start(controller) {
          controller.enqueue(`test`)
          controller.close()
        },
      })

      const result: ReadableStreamAsyncIterable<string> =
        asAsyncIterableReadableStream(stream)

      // Type should allow both ReadableStream methods...
      expect(typeof result.getReader).toBe(`function`)
      expect(typeof result.pipeTo).toBe(`function`)
      expect(typeof result.pipeThrough).toBe(`function`)

      // ...and AsyncIterable methods
      expect(typeof result[Symbol.asyncIterator]).toBe(`function`)
    })
  })

  describe(`multiple iterations`, () => {
    it(`should not yield any more data after first consumption`, async () => {
      const stream = new ReadableStream<number>({
        start(controller) {
          controller.enqueue(1)
          controller.enqueue(2)
          controller.enqueue(3)
          controller.close()
        },
      })

      const result = asAsyncIterableReadableStream(stream)

      // First iteration should work
      const collected1: Array<number> = []
      for await (const chunk of result) {
        collected1.push(chunk)
      }
      expect(collected1).toEqual([1, 2, 3])

      // Second iteration should throw because the stream lock was not released
      // and trying to get a new reader will fail
      try {
        const collected2: Array<number> = []
        for await (const chunk of result) {
          collected2.push(chunk)
        }
        // If we get here, the iteration completed without throwing
        // This is fine - it just means the stream was already consumed
        expect(collected2).toEqual([])
      } catch (e) {
        // Expected: "Cannot read from a locked ReadableStream" or similar
        expect(e).toBeInstanceOf(TypeError)
      }
    })
  })

  describe(`error during read() releases lock`, () => {
    it(`should release lock and rethrow when read() errors`, async () => {
      const testError = new Error(`Stream read error`)
      let readCount = 0

      const stream = new ReadableStream<number>({
        pull(controller) {
          readCount++
          if (readCount === 1) {
            controller.enqueue(1)
          } else {
            controller.error(testError)
          }
        },
      })

      const result = asAsyncIterableReadableStream(stream)
      const collected: Array<number> = []
      let caughtError: Error | null = null

      try {
        for await (const chunk of result) {
          collected.push(chunk)
        }
      } catch (e) {
        caughtError = e as Error
      }

      // Should have collected the first chunk before error
      expect(collected).toEqual([1])

      // Error should be rethrown
      expect(caughtError).toBe(testError)

      // The stream should now be unlocked - verify by trying to get a new reader
      // (This would throw if the lock wasn't released)
      expect(() => stream.getReader()).not.toThrow()
    })
  })

  describe(`no global prototype mutation`, () => {
    it(`should not modify ReadableStream.prototype`, () => {
      // Capture original prototype state
      const originalPrototype = Object.getOwnPropertyNames(
        ReadableStream.prototype
      )
      const originalAsyncIterator = Object.getOwnPropertyDescriptor(
        ReadableStream.prototype,
        Symbol.asyncIterator
      )

      // Create and process a stream
      const stream = new ReadableStream<number>({
        start(controller) {
          controller.enqueue(1)
          controller.close()
        },
      })
      asAsyncIterableReadableStream(stream)

      // Verify prototype wasn't modified
      const newPrototype = Object.getOwnPropertyNames(ReadableStream.prototype)
      expect(newPrototype).toEqual(originalPrototype)

      const newAsyncIterator = Object.getOwnPropertyDescriptor(
        ReadableStream.prototype,
        Symbol.asyncIterator
      )
      expect(newAsyncIterator).toEqual(originalAsyncIterator)
    })

    it(`should only add async iterator to the specific instance`, () => {
      const stream1 = new ReadableStream<number>({
        start(controller) {
          controller.enqueue(1)
          controller.close()
        },
      })

      const stream2 = new ReadableStream<number>({
        start(controller) {
          controller.enqueue(2)
          controller.close()
        },
      })

      // Check if native async iterator exists on prototype
      const hasNativeIterator =
        typeof ReadableStream.prototype[
          Symbol.asyncIterator as keyof ReadableStream
        ] === `function`

      // Process only stream1
      asAsyncIterableReadableStream(stream1)

      // If there's no native iterator, stream1 should have it as an own property
      // If there IS a native iterator, we don't add our own
      if (!hasNativeIterator) {
        expect(
          Object.prototype.hasOwnProperty.call(stream1, Symbol.asyncIterator)
        ).toBe(true)

        // stream2 should NOT have the iterator as an own property
        // (we didn't process it, and there's no native one)
        expect(
          Object.prototype.hasOwnProperty.call(stream2, Symbol.asyncIterator)
        ).toBe(false)
      } else {
        // Native iterator exists - we don't add our own, so neither should have own property
        // Both inherit from prototype
        expect(typeof stream1[Symbol.asyncIterator]).toBe(`function`)
        expect(typeof stream2[Symbol.asyncIterator]).toBe(`function`)
      }
    })
  })

  describe(`concurrent reads handling`, () => {
    // These tests validate our polyfill behavior. In environments with native
    // async iterators (like Node.js), we skip these since our polyfill isn't applied.

    const hasNativeIterator = (() => {
      const testStream = new ReadableStream<number>()
      return (
        typeof (testStream as unknown as Record<symbol, unknown>)[
          Symbol.asyncIterator
        ] === `function`
      )
    })()

    it.skipIf(hasNativeIterator)(
      `should correctly track multiple concurrent pending reads (polyfill only)`,
      async () => {
        // Create a slow stream that can be read from multiple times concurrently
        let resolveChunk: ((value: number) => void) | null = null
        const stream = new ReadableStream<number>({
          async pull(controller) {
            // Wait for external resolution
            const value = await new Promise<number>((resolve) => {
              resolveChunk = resolve
            })
            controller.enqueue(value)
          },
        })

        const result = asAsyncIterableReadableStream(stream)
        const iterator = result[Symbol.asyncIterator]()

        // Start first read (will be pending)
        const read1Promise = iterator.next()

        // Attempting return() while read is pending should throw
        await expect(iterator.return!()).rejects.toThrow(TypeError)

        // Now resolve the pending read
        resolveChunk!(1)
        const read1Result = await read1Promise
        expect(read1Result.value).toBe(1)

        // After read completes, return() should work
        await expect(iterator.return!()).resolves.toEqual({
          done: true,
          value: undefined,
        })
      }
    )

    it.skipIf(hasNativeIterator)(
      `should handle return() rejecting with TypeError if there are pending reads (polyfill only)`,
      async () => {
        let enqueuedCount = 0
        const stream = new ReadableStream<number>({
          async pull(controller) {
            enqueuedCount++
            // Simulate async delay
            await new Promise((resolve) => setTimeout(resolve, 10))
            controller.enqueue(enqueuedCount)
          },
        })

        const result = asAsyncIterableReadableStream(stream)
        const iterator = result[Symbol.asyncIterator]()

        // Start a read but don't await it
        const readPromise = iterator.next()

        // Try to return while read is pending - should reject
        try {
          await iterator.return!()
          // If we get here, something is wrong
          expect(true).toBe(false)
        } catch (e) {
          expect(e).toBeInstanceOf(TypeError)
          expect((e as TypeError).message).toContain(`pending read requests`)
        }

        // Clean up - await the pending read
        await readPromise
        await iterator.return!()
      }
    )
  })

  describe(`.values() method`, () => {
    it(`should define .values() method on the instance`, () => {
      const stream = new ReadableStream<number>({
        start(controller) {
          controller.enqueue(1)
          controller.close()
        },
      })

      // Check if native .values() exists
      const hasNativeValues =
        typeof (stream as unknown as Record<string, unknown>)[`values`] ===
        `function`

      const result = asAsyncIterableReadableStream(stream)

      // values() should be available
      expect(
        typeof (result as unknown as Record<string, unknown>)[`values`]
      ).toBe(`function`)

      // If there was no native values(), it should be our own property
      if (!hasNativeValues) {
        expect(Object.prototype.hasOwnProperty.call(result, `values`)).toBe(
          true
        )
      }
    })

    it(`should allow iteration via .values()`, async () => {
      const stream = new ReadableStream<number>({
        start(controller) {
          controller.enqueue(1)
          controller.enqueue(2)
          controller.enqueue(3)
          controller.close()
        },
      })

      const result = asAsyncIterableReadableStream(stream)
      const valuesMethod = (
        result as unknown as Record<
          string,
          () => AsyncIterator<number> & AsyncIterable<number>
        >
      )[`values`]

      const collected: Array<number> = []
      const iterator = valuesMethod.call(result)

      for await (const chunk of iterator) {
        collected.push(chunk)
      }

      expect(collected).toEqual([1, 2, 3])
    })
  })

  describe(`return() behavior`, () => {
    // These tests validate our polyfill behavior. In environments with native
    // async iterators, we skip or adapt since native has different behavior.

    const hasNativeIterator = (() => {
      const testStream = new ReadableStream<number>()
      return (
        typeof (testStream as unknown as Record<symbol, unknown>)[
          Symbol.asyncIterator
        ] === `function`
      )
    })()

    it(`should pass optional value to cancel()`, async () => {
      let cancelReason: unknown = null

      const stream = new ReadableStream<number>({
        start(controller) {
          controller.enqueue(1)
          // Don't close - simulate infinite stream
        },
        cancel(reason) {
          cancelReason = reason
        },
      })

      const result = asAsyncIterableReadableStream(stream)
      const iterator = result[Symbol.asyncIterator]()

      // Read one chunk
      await iterator.next()

      // Return with a reason
      await iterator.return!(`custom reason`)

      expect(cancelReason).toBe(`custom reason`)
    })

    it.skipIf(hasNativeIterator)(
      `should always return { done: true, value: undefined } regardless of input (polyfill only)`,
      async () => {
        // Note: Our polyfill always returns undefined, matching for-await-of semantics.
        // Native iterators may return the value passed to return().
        const stream = new ReadableStream<number>({
          start(controller) {
            controller.enqueue(1)
          },
        })

        const result = asAsyncIterableReadableStream(stream)
        const iterator = result[Symbol.asyncIterator]()

        // Read one chunk
        await iterator.next()

        // Return with a value - should still return undefined
        const returnResult = await iterator.return!(`some value`)

        expect(returnResult).toEqual({ done: true, value: undefined })
      }
    )
  })
})
