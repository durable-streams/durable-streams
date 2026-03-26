import { createContext, useContext, useEffect, useState } from "react"
import { DurableStream } from "@durable-streams/client"
import { createStreamDB } from "@durable-streams/state"
import { ROOM_TTL_SECONDS, registryStateSchema } from "../utils/schemas"
import { useServerEndpoint } from "./server-endpoint-context"
import type { RoomMetadata } from "../utils/schemas"
import type { ReactNode } from "react"

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

export type RegistryDB = Awaited<ReturnType<typeof createRegistryDB>>

interface RegistryContextValue {
  registryDB: RegistryDB
}

const RegistryContext = createContext<RegistryContextValue | null>(null)

export function useRegistryContext() {
  const context = useContext(RegistryContext)
  if (!context) {
    throw new Error(`useRegistryContext must be used within RegistryProvider`)
  }
  return context
}

interface RegistryState {
  registryDB: RegistryDB | null
  error: Error | null
  isLoading: boolean
}

export function RegistryProvider({ children }: { children: ReactNode }) {
  const { dsEndpoint, dsHeaders } = useServerEndpoint()
  const [state, setState] = useState<RegistryState>({
    registryDB: null,
    error: null,
    isLoading: true,
  })

  useEffect(() => {
    let registryDB: RegistryDB | null = null
    let cancelled = false
    const isCancelled = () => cancelled

    const initDB = async () => {
      setState({ registryDB: null, error: null, isLoading: true })

      try {
        const registryUrl = `${dsEndpoint}/__snake_rooms`

        const registryStream = new DurableStream({
          url: registryUrl,
          headers: dsHeaders,
          contentType: `application/json`,
        })

        const headResult = await registryStream.head()
        if (isCancelled()) return

        if (!headResult.exists) {
          await DurableStream.create({
            url: registryUrl,
            headers: dsHeaders,
            contentType: `application/json`,
            ttlSeconds: ROOM_TTL_SECONDS,
          })
        }

        registryDB = await createRegistryDB(registryUrl, dsHeaders)
        await registryDB.preload()

        if (isCancelled()) return
        setState({ registryDB, error: null, isLoading: false })
      } catch (err) {
        if (isCancelled()) return
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

  if (state.isLoading) {
    return (
      <div
        style={{
          display: `flex`,
          alignItems: `center`,
          justifyContent: `center`,
          height: `100vh`,
          fontFamily: `'JetBrains Mono', monospace`,
          background: `#0B0E17`,
          color: `#8892B0`,
          fontSize: 14,
        }}
      >
        Loading room registry...
      </div>
    )
  }

  if (state.error || !state.registryDB) {
    return (
      <div
        style={{
          display: `flex`,
          flexDirection: `column`,
          alignItems: `center`,
          justifyContent: `center`,
          height: `100vh`,
          gap: 12,
          fontFamily: `'JetBrains Mono', monospace`,
          background: `#0B0E17`,
        }}
      >
        <div style={{ color: `#FF3D71`, fontSize: 14 }}>
          Registry Error: {state.error?.message || `Failed to load`}
        </div>
      </div>
    )
  }

  return (
    <RegistryContext.Provider value={{ registryDB: state.registryDB }}>
      {children}
    </RegistryContext.Provider>
  )
}
