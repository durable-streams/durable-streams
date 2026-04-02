import { useEffect, useState } from "react"
import { DurableStream } from "@durable-streams/client"
import { createStreamDB } from "@durable-streams/state"
import type { CreateStreamDBOptions } from "@durable-streams/state"

type AnyStreamDBOptions = CreateStreamDBOptions<any, any>
type AnyStreamDB = Awaited<ReturnType<typeof createStreamDB<any, any>>>

interface UseStreamDBOptions extends AnyStreamDBOptions {
  /** TTL in seconds when creating the stream for the first time */
  ttlSeconds?: number
}

interface UseStreamDBResult {
  db: AnyStreamDB | null
  isLoading: boolean
  error: Error | null
}

/**
 * Hook that creates a StreamDB backed by a durable stream.
 * Handles stream creation (if it doesn't exist), preloading, and cleanup.
 */
export function useStreamDB(options: UseStreamDBOptions): UseStreamDBResult {
  const [state, setState] = useState<UseStreamDBResult>({
    db: null,
    isLoading: true,
    error: null,
  })

  const url = options.streamOptions.url

  useEffect(() => {
    let db: AnyStreamDB | null = null
    const ac = new AbortController()

    const init = async () => {
      setState({ db: null, isLoading: true, error: null })

      try {
        const stream = new DurableStream({
          url,
          headers: options.streamOptions.headers,
          contentType: `application/json`,
        })

        const headResult = await stream.head()
        if (ac.signal.aborted) return

        if (!headResult.exists) {
          await DurableStream.create({
            url,
            headers: options.streamOptions.headers,
            contentType: `application/json`,
            ttlSeconds: options.ttlSeconds,
          })
        }

        db = await createStreamDB(options)
        await db.preload()

        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (ac.signal.aborted) return
        setState({ db, isLoading: false, error: null })
      } catch (err) {
        if (ac.signal.aborted) return
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
