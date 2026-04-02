import { createContext, useCallback, useContext } from "react"
import { scoresStateSchema } from "../utils/schemas"
import { useStreamDB } from "../hooks/use-stream-db"
import { useServerEndpoint } from "./server-endpoint-context"
import type { createStreamDB } from "@durable-streams/state"
import type { ScoreEntry } from "../utils/schemas"
import type { ReactNode } from "react"

function scoresDBOptions(url: string, headers: Record<string, string>) {
  return {
    streamOptions: { url, headers, contentType: `application/json` as const },
    state: scoresStateSchema,
    actions: ({ db, stream }: any) => ({
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
  }
}

type ScoresDBOptions = ReturnType<typeof scoresDBOptions>
type ScoresDB = Awaited<
  ReturnType<
    typeof createStreamDB<
      ScoresDBOptions[`state`],
      ReturnType<ScoresDBOptions[`actions`]>
    >
  >
>

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
  const { db, error } = useStreamDB(
    scoresDBOptions(
      `${dsEndpoint}/__snake_scores_${encodeURIComponent(roomId)}`,
      dsHeaders
    )
  )

  if (error) {
    console.warn(`[Scores] Error loading scores:`, error.message)
  }

  // Render children even while scores are loading — game shouldn't be blocked
  return (
    <ScoresContext.Provider
      value={db ? { scoresDB: db as ScoresDB } : (null as any)}
    >
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
