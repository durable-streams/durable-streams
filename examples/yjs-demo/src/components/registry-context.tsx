import { createContext, useContext, useEffect, useState } from "react"
import { DurableStream } from "@durable-streams/client"
import { createStreamDB } from "@durable-streams/state"
import { registryStateSchema } from "../utils/schemas"
import { useServerEndpoint } from "../components/server-endpoint-context"
import type { RoomMetadata } from "../utils/schemas"
import type { ReactNode } from "react"

// ============================================================================
// StreamDB Factory with Actions
// ============================================================================

function createRegistryDB(url: string, headers: Record<string, string>) {
  return createStreamDB({
    streamOptions: {
      url,
      headers,
      contentType: `application/json`,
    },
    state: registryStateSchema,
    actions: ({ db, stream }) => ({
      addRoom: {
        onMutate: (metadata: RoomMetadata) => {
          db.collections.rooms.insert(metadata)
        },
        mutationFn: async (metadata: RoomMetadata) => {
          const txid = crypto.randomUUID()
          await stream.append(
            JSON.stringify(
              registryStateSchema.rooms.insert({
                value: metadata,
                headers: { txid },
              })
            )
          )
          await db.utils.awaitTxId(txid)
        },
      },
      deleteRoom: {
        onMutate: (roomId: string) => {
          db.collections.rooms.delete(roomId)
        },
        mutationFn: async (roomId: string) => {
          const txid = crypto.randomUUID()
          await stream.append(
            JSON.stringify(
              registryStateSchema.rooms.delete({
                key: roomId,
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

// ============================================================================
// Context
// ============================================================================

interface RegistryContextValue {
  registryDB: Awaited<ReturnType<typeof createRegistryDB>>
  serverEndpoint: string
  dsEndpoint: string
  yjsHeaders: Record<string, string>
  dsHeaders: Record<string, string>
}

const RegistryContext = createContext<RegistryContextValue | null>(null)

export function useRegistryContext() {
  const context = useContext(RegistryContext)
  if (!context) {
    throw new Error(`useRegistryContext must be used within RegistryProvider`)
  }
  return context
}

// ============================================================================
// Provider
// ============================================================================

interface RegistryState {
  registryDB: Awaited<ReturnType<typeof createRegistryDB>> | null
  error: Error | null
  isLoading: boolean
}

export function RegistryProvider({ children }: { children: ReactNode }) {
  const { serverEndpoint, dsEndpoint, yjsHeaders, dsHeaders } =
    useServerEndpoint()
  const [state, setState] = useState<RegistryState>({
    registryDB: null,
    error: null,
    isLoading: true,
  })

  useEffect(() => {
    let registryDB: Awaited<ReturnType<typeof createRegistryDB>> | null = null
    let cancelled = false

    const initDB = async () => {
      setState({ registryDB: null, error: null, isLoading: true })

      try {
        const registryUrl = `${dsEndpoint}/__yjs_rooms`

        // Create registry stream
        const registryStream = new DurableStream({
          url: registryUrl,
          headers: dsHeaders,
          contentType: `application/json`,
        })

        // Check if registry exists, create it if it doesn't
        const headResult = await registryStream.head()

        if (cancelled) return

        if (!headResult.exists) {
          await DurableStream.create({
            url: registryUrl,
            headers: dsHeaders,
            contentType: `application/json`,
          })
        }

        // Create StreamDB with actions
        registryDB = await createRegistryDB(registryUrl, dsHeaders)

        // Preload the DB
        await registryDB.preload()

        setState({ registryDB, error: null, isLoading: false })
      } catch (err) {
        if (cancelled) return
        console.error(`[Registry] Failed to initialize:`, err)
        setState({
          registryDB: null,
          error: err instanceof Error ? err : new Error(String(err)),
          isLoading: false,
        })
      }
    }

    void initDB()

    return () => {
      cancelled = true
      if (registryDB) {
        registryDB.close()
      }
    }
  }, [dsEndpoint, dsHeaders])

  // Show loading state
  if (state.isLoading) {
    return (
      <div className="registry-loading">
        <div className="empty-state">Loading registry...</div>
      </div>
    )
  }

  // Show error state
  if (state.error || !state.registryDB) {
    return (
      <div className="registry-error">
        <div
          style={{
            padding: `12px`,
            margin: `12px`,
            background: `rgba(244, 135, 113, 0.1)`,
            border: `1px solid #f48771`,
            borderRadius: `4px`,
            fontSize: `12px`,
            color: `#f48771`,
          }}
        >
          <strong>Registry Error:</strong>
          {` `}
          {state.error?.message || `Failed to load`}
        </div>
      </div>
    )
  }

  // Provide context when ready
  return (
    <RegistryContext.Provider
      value={{
        registryDB: state.registryDB,
        serverEndpoint,
        dsEndpoint,
        yjsHeaders,
        dsHeaders,
      }}
    >
      {children}
    </RegistryContext.Provider>
  )
}
