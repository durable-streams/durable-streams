import { createContext, useContext } from "react"
import type { ReactNode } from "react"

// ============================================================================
// Context
// ============================================================================

interface ServerEndpointContextValue {
  serverEndpoint: string
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
 * Uses VITE_SERVER_URL environment variable or falls back to the
 * current hostname with default Yjs server port (4438).
 */
function getServerEndpoint(): string {
  // Use environment variable if set
  if (import.meta.env.VITE_SERVER_URL) {
    return import.meta.env.VITE_SERVER_URL
  }

  // Fallback: use current hostname with default Yjs server port
  const hostname =
    typeof window !== `undefined` ? window.location.hostname : `localhost`
  return `http://${hostname}:4438`
}

export function ServerEndpointProvider({ children }: { children: ReactNode }) {
  const serverEndpoint = getServerEndpoint()

  const value: ServerEndpointContextValue = {
    serverEndpoint,
  }

  return (
    <ServerEndpointContext.Provider value={value}>
      {children}
    </ServerEndpointContext.Provider>
  )
}
