/**
 * Stream session for consuming data from a durable stream.
 */
import { Effect, Option, Ref, Stream } from "effect"
import {
  extractCursor,
  extractOffset,
  isUpToDate,
  type DurableStreamsResponse,
} from "./HttpClient.js"
import type {
  Batch,
  ByteChunk,
  LiveMode,
  Offset,
  StreamSession,
} from "./types.js"

// =============================================================================
// State
// =============================================================================

interface SessionState {
  offset: Offset
  cursor: string | undefined
  upToDate: boolean
  cancelled: boolean
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Create a stream session from an initial response.
 */
export const makeStreamSession = <T>(
  initialResponse: DurableStreamsResponse,
  _fetchNext: (
    offset: Offset,
    cursor: string | undefined
  ) => Effect.Effect<DurableStreamsResponse>,
  options: {
    live: LiveMode
    isJsonMode: boolean
    startOffset: Offset
  }
): Effect.Effect<StreamSession<T>> =>
  Effect.gen(function* () {
    const initialOffset =
      extractOffset(initialResponse.headers) ?? options.startOffset
    const initialCursor = extractCursor(initialResponse.headers)
    const initialUpToDate = isUpToDate(initialResponse.headers)

    const stateRef = yield* Ref.make<SessionState>({
      offset: initialOffset,
      cursor: initialCursor,
      upToDate: initialUpToDate,
      cancelled: false,
    })

    const getOffset = Ref.get(stateRef).pipe(Effect.map((s) => s.offset))
    const getUpToDate = Ref.get(stateRef).pipe(Effect.map((s) => s.upToDate))

    const cancel = (): Effect.Effect<void> =>
      Ref.update(stateRef, (s) => ({ ...s, cancelled: true }))

    const bodyStream = (): Stream.Stream<ByteChunk> =>
      Stream.fromEffect(
        Effect.gen(function* () {
          const body = yield* initialResponse.body
          const state = yield* Ref.get(stateRef)
          const chunk: ByteChunk = {
            data: body,
            offset: state.offset,
            upToDate: state.upToDate,
            cursor: state.cursor,
          }
          return chunk
        })
      )

    const textStream = (): Stream.Stream<string> =>
      Stream.map(bodyStream(), (chunk) =>
        new TextDecoder().decode(chunk.data)
      )

    const jsonStream = (): Stream.Stream<T> =>
      Stream.mapConcat(bodyStream(), (chunk) => {
        const text = new TextDecoder().decode(chunk.data)
        if (!text.trim()) return []

        try {
          const parsed = JSON.parse(text) as T | T[]
          return Array.isArray(parsed) ? parsed : [parsed]
        } catch {
          return []
        }
      })

    const jsonBatches = (): Stream.Stream<Batch<T>> =>
      Stream.filterMap(bodyStream(), (chunk) => {
        const text = new TextDecoder().decode(chunk.data)
        if (!text.trim()) return Option.none()

        try {
          const parsed = JSON.parse(text) as T | T[]
          const items = Array.isArray(parsed) ? parsed : [parsed]
          return Option.some({
            items,
            offset: chunk.offset,
            upToDate: chunk.upToDate,
            cursor: chunk.cursor,
          })
        } catch {
          return Option.none()
        }
      })

    const body = (): Effect.Effect<Uint8Array> =>
      Effect.gen(function* () {
        const chunks: Uint8Array[] = []
        yield* Stream.runForEach(bodyStream(), (chunk) =>
          Effect.sync(() => {
            chunks.push(chunk.data)
          })
        )

        const totalLength = chunks.reduce((sum, c) => sum + c.length, 0)
        const result = new Uint8Array(totalLength)
        let offset = 0
        for (const chunk of chunks) {
          result.set(chunk, offset)
          offset += chunk.length
        }
        return result
      })

    const text = (): Effect.Effect<string> =>
      Effect.map(body(), (bytes) => new TextDecoder().decode(bytes))

    const json = (): Effect.Effect<ReadonlyArray<T>> =>
      Effect.gen(function* () {
        const items: T[] = []
        yield* Stream.runForEach(jsonStream(), (item) =>
          Effect.sync(() => {
            items.push(item)
          })
        )
        return items
      })

    return {
      offset: getOffset,
      upToDate: getUpToDate,
      status: initialResponse.status,
      contentType: initialResponse.contentType,
      body,
      text,
      json,
      bodyStream,
      textStream,
      jsonStream,
      jsonBatches,
      cancel,
    }
  })
