import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react"
import { DurableStream } from "@durable-streams/client"
import { createStreamDB } from "@durable-streams/state"
import { scoresStateSchema } from "../utils/schemas"
import { useServerEndpoint } from "./server-endpoint-context"
import type { ScoreEntry } from "../utils/schemas"
import type { ReactNode } from "react"

function createScoresDB(url: string, headers: Record<string, string>) {
  return createStreamDB({
    streamOptions: {
      url,
      headers,
      contentType: `application/json`,
    },
    state: scoresStateSchema,
    actions: ({ db, stream }) => ({
      submitScore: {
        onMutate: (entry: ScoreEntry) => {
          db.collections.scores.insert(entry)
        },
        mutationFn: async (entry: ScoreEntry) => {
          const txid = crypto.randomUUID()
          await stream.append(
            JSON.stringify(
              scoresStateSchema.scores.insert({
                value: entry,
                headers: { txid },
              })
            )
          )
          await db.utils.awaitTxId(txid)
        },
      },
    }),
  })
}

type ScoresDB = Awaited<ReturnType<typeof createScoresDB>>

interface ScoresContextValue {
  scoresDB: ScoresDB
}

const ScoresContext = createContext<ScoresContextValue | null>(null)

export function useScoresContext() {
  const context = useContext(ScoresContext)
  if (!context) {
    throw new Error(`useScoresContext must be used within ScoresProvider`)
  }
  return context
}

interface ScoresProviderProps {
  roomId: string
  children: ReactNode
}

export function ScoresProvider({ roomId, children }: ScoresProviderProps) {
  const { dsEndpoint, dsHeaders } = useServerEndpoint()
  const [scoresDB, setScoresDB] = useState<ScoresDB | null>(null)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    let db: ScoresDB | null = null
    let cancelled = false
    const isCancelled = () => cancelled

    const init = async () => {
      try {
        const scoresUrl = `${dsEndpoint}/__snake_scores_${encodeURIComponent(roomId)}`

        const stream = new DurableStream({
          url: scoresUrl,
          headers: dsHeaders,
          contentType: `application/json`,
        })

        const headResult = await stream.head()
        if (isCancelled()) return

        if (!headResult.exists) {
          await DurableStream.create({
            url: scoresUrl,
            headers: dsHeaders,
            contentType: `application/json`,
          })
        }

        db = await createScoresDB(scoresUrl, dsHeaders)
        await db.preload()

        if (isCancelled()) return
        setScoresDB(db)
      } catch (err) {
        if (isCancelled()) return
        console.error(`[Scores] Failed to initialize:`, err)
        setError(err instanceof Error ? err : new Error(String(err)))
      }
    }

    void init()

    return () => {
      cancelled = true
      if (db) db.close()
    }
  }, [roomId, dsEndpoint, dsHeaders])

  // Render children even while scores are loading — game shouldn't be blocked
  // ScoresContext will be null until ready, consumers handle that
  if (error) {
    console.warn(`[Scores] Error loading scores:`, error.message)
  }

  if (!scoresDB) {
    return (
      <ScoresContext.Provider value={null as any}>
        {children}
      </ScoresContext.Provider>
    )
  }

  return (
    <ScoresContext.Provider value={{ scoresDB }}>
      {children}
    </ScoresContext.Provider>
  )
}

/**
 * Hook to submit a score and get the current high scores.
 * Returns null if scores are still loading.
 */
export function useRoomScores() {
  const context = useContext(ScoresContext)
  const scoresDB = context?.scoresDB ?? null

  const submitScoreIfHigher = useCallback(
    async (playerName: string, score: number) => {
      if (!scoresDB || score <= 0) return

      // Check current best for this player
      const currentScores = scoresDB.collections.scores.toArray
      const existing = currentScores.find((s) => s.playerName === playerName)

      if (!existing || score > existing.score) {
        await scoresDB.actions.submitScore({
          playerName,
          score,
          timestamp: Date.now(),
        })
      }
    },
    [scoresDB]
  )

  return { scoresDB, submitScoreIfHigher }
}
