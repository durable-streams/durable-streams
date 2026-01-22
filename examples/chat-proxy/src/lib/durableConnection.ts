import { createDurableFetch } from "@durable-streams/proxy/client"
import { uiMessageToModelMessages } from "@tanstack/ai"
import type { ModelMessage, StreamChunk, UIMessage } from "@tanstack/ai"
import type { ConnectionAdapter } from "@tanstack/ai-react"

// Re-export StreamChunk for use by other modules
export type { StreamChunk }

/** Extended StreamChunk with delta for content events */
export type StreamChunkWithDelta = StreamChunk & { delta?: string }

/**
 * Parse TanStack AI's SSE stream format.
 *
 * TanStack AI's toServerSentEventsResponse() produces:
 * - data: {JSON StreamChunk}\n\n
 *
 * StreamChunk types: content, tool_call, tool_result, done, error
 */
export async function* parseTanStackSSE(
  reader: ReadableStreamDefaultReader<Uint8Array>
): AsyncGenerator<StreamChunkWithDelta> {
  const decoder = new TextDecoder()
  let buffer = ``
  let streamComplete = false

  const parseEvents = function* (
    events: Array<string>
  ): Generator<StreamChunkWithDelta & { type: string }> {
    for (const event of events) {
      if (!event.trim()) continue

      // Parse SSE lines - handle both simple "data:" format and "event:/data:" format
      const lines = event.split(`\n`)
      let eventType = ``
      const dataLines: Array<string> = []

      for (const line of lines) {
        if (line.startsWith(`event:`)) {
          eventType = line.slice(6).trim()
        } else if (line.startsWith(`data:`)) {
          dataLines.push(line.slice(5).trim())
        }
      }

      // Handle control events from TanStack AI (e.g., close)
      if (eventType === `control`) {
        try {
          const controlData = JSON.parse(dataLines.join(`\n`))
          if (controlData.type === `close`) {
            streamComplete = true
            return
          }
        } catch {
          // Ignore malformed control messages
        }
        continue
      }

      // Handle data lines
      for (const content of dataLines) {
        if (!content || content === `[DONE]`) continue

        try {
          const chunk = JSON.parse(content) as StreamChunkWithDelta
          yield chunk
          // Check for done event
          if (chunk.type === `done`) {
            streamComplete = true
          }
        } catch {
          // Ignore malformed JSON chunks
        }
      }
    }
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      // Split by double newline (SSE event separator)
      const events = buffer.split(`\n\n`)
      // Keep the last potentially incomplete event
      buffer = events.pop() || ``

      for (const chunk of parseEvents(events)) {
        yield chunk
      }

      // Exit if we've seen a completion signal
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (streamComplete) {
        // Cancel the reader to close the connection
        await reader.cancel()
        return
      }
    }

    // Process any remaining buffer content after stream ends
    if (buffer.trim()) {
      const remainingEvents = buffer.split(`\n\n`)
      for (const chunk of parseEvents(remainingEvents)) {
        yield chunk
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * Create a TanStack AI compatible connection adapter that calls the backend
 * through the durable proxy.
 */
export function createDurableConnection(
  proxyUrl: string,
  apiUrl: string,
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

      // Convert UIMessages to ModelMessages for the backend
      // Check if first message has 'parts' (UIMessage) or 'content' (ModelMessage)
      const isUIMessage = messages.length > 0 && `parts` in messages[0]
      const converted = isUIMessage
        ? (messages as Array<UIMessage>).flatMap(uiMessageToModelMessages)
        : (messages as Array<ModelMessage>)

      // Filter out empty messages (Anthropic requires non-empty content)
      const modelMessages = converted.filter((m) => {
        if (!m.content) return false
        if (typeof m.content === `string`) return m.content.length > 0
        if (Array.isArray(m.content)) return m.content.length > 0
        return true
      })

      const requestBody = {
        messages: modelMessages,
      }

      const response = await durableFetch(apiUrl, {
        method: `POST`,
        headers: {
          "Content-Type": `application/json`,
        },
        body: JSON.stringify(requestBody),
        stream_key: streamKey,
        signal: abortSignal,
      })

      if (!response.ok) {
        let errorMessage = `Request failed: ${response.status}`
        try {
          const errorBody = await response.text()
          if (errorBody) {
            try {
              const errorJson = JSON.parse(errorBody)
              errorMessage =
                errorJson.error?.message || errorJson.message || errorBody
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

      yield* parseTanStackSSE(response.body.getReader())
    },
  }
}
