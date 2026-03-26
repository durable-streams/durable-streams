import { createContext, useContext, useMemo } from "react"
import type { ReactNode } from "react"

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
  if (import.meta.env.VITE_YJS_URL) {
    return import.meta.env.VITE_YJS_URL
  }
  const origin =
    typeof window !== `undefined`
      ? window.location.origin
      : `https://localhost:4444`
  return `${origin}/v1/yjs/snake`
}

function getDsEndpoint(): string {
  if (import.meta.env.VITE_DS_URL) {
    return import.meta.env.VITE_DS_URL
  }
  const origin =
    typeof window !== `undefined`
      ? window.location.origin
      : `https://localhost:4444`
  return `${origin}/v1/stream`
}

function getYjsHeaders(): Record<string, string> {
  const token = import.meta.env.VITE_YJS_TOKEN
  if (token) {
    return { Authorization: `Bearer ${token}` }
  }
  return {}
}

function getDsHeaders(): Record<string, string> {
  const token = import.meta.env.VITE_DS_TOKEN
  if (token) {
    return { Authorization: `Bearer ${token}` }
  }
  return {}
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
