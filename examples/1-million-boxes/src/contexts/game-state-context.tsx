import { createContext, useCallback, useContext, useRef, useState } from "react"
import { GameState } from "../lib/game-state"
import { useGameStream } from "../hooks/useGameStream"
import { drawEdge } from "../server/functions"
import { useTeam } from "./team-context"
import { useQuota } from "./quota-context"
import type { GameEvent } from "../lib/game-state"
import type { ReactNode } from "react"

export interface GameStateContextValue {
  gameState: GameState
  pendingEdge: number | null
  placeEdge: (edgeId: number) => void
  isConnected: boolean
  isLoading: boolean
  error: string | null
  version: number
}

const GameStateContext = createContext<GameStateContextValue | null>(null)

export interface GameStateProviderProps {
  children: ReactNode
}

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

  // Get team and quota from contexts
  const { teamId } = useTeam()
  const { consume, refund } = useQuota()

  // Handle events from stream
  const handleEvents = useCallback((events: Array<GameEvent>) => {
    for (const event of events) {
      gameStateRef.current.applyEvent(event)
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
    setIsLoading(false)
  }, [])

  // Handle connection events
  const handleConnected = useCallback(() => {
    setIsConnected(true)
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
        const response = await drawEdge({ data: { edgeId } })

        if (response.ok) {
          // Success - edge will be confirmed via stream
          setError(null)
        } else {
          // Handle error codes
          switch (response.code) {
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
              setError(`Failed to place edge: ${response.code}`)
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
