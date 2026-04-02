import { useEffect, useState } from "react"
import { DurableStream } from "@durable-streams/client"
import { createStreamDB } from "@durable-streams/state"
import type {
  CreateStreamDBOptions,
  StreamStateDefinition,
} from "@durable-streams/state"

interface UseStreamDBOptions<
  TDef extends StreamStateDefinition,
  TActions extends Record<string, any>,
> extends CreateStreamDBOptions<TDef, TActions> {
  ttlSeconds?: number
}

type InferDB<T> =
  T extends CreateStreamDBOptions<infer TDef, infer TActions>
    ? Awaited<ReturnType<typeof createStreamDB<TDef, TActions>>>
    : never

/**
 * Hook that creates a StreamDB backed by a durable stream.
 * Handles stream creation (if it doesn't exist), preloading, and cleanup.
 */
export function useStreamDB<
  TDef extends StreamStateDefinition,
  TActions extends Record<string, any>,
>(
  options: UseStreamDBOptions<TDef, TActions>
): {
  db: InferDB<typeof options> | null
  isLoading: boolean
  error: Error | null
} {
  const [state, setState] = useState<{
    db: InferDB<typeof options> | null
    isLoading: boolean
    error: Error | null
  }>({
    db: null,
    isLoading: true,
    error: null,
  })

  const url = options.streamOptions.url

  useEffect(() => {
    let db: InferDB<typeof options> | null = null
    const ac = new AbortController()
    const isCancelled = () => ac.signal.aborted

    const init = async () => {
      setState({ db: null, isLoading: true, error: null })

      try {
        const stream = new DurableStream({
          url,
          headers: options.streamOptions.headers,
          contentType: `application/json`,
        })

        const headResult = await stream.head()
        if (isCancelled()) return

        if (!headResult.exists) {
          await DurableStream.create({
            url,
            headers: options.streamOptions.headers,
            contentType: `application/json`,
            ttlSeconds: options.ttlSeconds,
          })
        }

        db = (await createStreamDB(options)) as InferDB<typeof options>
        await db.preload()

        if (isCancelled()) return
        setState({ db, isLoading: false, error: null })
      } catch (err) {
        if (isCancelled()) return
        const error = err instanceof Error ? err : new Error(String(err))
        console.error(`[useStreamDB] Failed to initialize ${url}:`, error)
        setState({ db: null, isLoading: false, error })
      }
    }

    void init()

    return () => {
      ac.abort()
      if (db) db.close()
    }
  }, [url])

  return state
}
