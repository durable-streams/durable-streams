import { createContext, useContext, useMemo } from "react"
import type { ReactNode } from "react"

// Configure these environment variables to connect to your Electric Cloud services.
// See README.md for setup instructions.

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

function required(name: string): string {
  const value = import.meta.env[name]
  if (!value) throw new Error(`Missing environment variable: ${name}`)
  return value
}

export function ServerEndpointProvider({ children }: { children: ReactNode }) {
  const yjsEndpoint = required(`VITE_YJS_URL`)
  const dsEndpoint = required(`VITE_DS_URL`)
  const yjsHeaders = useMemo(() => {
    const token = required(`VITE_YJS_TOKEN`)
    return { Authorization: `Bearer ${token}` }
  }, [])
  const dsHeaders = useMemo(() => {
    const token = required(`VITE_DS_TOKEN`)
    return { Authorization: `Bearer ${token}` }
  }, [])

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
