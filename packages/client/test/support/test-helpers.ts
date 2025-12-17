/**
 * Test helper utilities for integration tests.
 * Following the Electric client pattern.
 */

import type { ByteChunk, DurableStream } from "../../src"

/**
 * Process chunks from a stream using subscribeBytes with a handler.
 * Resolves when handler calls resolve(), rejects on error.
 */
export async function forEachChunk(
  handle: DurableStream,
  controller: AbortController,
  handler: (
    resolve: () => void,
    chunk: ByteChunk,
    nthChunk: number
  ) => Promise<void> | void
): Promise<void> {
  let chunkIdx = 0

  const response = await handle.stream({ signal: controller.signal })

  return new Promise<void>((resolve, reject) => {
    const resolveOnce = (): void => {
      controller.abort()
      resolve()
    }

    const unsubscribe = response.subscribeBytes(async (chunk) => {
      try {
        await handler(resolveOnce, chunk, chunkIdx)
        chunkIdx++
      } catch (e) {
        unsubscribe()
        reject(e)
      }
    })

    // Handle abort
    controller.signal.addEventListener(
      `abort`,
      () => {
        resolve()
      },
      { once: true }
    )
  })
}

/**
 * Collect all chunks until up-to-date or timeout.
 */
export async function collectChunks(
  handle: DurableStream,
  options: {
    signal?: AbortSignal
    maxChunks?: number
    timeout?: number
    stopOnUpToDate?: boolean
  } = {}
): Promise<Array<ByteChunk>> {
  const {
    maxChunks = Infinity,
    timeout = 5000,
    stopOnUpToDate = true,
  } = options

  const chunks: Array<ByteChunk> = []
  const aborter = new AbortController()

  // Link to external signal
  if (options.signal) {
    options.signal.addEventListener(`abort`, () => aborter.abort(), {
      once: true,
    })
  }

  // Timeout
  const timeoutId = setTimeout(() => aborter.abort(), timeout)

  try {
    const response = await handle.stream({ signal: aborter.signal })

    await new Promise<void>((resolve) => {
      const unsubscribe = response.subscribeBytes((chunk) => {
        chunks.push(chunk)

        if (chunks.length >= maxChunks) {
          unsubscribe()
          resolve()
          return
        }

        if (stopOnUpToDate && chunk.upToDate) {
          unsubscribe()
          resolve()
        }
      })

      // Handle abort
      aborter.signal.addEventListener(
        `abort`,
        () => {
          resolve()
        },
        { once: true }
      )
    })
  } catch (e) {
    if (!aborter.signal.aborted) {
      throw e
    }
  } finally {
    clearTimeout(timeoutId)
  }

  return chunks
}

/**
 * Wait for a stream to receive data and become up-to-date.
 */
export async function waitForUpToDate(
  handle: DurableStream,
  options: {
    signal?: AbortSignal
    timeout?: number
    numChunksExpected?: number
  } = {}
): Promise<{ chunks: Array<ByteChunk>; offset: string }> {
  const { timeout = 5000, numChunksExpected = 1 } = options

  const chunks: Array<ByteChunk> = []
  const aborter = new AbortController()

  // Link to external signal
  if (options.signal) {
    options.signal.addEventListener(`abort`, () => aborter.abort(), {
      once: true,
    })
  }

  // Timeout
  const timeoutId = setTimeout(() => aborter.abort(), timeout)

  try {
    const response = await handle.stream({ signal: aborter.signal })

    await new Promise<void>((resolve) => {
      const unsubscribe = response.subscribeBytes((chunk) => {
        chunks.push(chunk)

        if (chunks.length >= numChunksExpected && chunk.upToDate) {
          unsubscribe()
          resolve()
        }
      })

      // Handle abort
      aborter.signal.addEventListener(
        `abort`,
        () => {
          resolve()
        },
        { once: true }
      )
    })
  } catch (e) {
    if (!aborter.signal.aborted) {
      throw e
    }
  } finally {
    clearTimeout(timeoutId)
  }

  const lastOffset = chunks.length > 0 ? chunks[chunks.length - 1]!.offset : ``

  return { chunks, offset: lastOffset }
}

/**
 * Encode a string to Uint8Array.
 */
export function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

/**
 * Decode a Uint8Array to string.
 */
export function decode(data: Uint8Array): string {
  return new TextDecoder().decode(data)
}

/**
 * Sleep for a specified number of milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Create a deferred promise that can be resolved/rejected externally.
 */
export function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void

  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })

  return { promise, resolve, reject }
}
