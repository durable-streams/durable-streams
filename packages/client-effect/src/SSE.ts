/**
 * SSE (Server-Sent Events) parsing as Effect.Stream.
 */
import { Effect, Option, Stream } from "effect"
import { SSEParseError } from "./errors.js"
import { SSEFields } from "./types.js"

// =============================================================================
// Types
// =============================================================================

/**
 * A parsed SSE event.
 */
export type SSEEvent = SSEDataEvent | SSEControlEvent

/**
 * SSE data event containing stream data.
 */
export interface SSEDataEvent {
  readonly type: `data`
  readonly data: string
}

/**
 * SSE control event containing metadata.
 */
export interface SSEControlEvent {
  readonly type: `control`
  readonly offset?: string
  readonly cursor?: string
  readonly upToDate: boolean
}

// =============================================================================
// Parser
// =============================================================================

/**
 * Parse a single SSE event from lines.
 */
const parseSSEEvent = (
  lines: ReadonlyArray<string>
): SSEEvent | null => {
  let eventType = `data`
  let data = ``

  for (const line of lines) {
    if (line.startsWith(`event:`)) {
      eventType = line.slice(6).trim()
    } else if (line.startsWith(`data:`)) {
      if (data) data += `\n`
      data += line.slice(5).trim()
    }
  }

  if (!data) {
    return null
  }

  if (eventType === `control`) {
    try {
      const parsed = JSON.parse(data) as Record<string, unknown>
      const offset = typeof parsed[SSEFields.Offset] === `string`
        ? parsed[SSEFields.Offset] as string
        : undefined
      const cursor = typeof parsed[SSEFields.Cursor] === `string`
        ? parsed[SSEFields.Cursor] as string
        : undefined
      return {
        type: `control`,
        offset,
        cursor,
        upToDate: true,
      }
    } catch {
      return null
    }
  }

  return {
    type: `data`,
    data,
  }
}

/**
 * Parse a ReadableStream of bytes into SSE events.
 */
export const parseSSEStream = (
  stream: ReadableStream<Uint8Array>
): Stream.Stream<SSEEvent, SSEParseError> => {
  const decoder = new TextDecoder()
  let buffer = ``

  return Stream.fromReadableStream(
    () => stream,
    (error) =>
      new SSEParseError({ message: `Stream error: ${String(error)}` })
  ).pipe(
    Stream.mapConcat((chunk) => {
      buffer += decoder.decode(chunk, { stream: true })
      const events: SSEEvent[] = []

      // Split by double newline (SSE event separator)
      const parts = buffer.split(`\n\n`)
      buffer = parts.pop() ?? ``

      for (const part of parts) {
        if (!part.trim()) continue

        const lines = part.split(`\n`)
        const event = parseSSEEvent(lines)
        if (event) {
          events.push(event)
        }
      }

      return events
    })
  )
}

/**
 * Filter SSE stream to only data events.
 */
export const filterDataEvents = (
  stream: Stream.Stream<SSEEvent, SSEParseError>
): Stream.Stream<string, SSEParseError> =>
  Stream.filterMap(stream, (event) =>
    event.type === `data` ? Option.some(event.data) : Option.none()
  )

/**
 * Extract control event from SSE stream.
 * Returns the first control event encountered.
 */
export const findControlEvent = (
  stream: Stream.Stream<SSEEvent, SSEParseError>
): Effect.Effect<SSEControlEvent | null, SSEParseError> =>
  Stream.runHead(
    Stream.filter(stream, (event): event is SSEControlEvent =>
      event.type === `control`
    )
  ).pipe(Effect.map((opt) => Option.getOrNull(opt)))

/**
 * Parse SSE stream and collect data with final control event.
 */
export interface SSEResult {
  readonly data: ReadonlyArray<string>
  readonly offset?: string
  readonly cursor?: string
  readonly upToDate: boolean
}

/**
 * Collect all SSE data events and the final control event.
 */
export const collectSSE = (
  stream: ReadableStream<Uint8Array>
): Effect.Effect<SSEResult, SSEParseError> =>
  Effect.gen(function* () {
    const data: string[] = []
    let offset: string | undefined
    let cursor: string | undefined
    let upToDate = false

    yield* Stream.runForEach(parseSSEStream(stream), (event) =>
      Effect.sync(() => {
        if (event.type === `data`) {
          data.push(event.data)
        } else {
          offset = event.offset ?? offset
          cursor = event.cursor ?? cursor
          upToDate = event.upToDate
        }
      })
    )

    return { data, offset, cursor, upToDate }
  })
