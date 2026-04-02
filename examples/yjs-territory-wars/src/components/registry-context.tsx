import { createContext, useContext } from "react"
import { REGISTRY_TTL_SECONDS, registryStateSchema } from "../utils/schemas"
import { useStreamDB } from "../hooks/use-stream-db"
import { useServerEndpoint } from "./server-endpoint-context"
import type { createStreamDB } from "@durable-streams/state"
import type { RoomMetadata } from "../utils/schemas"
import type { ReactNode } from "react"

function registryDBOptions(url: string, headers: Record<string, string>) {
  return {
    streamOptions: { url, headers, contentType: `application/json` as const },
    state: registryStateSchema,
    ttlSeconds: REGISTRY_TTL_SECONDS,
    actions: ({ db, stream }: any) => ({
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
  }
}

// Keep the concrete type from createStreamDB so consumers get typed collections/actions
type RegistryDBOptions = ReturnType<typeof registryDBOptions>
export type RegistryDB = Awaited<
  ReturnType<
    typeof createStreamDB<
      RegistryDBOptions[`state`],
      ReturnType<RegistryDBOptions[`actions`]>
    >
  >
>

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

export function RegistryProvider({ children }: { children: ReactNode }) {
  const { dsEndpoint, dsHeaders } = useServerEndpoint()
  const { db, isLoading, error } = useStreamDB(
    registryDBOptions(`${dsEndpoint}/__snake_rooms`, dsHeaders)
  )

  if (isLoading) {
    return (
      <div style={styles.center}>
        <style>{`@import url('https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap');`}</style>
        <div style={{ color: `#d0bcff`, fontSize: 8 }}>LOADING...</div>
      </div>
    )
  }

  if (error || !db) {
    return (
      <div style={styles.center}>
        <style>{`@import url('https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap');`}</style>
        <div style={{ color: `#FF3D71`, fontSize: 8 }}>
          Registry Error: {error?.message || `Failed to load`}
        </div>
      </div>
    )
  }

  return (
    <RegistryContext.Provider value={{ registryDB: db as RegistryDB }}>
      {children}
    </RegistryContext.Provider>
  )
}

const styles = {
  center: {
    display: `flex`,
    flexDirection: `column` as const,
    alignItems: `center`,
    justifyContent: `center`,
    height: `100vh`,
    gap: 16,
    fontFamily: `'Press Start 2P', monospace`,
    background: `#1b1b1f`,
  },
}
