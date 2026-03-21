import { createContext, useContext } from "react"
import type { ReactNode } from "react"

// ============================================================================
// Context
// ============================================================================

interface ServerEndpointContextValue {
  serverEndpoint: string
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

// ============================================================================
// Provider
// ============================================================================

/**
 * Get the server endpoint URL.
 *
 * Uses VITE_YJS_URL or VITE_SERVER_URL environment variable or falls back to the
 * current hostname with default Yjs server port (4438).
 */
function getServerEndpoint(): string {
  if (import.meta.env.VITE_YJS_URL) {
    return import.meta.env.VITE_YJS_URL
  }

  if (import.meta.env.VITE_SERVER_URL) {
    return import.meta.env.VITE_SERVER_URL
  }

  // Same origin — Caddy proxies everything
  return typeof window !== `undefined`
    ? window.location.origin
    : `https://localhost:4443`
}

function getDsEndpoint(): string {
  if (import.meta.env.VITE_DS_URL) {
    return import.meta.env.VITE_DS_URL
  }

  // Same origin — Caddy proxies everything
  return typeof window !== `undefined`
    ? window.location.origin
    : `https://localhost:4443`
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
  const serverEndpoint = getServerEndpoint()
  const dsEndpoint = getDsEndpoint()
  const yjsHeaders = getYjsHeaders()
  const dsHeaders = getDsHeaders()

  const value: ServerEndpointContextValue = {
    serverEndpoint,
    dsEndpoint,
    yjsHeaders,
    dsHeaders,
  }

  return (
    <ServerEndpointContext.Provider value={value}>
      {children}
    </ServerEndpointContext.Provider>
  )
}
