/**
 * Test helper utilities for integration tests.
 * Following the Electric client pattern.
 */

import type { DurableStream, StreamChunk } from "../../src"

/**
 * Process chunks from a follow() iterator with a handler.
 * Resolves when handler calls resolve(), rejects on error.
 */
export async function forEachChunk(
  stream: DurableStream,
  controller: AbortController,
  handler: (
    resolve: () => void,
    chunk: StreamChunk,
    nthChunk: number
  ) => Promise<void> | void
): Promise<void> {
  let chunkIdx = 0

  const resolveOnce = (): void => {
    controller.abort()
  }

  try {
    for await (const chunk of stream.follow({ signal: controller.signal })) {
      await handler(resolveOnce, chunk, chunkIdx)
      chunkIdx++
    }
  } catch (e) {
    if (!controller.signal.aborted) {
      throw e
    }
  }
}

/**
 * Collect all chunks until up-to-date or timeout.
 */
export async function collectChunks(
  stream: DurableStream,
  options: {
    signal?: AbortSignal
    maxChunks?: number
    timeout?: number
    stopOnUpToDate?: boolean
  } = {}
): Promise<Array<StreamChunk>> {
  const {
    maxChunks = Infinity,
    timeout = 5000,
    stopOnUpToDate = true,
  } = options

  const chunks: Array<StreamChunk> = []
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
    for await (const chunk of stream.follow({ signal: aborter.signal })) {
      chunks.push(chunk)

      if (chunks.length >= maxChunks) {
        break
      }

      if (stopOnUpToDate && chunk.upToDate) {
        break
      }
    }
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
  stream: DurableStream,
  options: {
    signal?: AbortSignal
    timeout?: number
    numChunksExpected?: number
  } = {}
): Promise<{ chunks: Array<StreamChunk>; offset: string }> {
  const { timeout = 5000, numChunksExpected = 1 } = options

  const chunks: Array<StreamChunk> = []
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
    for await (const chunk of stream.follow({ signal: aborter.signal })) {
      chunks.push(chunk)

      if (chunks.length >= numChunksExpected && chunk.upToDate) {
        break
      }
    }
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
