import { createContext, useContext, useMemo } from "react"
import type { ReactNode } from "react"

// Hardcoded defaults for the hosted demo.
// Override with VITE_YJS_URL / VITE_DS_URL env vars for other deployments.
const DEMO_YJS_URL = `https://api.electric-sql.cloud/v1/yjs/svc-yjs-deaf-toucan-o6vsn08e5t`
const DEMO_YJS_TOKEN = `eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJzZXJ2aWNlX2lkIjoic3ZjLXlqcy1kZWFmLXRvdWNhbi1vNnZzbjA4ZTV0IiwiaWF0IjoxNzc0NjI2MTIxfQ.2fYxPAYFGkKh-5N41Auj9RIqSCJ8g9UQy1QxJoKzNl0`
const DEMO_DS_URL = `https://api.electric-sql.cloud/v1/stream/svc-irrelevant-aardwolf-optt07siiw`
const DEMO_DS_TOKEN = `eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJzZXJ2aWNlX2lkIjoic3ZjLWlycmVsZXZhbnQtYWFyZHdvbGYtb3B0dDA3c2lpdyIsImlhdCI6MTc3NDYyNjE2Mn0.k2GHVroWJH69qAyVGot8Oc2kiXeYFAocSxRUojz5GmY`

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
