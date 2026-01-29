/**
 * TanStack AI Adapter for Durable Proxy.
 *
 * This adapter integrates with TanStack's AI utilities
 * to provide transparent reconnection for streaming responses.
 */

import { createAbortFn, createDurableFetch, getDefaultStorage } from "../client"
import { generateStreamKey } from "./hash"
import type { DurableFetch } from "../client/types"
import type {
  ConnectionAdapter,
  ConnectionAdapterOptions,
  ConnectionAdapterResponse,
  DurableAdapterOptions,
} from "./types"

/**
 * Create a durable adapter for TanStack AI.
 *
 * This adapter provides:
 * - Automatic reconnection on network failures
 * - Resume from last known position
 * - Abort support for canceling streams
 *
 * @param apiUrl - The absolute URL of your backend API for chat completions
 * @param options - Adapter configuration options
 * @returns A connection adapter instance
 *
 * @example
 * ```typescript
 * import { createDurableAdapter } from '@durable-streams/proxy/transports'
 *
 * const adapter = createDurableAdapter('https://api.example.com/api/chat', {
 *   proxyUrl: 'https://proxy.example.com/v1/proxy',
 *   proxyAuthorization: 'service-secret',
 *   getRequestId: (messages, data) => data?.conversationId ?? 'default',
 * })
 *
 * // Use with TanStack AI
 * const connection = await adapter.connect({
 *   body: { messages },
 * })
 *
 * // Read the stream
 * const reader = connection.stream.getReader()
 * // ...
 *
 * // To abort
 * await adapter.abort()
 * ```
 */
export function createDurableAdapter(
  apiUrl: string,
  options: DurableAdapterOptions
): ConnectionAdapter {
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

  // Track abort functions for concurrent streams
  const abortFns = new Map<string, () => Promise<void>>()
  let currentRequestId: string | null = null

  return {
    async connect(
      connectOptions: ConnectionAdapterOptions
    ): Promise<ConnectionAdapterResponse> {
      const {
        method = `POST`,
        body,
        headers: requestHeaders,
        signal,
      } = connectOptions

      // Extract messages from body for request ID generation
      const bodyObj = typeof body === `string` ? JSON.parse(body) : (body ?? {})
      const messages = bodyObj.messages ?? []
      const data = bodyObj.data

      // Generate request ID
      const requestId = getRequestId(messages, data)

      // Resolve headers
      const resolvedConfigHeaders =
        typeof configHeaders === `function`
          ? configHeaders()
          : (configHeaders ?? {})
      const mergedHeaders = {
        ...resolvedConfigHeaders,
        ...requestHeaders,
        "Content-Type": `application/json`,
      }

      // Ensure streaming is enabled
      const requestBody = {
        ...bodyObj,
        stream: true,
      }

      // Make the durable fetch request
      const response = await durableFetch(apiUrl, {
        method,
        headers: mergedHeaders,
        body: JSON.stringify(requestBody),
        requestId,
        signal,
      })

      if (!response.ok) {
        throw new Error(`Request failed: ${response.status}`)
      }

      if (!response.body) {
        throw new Error(`No response body`)
      }

      // Set up abort function for this stream
      if (response.streamUrl) {
        abortFns.set(requestId, createAbortFn(response.streamUrl, fetchFn))
        currentRequestId = requestId
      }

      return {
        stream: response.body,
        headers: response.headers,
        status: response.status,
      }
    },

    async abort(): Promise<void> {
      // Abort the current stream
      if (currentRequestId) {
        const abortFn = abortFns.get(currentRequestId)
        if (abortFn) {
          await abortFn()
          abortFns.delete(currentRequestId)
        }
        currentRequestId = null
      }
    },
  }
}
