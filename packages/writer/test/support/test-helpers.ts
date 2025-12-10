/**
 * Test helper utilities for integration tests.
 */

import type { DurableStream } from "../../src"

/**
 * Collect all chunks until timeout or max chunks.
 */
export async function collectChunks(
  stream: DurableStream,
  options: {
    signal?: AbortSignal
    maxChunks?: number
    timeout?: number
    live?: boolean | `long-poll` | `sse`
  } = {}
): Promise<Array<Uint8Array>> {
  const { maxChunks = Infinity, timeout = 5000, live = false } = options

  const chunks: Array<Uint8Array> = []
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
    for await (const chunk of stream.body({ signal: aborter.signal, live })) {
      chunks.push(chunk)

      if (chunks.length >= maxChunks) {
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
