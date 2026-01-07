/**
 * SSE (Server-Sent Events) parsing utilities for the durable streams protocol.
 *
 * SSE format from protocol:
 * - `event: data` events contain the stream data
 * - `event: control` events contain `streamNextOffset` and optional `streamCursor` and `upToDate`
 */

import type { Offset } from "./types"

/**
 * Parsed SSE event from the stream.
 */
export interface SSEDataEvent {
  type: `data`
  data: string
}

export interface SSEControlEvent {
  type: `control`
  streamNextOffset: Offset
  streamCursor?: string
  upToDate?: boolean
}

export type SSEEvent = SSEDataEvent | SSEControlEvent

/**
 * Parse SSE events from a ReadableStream<Uint8Array>.
 * Yields parsed events as they arrive.
 */
export async function* parseSSEStream(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<SSEEvent, void, undefined> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ``
  let currentEvent: { type?: string; data: Array<string> } = { data: [] }

  try {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    while (true) {
      if (signal?.aborted) {
        break
      }

      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      // Normalize line endings: CRLF → LF, lone CR → LF (per SSE spec)
      buffer = buffer.replace(/\r\n/g, `\n`).replace(/\r/g, `\n`)

      // Process complete lines
      const lines = buffer.split(`\n`)
      // Keep the last incomplete line in the buffer
      buffer = lines.pop() ?? ``

      for (const line of lines) {
        if (line === ``) {
          // Empty line signals end of event
          if (currentEvent.type && currentEvent.data.length > 0) {
            const dataStr = currentEvent.data.join(`\n`)

            if (currentEvent.type === `data`) {
              yield { type: `data`, data: dataStr }
            } else if (currentEvent.type === `control`) {
              try {
                const control = JSON.parse(dataStr) as {
                  streamNextOffset: Offset
                  streamCursor?: string
                  upToDate?: boolean
                }
                yield {
                  type: `control`,
                  streamNextOffset: control.streamNextOffset,
                  streamCursor: control.streamCursor,
                  upToDate: control.upToDate,
                }
              } catch {
                // Invalid control event, skip
              }
            }
          }
          currentEvent = { data: [] }
        } else if (line.startsWith(`event:`)) {
          currentEvent.type = line.slice(6).trim()
        } else if (line.startsWith(`data:`)) {
          // Per SSE spec, strip the optional space after "data:"
          const content = line.slice(5)
          currentEvent.data.push(
            content.startsWith(` `) ? content.slice(1) : content
          )
        }
        // Ignore other fields (id, retry, comments)
      }
    }

    // Handle any remaining data
    const remaining = decoder.decode()
    if (remaining) {
      buffer += remaining
    }

    // Process any final event
    if (buffer && currentEvent.type && currentEvent.data.length > 0) {
      const dataStr = currentEvent.data.join(`\n`)
      if (currentEvent.type === `data`) {
        yield { type: `data`, data: dataStr }
      } else if (currentEvent.type === `control`) {
        try {
          const control = JSON.parse(dataStr) as {
            streamNextOffset: Offset
            streamCursor?: string
            upToDate?: boolean
          }
          yield {
            type: `control`,
            streamNextOffset: control.streamNextOffset,
            streamCursor: control.streamCursor,
            upToDate: control.upToDate,
          }
        } catch {
          // Invalid control event, skip
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}
