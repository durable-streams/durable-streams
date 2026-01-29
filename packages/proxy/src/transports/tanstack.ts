/**
 * TanStack AI Adapter for Durable Proxy.
 *
 * This adapter integrates with TanStack's `useChat` hook via the
 * `ConnectionAdapter` interface, providing transparent reconnection
 * for streaming responses through durable streams.
 *
 * The TanStack `ConnectionAdapter` contract:
 *   connect(messages, data?, abortSignal?) => AsyncIterable<StreamChunk>
 *
 * This adapter routes requests through durableFetch (two-phase POST→GET),
 * then parses the SSE response into StreamChunk objects.
 */

import { createAbortFn, createDurableFetch, getDefaultStorage } from "../client"
import { generateStreamKey } from "./hash"
import type { DurableFetch } from "../client/types"
import type { DurableAdapterOptions } from "./types"

/**
 * Create a durable adapter for TanStack AI's `useChat` hook.
 *
 * @param apiUrl - The absolute URL of your backend API for chat completions
 * @param options - Adapter configuration options
 * @returns A ConnectionAdapter compatible with `@tanstack/ai-client`
 *
 * @example
 * ```typescript
 * import { createDurableAdapter } from '@durable-streams/proxy/transports'
 *
 * const adapter = createDurableAdapter('http://localhost:3002/api/chat', {
 *   proxyUrl: 'http://localhost:4440/v1/proxy',
 *   proxyAuthorization: 'dev-secret',
 *   getRequestId: (messages) => `conv-${messages.length}`,
 * })
 *
 * // Use with TanStack AI
 * const { messages, sendMessage } = useChat({
 *   connection: adapter,
 * })
 * ```
 */
export function createDurableAdapter(
  apiUrl: string,
  options: DurableAdapterOptions
): {
  connect: (
    messages: Array<unknown>,
    data?: Record<string, unknown>,
    abortSignal?: AbortSignal
  ) => AsyncIterable<unknown>
} {
  // Validate that apiUrl is an absolute URL
  try {
    new URL(apiUrl)
  } catch {
    throw new Error(
      `apiUrl must be an absolute URL (got "${apiUrl}"). ` +
        `The proxy server needs the full URL to forward requests to your backend.`
    )
  }

  const {
    proxyUrl,
    proxyAuthorization,
    storage = getDefaultStorage(),
    getRequestId = (msgs: Array<unknown>) =>
      generateStreamKey(`tanstack`, msgs),
    headers: configHeaders,
    fetch: fetchFn = fetch,
    storagePrefix = `durable-streams:`,
  } = options

  // Create the durable fetch wrapper
  const durableFetch: DurableFetch = createDurableFetch({
    proxyUrl,
    proxyAuthorization,
    storage,
    storagePrefix,
    fetch: fetchFn,
  })

  return {
    async *connect(
      messages: Array<unknown>,
      data?: Record<string, unknown>,
      abortSignal?: AbortSignal
    ) {
      // Generate request ID for resumability
      const requestId = getRequestId(messages, data)

      // Resolve headers
      const resolvedConfigHeaders =
        typeof configHeaders === `function`
          ? configHeaders()
          : (configHeaders ?? {})
      const mergedHeaders = {
        ...resolvedConfigHeaders,
        "Content-Type": `application/json`,
      }

      // Build the request body (messages + any extra data)
      const requestBody = {
        messages,
        data,
      }

      // Make the durable fetch request (handles POST→GET two-phase flow)
      const response = await durableFetch(apiUrl, {
        method: `POST`,
        headers: mergedHeaders,
        body: JSON.stringify(requestBody),
        requestId,
        signal: abortSignal,
      })

      if (!response.ok) {
        throw new Error(`Request failed: ${response.status}`)
      }

      if (!response.body) {
        throw new Error(`No response body`)
      }

      // Set up abort function for stop button support
      if (response.streamUrl) {
        const abortFn = createAbortFn(response.streamUrl, fetchFn)

        // When the abort signal fires, call the proxy abort endpoint
        if (abortSignal) {
          const onAbort = () => {
            abortFn().catch(() => {
              // Ignore abort errors (stream may already be complete)
            })
          }
          if (abortSignal.aborted) {
            onAbort()
          } else {
            abortSignal.addEventListener(`abort`, onAbort, { once: true })
          }
        }
      }

      // Parse SSE from the response body and yield StreamChunks
      yield* parseSSEStream(response.body, abortSignal)
    },
  }
}

/**
 * Parse a Server-Sent Events stream into individual JSON chunks.
 *
 * Reads the response body line-by-line, extracts `data:` prefixed lines,
 * parses them as JSON, and yields each parsed object.
 */
async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
  abortSignal?: AbortSignal
): AsyncGenerator<unknown> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ``

  try {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    while (true) {
      if (abortSignal?.aborted) break

      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(`\n`)

      // Keep the last incomplete line in the buffer
      buffer = lines.pop() ?? ``

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue

        // Extract data from SSE "data: ..." lines
        const data = trimmed.startsWith(`data: `) ? trimmed.slice(6) : trimmed

        // Skip the [DONE] sentinel
        if (data === `[DONE]`) continue

        try {
          const parsed = JSON.parse(data)
          yield parsed
        } catch {
          // Skip non-JSON lines
        }
      }
    }

    // Process any remaining data in the buffer
    if (buffer.trim()) {
      const data = buffer.trim().startsWith(`data: `)
        ? buffer.trim().slice(6)
        : buffer.trim()
      if (data !== `[DONE]`) {
        try {
          yield JSON.parse(data)
        } catch {
          // Skip non-JSON remainder
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}
