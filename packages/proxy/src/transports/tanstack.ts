/**
 * TanStack AI Adapter for Durable Proxy.
 *
 * This adapter integrates with TanStack's AI utilities
 * to provide transparent reconnection for streaming responses.
 */

import {
  createAbortFn,
  createDurableFetch,
  getDefaultStorage,
  loadCredentials,
} from "../client"
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
 * @param apiPath - The API path for chat completions
 * @param options - Adapter configuration options
 * @returns A connection adapter instance
 *
 * @example
 * ```typescript
 * import { createDurableAdapter } from '@durable-streams/proxy/transports'
 *
 * const adapter = createDurableAdapter('/api/chat', {
 *   proxyUrl: 'https://api.example.com/v1/proxy/chat',
 *   getStreamKey: (messages, data) => data?.conversationId ?? 'default',
 * })
 *
 * // Use with TanStack AI
 * const connection = await adapter.connect({
 *   url: '/api/chat',
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
  apiPath: string,
  options: DurableAdapterOptions
): ConnectionAdapter {
  const {
    proxyUrl,
    storage = getDefaultStorage(),
    getStreamKey = (msgs: Array<unknown>) =>
      generateStreamKey(`tanstack`, msgs),
    headers: configHeaders,
    fetch: fetchFn = fetch,
  } = options

  // Create the durable fetch wrapper
  const durableFetch: DurableFetch = createDurableFetch({
    proxyUrl,
    storage,
    fetch: fetchFn,
  })

  // Track abort function for current stream
  let abortFn: (() => Promise<void>) | null = null

  return {
    async connect(
      connectOptions: ConnectionAdapterOptions
    ): Promise<ConnectionAdapterResponse> {
      const {
        url,
        method = `POST`,
        body,
        headers: requestHeaders,
        signal,
      } = connectOptions

      // Extract messages from body for stream key generation
      const bodyObj = typeof body === `string` ? JSON.parse(body) : (body ?? {})
      const messages = bodyObj.messages ?? []
      const data = bodyObj.data

      // Generate stream key
      const streamKey = getStreamKey(messages, data)

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

      // Determine upstream URL
      const upstreamUrl = url.startsWith(`http`) ? url : apiPath

      // Make the durable fetch request
      const response = await durableFetch(upstreamUrl, {
        method,
        headers: mergedHeaders,
        body: JSON.stringify(requestBody),
        stream_key: streamKey,
        signal,
      })

      if (!response.ok) {
        throw new Error(`Request failed: ${response.status}`)
      }

      if (!response.body) {
        throw new Error(`No response body`)
      }

      // Set up abort function
      if (response.durableStreamPath) {
        const credentials = loadCredentials(
          storage,
          `durable-streams:`,
          streamKey
        )
        if (credentials) {
          abortFn = createAbortFn(
            proxyUrl,
            credentials.path,
            credentials.readToken,
            fetchFn
          )
        }
      }

      return {
        stream: response.body,
        headers: response.headers,
        status: response.status,
      }
    },

    async abort(): Promise<void> {
      if (abortFn) {
        await abortFn()
        abortFn = null
      }
    },
  }
}
