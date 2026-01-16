/**
 * Vercel AI SDK Transport for Durable Proxy.
 *
 * This transport integrates with the Vercel AI SDK's chat API
 * to provide transparent reconnection for streaming responses.
 */

import { createDurableFetch, getDefaultStorage } from "../client"
import { generateStreamKey } from "./hash"
import type { DurableFetch } from "../client/types"
import type {
  ChatTransport,
  ChatTransportResponse,
  ChatTransportSendOptions,
  DurableChatTransportOptions,
} from "./types"

/**
 * Create a durable chat transport for the Vercel AI SDK.
 *
 * This transport wraps the standard chat API to provide:
 * - Automatic reconnection on network failures
 * - Resume from last known position
 * - Transparent handling of streaming responses
 *
 * @param options - Transport configuration options
 * @returns A chat transport instance
 *
 * @example
 * ```typescript
 * import { createDurableChatTransport } from '@durable-streams/proxy/transports'
 * import { useChat } from 'ai/react'
 *
 * const transport = createDurableChatTransport({
 *   proxyUrl: 'https://api.example.com/v1/proxy/chat',
 *   api: 'https://api.openai.com/v1/chat/completions',
 * })
 *
 * function Chat() {
 *   const { messages, input, handleInputChange, handleSubmit } = useChat({
 *     transport,
 *   })
 *
 *   return (
 *     // ... render chat UI
 *   )
 * }
 * ```
 */
export function createDurableChatTransport(
  options: DurableChatTransportOptions
): ChatTransport {
  const {
    proxyUrl,
    api = `/api/chat`,
    storage = getDefaultStorage(),
    getStreamKey = (msgs: Array<unknown>) => generateStreamKey(`chat`, msgs),
    headers: configHeaders,
    fetch: fetchFn = fetch,
  } = options

  // Create the durable fetch wrapper
  const durableFetch: DurableFetch = createDurableFetch({
    proxyUrl,
    storage,
    fetch: fetchFn,
  })

  return {
    async send(
      sendOptions: ChatTransportSendOptions
    ): Promise<ChatTransportResponse> {
      const {
        messages,
        data,
        signal,
        headers: requestHeaders,
        body: bodyOverrides,
      } = sendOptions

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

      // Build request body
      const body = {
        messages,
        ...bodyOverrides,
        stream: true,
      }

      // Determine the upstream URL
      // If api is a relative path, we need to construct the full URL
      let upstreamUrl = api
      if (api.startsWith(`/`)) {
        // For relative paths, the caller should handle URL resolution
        // We'll use a placeholder that the server-side can resolve
        upstreamUrl = api
      }

      // Make the durable fetch request
      const response = await durableFetch(upstreamUrl, {
        method: `POST`,
        headers: mergedHeaders,
        body: JSON.stringify(body),
        stream_key: streamKey,
        signal,
      })

      if (!response.ok) {
        throw new Error(`Chat request failed: ${response.status}`)
      }

      if (!response.body) {
        throw new Error(`No response body`)
      }

      return {
        stream: response.body,
        headers: response.headers,
        status: response.status,
        wasResumed: response.wasResumed,
      }
    },
  }
}

/**
 * Helper to check if a transport response was resumed.
 */
export function wasResumed(response: ChatTransportResponse): boolean {
  return response.wasResumed ?? false
}
