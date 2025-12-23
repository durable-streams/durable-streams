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
 *
 * **Note on derived streams**: Streams created via `.pipeThrough()` or similar
 * transformations will NOT be automatically patched. Use the exported
 * `asAsyncIterableReadableStream()` helper to patch derived streams:
 *
 * ```typescript
 * import { asAsyncIterableReadableStream } from "@durable-streams/client"
 *
 * const derived = res.bodyStream().pipeThrough(myTransform)
 * const iterable = asAsyncIterableReadableStream(derived)
 * for await (const chunk of iterable) { ... }
 * ```
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
 * Define [Symbol.asyncIterator] and .values() on a ReadableStream instance.
 *
 * Uses getReader().read() to implement spec-consistent iteration.
 * On completion or early exit (break/return/throw), releases lock and cancels as appropriate.
 *
 * **Iterator behavior notes:**
 * - `return(value?)` accepts an optional cancellation reason passed to `reader.cancel()`
 * - `return()` always resolves with `{ done: true, value: undefined }` regardless of the
 *   input value. This matches `for await...of` semantics where the return value is ignored.
 *   Manual iteration users should be aware of this behavior.
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

  // The iterator factory function - shared between [Symbol.asyncIterator] and .values()
  const createIterator = function (
    this: ReadableStream<T>
  ): AsyncIterator<T> & AsyncIterable<T> {
    const reader = this.getReader()
    let finished = false
    // Track pending reads with a counter (not boolean) to handle
    // concurrent next() calls correctly. This is important if someone
    // manually calls next() multiple times without awaiting.
    let pendingReads = 0

    const iterator: AsyncIterator<T> & AsyncIterable<T> = {
      async next() {
        if (finished) {
          return { done: true, value: undefined as unknown as T }
        }

        pendingReads++
        try {
          const { value, done } = await reader.read()

          if (done) {
            finished = true
            reader.releaseLock()
            return { done: true, value: undefined as unknown as T }
          }

          return { done: false, value: value }
        } catch (err) {
          // On read error, release lock to avoid leaking it
          finished = true
          try {
            reader.releaseLock()
          } catch {
            // Ignore release errors - lock may already be released
          }
          throw err
        } finally {
          pendingReads--
        }
      },

      /**
       * Called on early exit (break, return, or completion).
       * Accepts an optional cancellation reason passed to reader.cancel().
       *
       * Note: Always returns { done: true, value: undefined } regardless of input,
       * matching for-await-of semantics where return values are ignored.
       */
      async return(value?: unknown) {
        // Per WHATWG Streams spec: reject with TypeError if there are pending reads
        if (pendingReads > 0) {
          throw new TypeError(
            `Cannot close a readable stream reader when it has pending read requests`
          )
        }

        finished = true
        // Per spec: start cancel with optional reason, release lock, then await cancel
        const cancelPromise = reader.cancel(value)
        reader.releaseLock()
        await cancelPromise
        return { done: true, value: undefined as unknown as T }
      },

      async throw(err?: unknown) {
        // Per WHATWG Streams spec: reject with TypeError if there are pending reads
        if (pendingReads > 0) {
          throw new TypeError(
            `Cannot close a readable stream reader when it has pending read requests`
          )
        }

        finished = true
        // Per spec: start cancel with error, release lock, then await cancel
        const cancelPromise = reader.cancel(err)
        reader.releaseLock()
        await cancelPromise
        throw err
      },

      [Symbol.asyncIterator]() {
        return this
      },
    }

    return iterator
  }

  // Define [Symbol.asyncIterator] with defensive try/catch
  // If defineProperty fails (non-extensible object, sandbox, etc.),
  // we gracefully degrade rather than crash
  try {
    Object.defineProperty(stream, Symbol.asyncIterator, {
      configurable: true,
      writable: true,
      value: createIterator,
    })
  } catch {
    // Failed to define - stream remains non-iterable but doesn't crash
    return
  }

  // Also define .values() for API completeness (mirrors native ReadableStream)
  try {
    Object.defineProperty(stream, `values`, {
      configurable: true,
      writable: true,
      value: createIterator,
    })
  } catch {
    // Failed to define .values() - Symbol.asyncIterator may still work
  }
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
