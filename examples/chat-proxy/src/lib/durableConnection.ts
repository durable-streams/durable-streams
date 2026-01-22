import { createDurableFetch } from "@durable-streams/proxy/client"
import type { ModelMessage, StreamChunk, UIMessage } from "@tanstack/ai"
import type { ConnectionAdapter } from "@tanstack/ai-react"

/**
 * Parse an SSE stream and yield StreamChunks.
 */
export async function* parseSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>
): AsyncGenerator<StreamChunk> {
  const decoder = new TextDecoder()
  let buffer = ``

  try {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(`\n`)
      buffer = lines.pop() || ``

      for (const line of lines) {
        if (!line.trim() || !line.startsWith(`data:`)) continue

        const content = line.slice(5).trim()
        if (!content || content.startsWith(`event:`)) continue

        let parsed: {
          type: string
          error?: { message?: string }
          message?: string
        }
        try {
          parsed = JSON.parse(content)
        } catch {
          // Skip JSON parse errors
          continue
        }

        if (parsed.type === `content`) {
          yield parsed as StreamChunk
        } else if (parsed.type === `done`) {
          yield parsed as StreamChunk
          return // Stop parsing after done
        } else if (parsed.type === `error`) {
          // Extract error message from stream error event
          const errorMsg =
            parsed.error?.message || parsed.message || `Stream error`
          throw new Error(errorMsg)
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * Create a TanStack AI compatible connection adapter using durable fetch.
 */
export function createDurableConnection(
  apiUrl: string,
  proxyUrl: string,
  getStreamKey: () => string
): ConnectionAdapter {
  const durableFetch = createDurableFetch({
    proxyUrl,
    storage: typeof localStorage !== `undefined` ? localStorage : undefined,
    autoResume: true,
  })

  return {
    async *connect(
      messages: Array<UIMessage> | Array<ModelMessage>,
      _data?: Record<string, unknown>,
      abortSignal?: AbortSignal
    ): AsyncIterable<StreamChunk> {
      const streamKey = getStreamKey()

      const requestBody = {
        model: `claude-sonnet-4-20250514`,
        max_tokens: 8096,
        messages,
      }

      const response = await durableFetch(apiUrl, {
        method: `POST`,
        headers: { "Content-Type": `application/json` },
        body: JSON.stringify(requestBody),
        stream_key: streamKey,
        signal: abortSignal,
      })

      if (!response.ok) {
        // Try to extract error details from response body
        let errorMessage = `Request failed: ${response.status}`
        try {
          const errorBody = await response.text()
          if (errorBody) {
            // Try to parse as JSON first
            try {
              const errorJson = JSON.parse(errorBody)
              errorMessage = errorJson.error || errorJson.message || errorBody
            } catch {
              errorMessage = errorBody
            }
          }
        } catch {
          // Ignore body read errors
        }
        throw new Error(errorMessage)
      }

      if (!response.body) {
        throw new Error(`No response body`)
      }

      yield* parseSSEStream(response.body.getReader())
    },
  }
}
