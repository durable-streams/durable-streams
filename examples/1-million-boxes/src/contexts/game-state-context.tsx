import { createContext, useCallback, useContext, useRef, useState } from "react"
import { GameState } from "../lib/game-state"
import { useGameStream } from "../hooks/useGameStream"
import { useTeam } from "./team-context"
import { useQuota } from "./quota-context"
import type { GameEvent } from "../lib/game-state"
import type { ReactNode } from "react"

export interface RecentEvent {
  edgeId: number
  teamId: number
  timestamp: number
}

export interface GameStateContextValue {
  gameState: GameState
  pendingEdge: number | null
  placeEdge: (edgeId: number) => void
  isConnected: boolean
  isLoading: boolean
  error: string | null
  version: number
  recentEvents: Array<RecentEvent>
}

const GameStateContext = createContext<GameStateContextValue | null>(null)

export interface GameStateProviderProps {
  children: ReactNode
}

// How long to keep recent events for animation (ms)
const RECENT_EVENT_TTL = 1000

export function GameStateProvider({ children }: GameStateProviderProps) {
  // Use a ref for the game state to avoid re-renders on every event
  const gameStateRef = useRef<GameState>(new GameState())

  // Version counter to trigger re-renders when needed
  const [version, setVersion] = useState(0)

  // UI state
  const [pendingEdge, setPendingEdge] = useState<number | null>(null)
  const [isConnected, setIsConnected] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Track recent events for minimap pop animation
  const [recentEvents, setRecentEvents] = useState<Array<RecentEvent>>([])

  // Track if initial sync is complete (don't show pops during replay)
  const initialSyncCompleteRef = useRef(false)

  // Get team and quota from contexts
  const { teamId } = useTeam()
  const { consume, refund } = useQuota()

  // Handle events from stream
  const handleEvents = useCallback((events: Array<GameEvent>) => {
    const now = Date.now()
    const newRecentEvents: Array<RecentEvent> = []

    for (const event of events) {
      gameStateRef.current.applyEvent(event)

      // Track for pop animation (only edge events, and only after initial sync)
      if (
        initialSyncCompleteRef.current &&
        `edgeId` in event &&
        `teamId` in event
      ) {
        newRecentEvents.push({
          edgeId: event.edgeId,
          teamId: event.teamId,
          timestamp: now,
        })
      }
    }

    // Add new events to recent list and clean up old ones
    if (newRecentEvents.length > 0) {
      setRecentEvents((prev) => {
        const cutoff = now - RECENT_EVENT_TTL
        const filtered = prev.filter((e) => e.timestamp > cutoff)
        return [...filtered, ...newRecentEvents]
      })
    }

    // Clear pending edge if it was confirmed
    setPendingEdge((current) => {
      if (current !== null) {
        // Check if pending edge was placed
        if (gameStateRef.current.isEdgeTaken(current)) {
          return null
        }
      }
      return current
    })

    // Trigger re-render
    setVersion((v) => v + 1)

    // Mark initial sync as complete after first batch of events
    if (!initialSyncCompleteRef.current) {
      // Use a small delay to ensure we skip any initial batch
      setTimeout(() => {
        initialSyncCompleteRef.current = true
      }, 100)
    }
    setIsLoading(false)
  }, [])

  // Handle connection events
  const handleConnected = useCallback(() => {
    setIsConnected(true)
    setIsLoading(false)
    setError(null)
  }, [])

  const handleDisconnected = useCallback(() => {
    setIsConnected(false)
  }, [])

  const handleError = useCallback((err: Error) => {
    setError(err.message)
  }, [])

  // Connect to game stream
  useGameStream({
    onEvents: handleEvents,
    onError: handleError,
    onConnected: handleConnected,
    onDisconnected: handleDisconnected,
  })

  // Place an edge on the board
  const placeEdge = useCallback(
    async (edgeId: number) => {
      // Check if edge is already taken
      if (gameStateRef.current.isEdgeTaken(edgeId)) {
        return
      }

      // Check if we have quota
      if (!consume()) {
        setError(`Rate limited - please wait`)
        return
      }

      // Set pending edge for optimistic UI
      setPendingEdge(edgeId)

      try {
        const response = await fetch(`/api/draw`, {
          method: `POST`,
          headers: { "Content-Type": `application/json` },
          body: JSON.stringify({ edgeId }),
        })
        const result = await response.json()

        if (result.ok) {
          // Success - edge will be confirmed via stream
          setError(null)
        } else {
          // Handle error codes
          switch (result.code) {
            case `EDGE_TAKEN`:
              // Refund quota since edge was already taken
              refund()
              setError(null) // Not really an error, just already taken
              break
            case `NO_TEAM`:
              refund()
              setError(`No team assigned - please refresh`)
              break
            case `GAME_COMPLETE`:
              refund()
              setError(`Game is complete!`)
              break
            case `INVALID_EDGE`:
              refund()
              setError(`Invalid edge`)
              break
            case `WARMING_UP`:
              refund()
              setError(`Server is starting up - please try again`)
              break
            case `STREAM_ERROR`:
              refund()
              setError(`Stream error - please try again`)
              break
            default:
              refund()
              setError(`Failed to place edge: ${result.code}`)
          }

          // Clear pending edge on error
          setPendingEdge(null)
        }
      } catch (err) {
        // Network error
        refund()
        setPendingEdge(null)
        setError(err instanceof Error ? err.message : `Failed to place edge`)
      }
    },
    [consume, refund, teamId]
  )

  const value: GameStateContextValue = {
    gameState: gameStateRef.current,
    pendingEdge,
    placeEdge,
    isConnected,
    isLoading,
    error,
    version,
    recentEvents,
  }

  return (
    <GameStateContext.Provider value={value}>
      {children}
    </GameStateContext.Provider>
  )
}

export function useGameStateContext(): GameStateContextValue {
  const ctx = useContext(GameStateContext)
  if (!ctx) {
    throw new Error(`useGameStateContext must be used within GameStateProvider`)
  }
  return ctx
}
