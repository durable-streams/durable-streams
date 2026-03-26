import { createContext, useContext, useMemo } from "react"
import type { ReactNode } from "react"

// Hardcoded defaults for the hosted demo.
// Override with VITE_YJS_URL / VITE_DS_URL env vars for other deployments.
const DEMO_YJS_URL = `https://api-pr-1381.electric-sql.dev/v1/yjs/svc-yjs-uptight-guan-v9uu1ohxuq`
const DEMO_YJS_TOKEN = `eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJzZXJ2aWNlX2lkIjoic3ZjLXlqcy11cHRpZ2h0LWd1YW4tdjl1dTFvaHh1cSIsImlhdCI6MTc3NDUyOTYyNX0.w8lmZMNZhnxm7qZzgEFU1J646TA88b87fTjXH6zwkEs`
const DEMO_DS_URL = `https://api-pr-1381.electric-sql.dev/v1/stream/svc-light-wren-58kdb6p2hz`
const DEMO_DS_TOKEN = `eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJzZXJ2aWNlX2lkIjoic3ZjLWxpZ2h0LXdyZW4tNThrZGI2cDJoeiIsImlhdCI6MTc3NDUyOTY3NX0.1C_Mq_W5LuS8PSC933l9IQUykmAf3Wu3J9ZXy0Cg1Xw`

interface ServerEndpointContextValue {
  yjsEndpoint: string
  dsEndpoint: string
  yjsHeaders: Record<string, string>
  dsHeaders: Record<string, string>
}

const ServerEndpointContext = createContext<ServerEndpointContextValue | null>(
  null
)

export function useServerEndpoint(): ServerEndpointContextValue {
  const context = useContext(ServerEndpointContext)
  if (!context) {
    throw new Error(
      `useServerEndpoint must be used within ServerEndpointProvider`
    )
  }
  return context
}

function getYjsEndpoint(): string {
  return import.meta.env.VITE_YJS_URL || DEMO_YJS_URL
}

function getDsEndpoint(): string {
  return import.meta.env.VITE_DS_URL || DEMO_DS_URL
}

function getYjsHeaders(): Record<string, string> {
  const token = import.meta.env.VITE_YJS_TOKEN || DEMO_YJS_TOKEN
  return { Authorization: `Bearer ${token}` }
}

function getDsHeaders(): Record<string, string> {
  const token = import.meta.env.VITE_DS_TOKEN || DEMO_DS_TOKEN
  return { Authorization: `Bearer ${token}` }
}

export function ServerEndpointProvider({ children }: { children: ReactNode }) {
  const yjsEndpoint = getYjsEndpoint()
  const dsEndpoint = getDsEndpoint()
  const yjsHeaders = useMemo(() => getYjsHeaders(), [])
  const dsHeaders = useMemo(() => getDsHeaders(), [])

  const value = useMemo<ServerEndpointContextValue>(
    () => ({ yjsEndpoint, dsEndpoint, yjsHeaders, dsHeaders }),
    [yjsEndpoint, dsEndpoint, yjsHeaders, dsHeaders]
  )

  return (
    <ServerEndpointContext.Provider value={value}>
      {children}
    </ServerEndpointContext.Provider>
  )
}
