/**
 * Async iterable polyfill for ReadableStream.
 *
 * Safari/iOS may not implement ReadableStream.prototype[Symbol.asyncIterator],
 * preventing `for await...of` consumption. This module provides a soft polyfill
 * that defines [Symbol.asyncIterator] on individual stream instances when missing,
 * without patching the global prototype.
 *
 * The returned stream is still the original ReadableStream instance (not wrapped),
 * so `instanceof ReadableStream` continues to work correctly.
 */

/**
 * A ReadableStream that is guaranteed to be async-iterable.
 *
 * This intersection type ensures TypeScript knows the stream can be consumed
 * via `for await...of` syntax.
 */
export type ReadableStreamAsyncIterable<T> = ReadableStream<T> &
  AsyncIterable<T>

/**
 * Check if a value has Symbol.asyncIterator defined.
 */
function hasAsyncIterator(stream: unknown): stream is AsyncIterable<unknown> {
  return (
    typeof Symbol !== `undefined` &&
    typeof (Symbol as unknown as Record<string, unknown>).asyncIterator ===
      `symbol` &&
    typeof (stream as Record<symbol, unknown>)[Symbol.asyncIterator] ===
      `function`
  )
}

/**
 * Define [Symbol.asyncIterator] on a ReadableStream instance.
 *
 * Uses getReader().read() to implement spec-consistent iteration.
 * On completion or early exit (break/return/throw), releases lock and cancels as appropriate.
 */
function defineAsyncIterator<T>(stream: ReadableStream<T>): void {
  if (
    typeof Symbol === `undefined` ||
    typeof (Symbol as unknown as Record<string, unknown>).asyncIterator !==
      `symbol`
  ) {
    return
  }

  if (
    typeof (stream as unknown as Record<symbol, unknown>)[
      Symbol.asyncIterator
    ] === `function`
  ) {
    return
  }

  Object.defineProperty(stream, Symbol.asyncIterator, {
    configurable: true,
    writable: true,
    value: function (
      this: ReadableStream<T>
    ): AsyncIterator<T> & AsyncIterable<T> {
      const reader = this.getReader()
      let finished = false

      const iterator: AsyncIterator<T> & AsyncIterable<T> = {
        async next() {
          if (finished) {
            return { done: true, value: undefined as unknown as T }
          }

          const { value, done } = await reader.read()
          if (done) {
            finished = true
            try {
              reader.releaseLock()
            } catch {
              // Ignore release errors
            }
            return { done: true, value: undefined as unknown as T }
          }

          return { done: false, value: value }
        },

        async return() {
          finished = true
          // Match native behavior: start cancel, release lock immediately,
          // then await cancel (propagating any rejection)
          const cancelPromise = reader.cancel()
          try {
            reader.releaseLock()
          } catch {
            // Ignore release errors - lock may already be released
          }
          await cancelPromise
          return { done: true, value: undefined as unknown as T }
        },

        async throw(err?: unknown) {
          finished = true
          // Match native behavior: start cancel with error, release lock,
          // then await cancel before re-throwing
          const cancelPromise = reader.cancel(err)
          try {
            reader.releaseLock()
          } catch {
            // Ignore release errors - lock may already be released
          }
          await cancelPromise
          throw err
        },

        [Symbol.asyncIterator]() {
          return this
        },
      }

      return iterator
    },
  })
}

/**
 * Ensure a ReadableStream is async-iterable.
 *
 * If the stream already has [Symbol.asyncIterator] defined (native or polyfilled),
 * it is returned as-is. Otherwise, [Symbol.asyncIterator] is defined on the
 * stream instance (not the prototype).
 *
 * The returned value is the same ReadableStream instance, so:
 * - `stream instanceof ReadableStream` remains true
 * - Any code relying on native branding/internal slots continues to work
 *
 * @example
 * ```typescript
 * const stream = someApiReturningReadableStream();
 * const iterableStream = asAsyncIterableReadableStream(stream);
 *
 * // Now works on Safari/iOS:
 * for await (const chunk of iterableStream) {
 *   console.log(chunk);
 * }
 * ```
 */
export function asAsyncIterableReadableStream<T>(
  stream: ReadableStream<T>
): ReadableStreamAsyncIterable<T> {
  if (!hasAsyncIterator(stream)) {
    defineAsyncIterator(stream)
  }
  return stream as ReadableStreamAsyncIterable<T>
}
