import { createContext, useContext, useEffect, useMemo, useState } from "react"
import { DurableStream } from "@durable-streams/client"
import { createStreamDB } from "@durable-streams/state"
import { presenceStateSchema, registryStateSchema } from "./schemas"
import type { ReactNode } from "react"
import type { StreamDB } from "@durable-streams/state"

const SERVER_URL = `http://${typeof window !== `undefined` ? window.location.hostname : `localhost`}:8787`

// ============================================================================
// User Identity Utilities
// ============================================================================

export function getUserId(): string {
  let userId = localStorage.getItem(`durable-streams-user-id`)
  if (!userId) {
    userId = `user-${crypto.randomUUID()}`
    try {
      localStorage.setItem(`durable-streams-user-id`, userId)
    } catch {
      // Fallback for privacy mode
      sessionStorage.setItem(`durable-streams-user-id`, userId)
    }
  }
  return userId
}

export function getSessionId(): string {
  let sessionId = sessionStorage.getItem(`durable-streams-session-id`)
  if (!sessionId) {
    sessionId = `session-${crypto.randomUUID()}`
    sessionStorage.setItem(`durable-streams-session-id`, sessionId)
  }
  return sessionId
}

export function getUserColor(userId: string): string {
  const colors = [
    `#d4704b`,
    `#7a9a7e`,
    `#c8886d`,
    `#6b8e8d`,
    `#d4a05b`,
    `#8b7a9a`,
    `#9a7a7e`,
  ]
  const hash = userId
    .split(``)
    .reduce((acc, char) => acc + char.charCodeAt(0), 0)
  return colors[hash % colors.length]
}

// ============================================================================
// Context
// ============================================================================

interface StreamDBContextValue {
  registryDB: StreamDB<typeof registryStateSchema>
  presenceDB: StreamDB<typeof presenceStateSchema>
  registryStream: DurableStream
  presenceStream: DurableStream
  userId: string
  sessionId: string
  userColor: string
}

const StreamDBContext = createContext<StreamDBContextValue | null>(null)

export function useStreamDB() {
  const context = useContext(StreamDBContext)
  if (!context) {
    throw new Error(`useStreamDB must be used within StreamDBProvider`)
  }
  return context
}

// ============================================================================
// Provider
// ============================================================================

export function StreamDBProvider({ children }: { children: ReactNode }) {
  const [dbs, setDBs] = useState<StreamDBContextValue | null>(null)
  const userId = useMemo(() => getUserId(), [])
  const sessionId = useMemo(() => getSessionId(), [])
  const userColor = useMemo(() => getUserColor(userId), [userId])

  useEffect(() => {
    let registryDB: StreamDB<typeof registryStateSchema> | null = null
    let presenceDB: StreamDB<typeof presenceStateSchema> | null = null
    let cancelled = false

    const initDBs = async () => {
      // Create registry stream
      const registryStream = new DurableStream({
        url: `${SERVER_URL}/v1/stream/__registry__`,
      })

      // Check if registry exists, create it if it doesn't
      const registryExists = await registryStream.head().catch(() => null)

      if (cancelled) return

      if (!registryExists) {
        await DurableStream.create({
          url: `${SERVER_URL}/v1/stream/__registry__`,
          contentType: `application/json`,
        })
      }
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (cancelled) return

      // Create presence stream
      const presenceStream = new DurableStream({
        url: `${SERVER_URL}/v1/stream/__presence__`,
      })

      // Check if presence exists, create it if it doesn't
      const presenceExists = await presenceStream.head().catch(() => null)
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (cancelled) return

      if (!presenceExists) {
        await DurableStream.create({
          url: `${SERVER_URL}/v1/stream/__presence__`,
          contentType: `application/json`,
        })
      }
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (cancelled) return

      // Create StreamDBs
      registryDB = await createStreamDB({
        stream: registryStream,
        state: registryStateSchema,
      })
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (cancelled) {
        registryDB.close()
        return
      }

      presenceDB = await createStreamDB({
        stream: presenceStream,
        state: presenceStateSchema,
      })
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (cancelled) {
        registryDB.close()
        presenceDB.close()
        return
      }

      // Preload both DBs
      await Promise.all([registryDB.preload(), presenceDB.preload()])
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (cancelled) {
        registryDB.close()
        presenceDB.close()
        return
      }

      setDBs({
        registryDB,
        presenceDB,
        registryStream,
        presenceStream,
        userId,
        sessionId,
        userColor,
      })
    }

    void initDBs()

    return () => {
      // Mark as cancelled to prevent setState after unmount
      cancelled = true

      // Close the DBs created in this effect, not from state
      if (registryDB) {
        registryDB.close()
      }
      if (presenceDB) {
        presenceDB.close()
      }
    }
  }, [])

  if (!dbs) {
    return (
      <div
        style={{
          display: `flex`,
          alignItems: `center`,
          justifyContent: `center`,
          height: `100vh`,
          color: `var(--text-dim)`,
          fontSize: `13px`,
        }}
      >
        Loading streams...
      </div>
    )
  }

  return (
    <StreamDBContext.Provider value={dbs}>{children}</StreamDBContext.Provider>
  )
}
