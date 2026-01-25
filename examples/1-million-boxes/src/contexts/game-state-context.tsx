import { createContext, useCallback, useContext, useRef, useState } from "react"
import { GameState } from "../lib/game-state"
import { BoxBitmap } from "../lib/box-bitmap"
import { useGameStream } from "../hooks/useGameStream"
import { useTeam } from "./team-context"
import { useQuota } from "./quota-context"
import type { GameEvent } from "../lib/game-state"
import type { ReactNode } from "react"

export interface RecentEvent {
  id: number
  edgeId: number
  teamId: number
  timestamp: number
  isLocal: boolean // true if placed by the current user
}

export interface GameStateContextValue {
  gameState: GameState
  boxBitmap: BoxBitmap
  pendingEdge: number | null
  placeEdge: (edgeId: number) => void
  isConnected: boolean
  isLoading: boolean
  isReadyToRender: boolean
  notifyCanvasRendered: () => void
  error: string | null
  version: number
  recentEvents: Array<RecentEvent>
  isGameComplete: boolean
  winner: number | null // teamId (0-3) or null if tie
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

  // Shared bitmap for rendering (1px per box, used by minimap and main canvas)
  const boxBitmapRef = useRef<BoxBitmap>(new BoxBitmap())

  // Version counter to trigger re-renders when needed
  const [version, setVersion] = useState(0)

  // UI state
  const [pendingEdge, setPendingEdge] = useState<number | null>(null)
  const [isConnected, setIsConnected] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [isReadyToRender, setIsReadyToRender] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Track recent events for minimap pop animation
  const [recentEvents, setRecentEvents] = useState<Array<RecentEvent>>([])
  const eventIdRef = useRef(0)
  // Track edge IDs placed by the local user (to identify local vs remote events)
  const localEdgeIdsRef = useRef<Set<number>>(new Set())

  // Track if initial sync is complete (don't show pops during replay, don't render during catchup)
  const initialSyncCompleteRef = useRef(false)
  const pendingFirstRenderRef = useRef(false)

  // 60fps render throttling - only update version once per frame
  const renderScheduledRef = useRef(false)
  const pendingRecentEventsRef = useRef<Array<RecentEvent>>([])
  const bitmapDirtyRef = useRef(false)

  // Get team and quota from contexts
  const { teamId } = useTeam()
  const { consume, syncFromServer, refund } = useQuota()

  // Schedule a render for next animation frame (60fps throttle)
  const scheduleRender = useCallback(() => {
    if (renderScheduledRef.current) return

    renderScheduledRef.current = true
    requestAnimationFrame(() => {
      renderScheduledRef.current = false

      // Commit bitmap if dirty
      if (bitmapDirtyRef.current) {
        boxBitmapRef.current.commit()
        bitmapDirtyRef.current = false
      }

      // Add pending recent events
      if (pendingRecentEventsRef.current.length > 0) {
        const newEvents = pendingRecentEventsRef.current
        pendingRecentEventsRef.current = []
        const now = Date.now()
        setRecentEvents((prev) => {
          const cutoff = now - RECENT_EVENT_TTL
          const filtered = prev.filter((e) => e.timestamp > cutoff)
          return [...filtered, ...newEvents]
        })
      }

      // Trigger re-render
      setVersion((v) => v + 1)
    })
  }, [])

  // Handle events from stream
  const handleEvents = useCallback(
    (events: Array<GameEvent>, upToDate: boolean) => {
      const now = Date.now()

      for (const event of events) {
        const { boxesClaimed } = gameStateRef.current.applyEvent(event)

        // Update bitmap pixels (but don't commit yet - batch for frame)
        for (const boxId of boxesClaimed) {
          boxBitmapRef.current.updateBox(boxId, event.teamId)
          bitmapDirtyRef.current = true
        }

        // Track for pop animation (only after initial sync)
        if (
          initialSyncCompleteRef.current &&
          `edgeId` in event &&
          `teamId` in event
        ) {
          const isLocal = localEdgeIdsRef.current.has(event.edgeId)
          // Clean up local edge tracking after it's been processed
          if (isLocal) {
            localEdgeIdsRef.current.delete(event.edgeId)
          }
          pendingRecentEventsRef.current.push({
            id: eventIdRef.current++,
            edgeId: event.edgeId,
            teamId: event.teamId,
            timestamp: now,
            isLocal,
          })
        }
      }

      // Clear pending edge if it was confirmed
      setPendingEdge((current) => {
        if (current !== null) {
          if (gameStateRef.current.isEdgeTaken(current)) {
            return null
          }
        }
        return current
      })

      // Handle initial sync - wait until upToDate before first render
      if (!initialSyncCompleteRef.current) {
        if (upToDate) {
          // We've caught up to live mode - do first render
          initialSyncCompleteRef.current = true

          // Commit final bitmap state
          if (bitmapDirtyRef.current) {
            boxBitmapRef.current.commit()
            bitmapDirtyRef.current = false
          }

          // Trigger version update which will cause canvas to render
          setVersion((v) => v + 1)

          pendingFirstRenderRef.current = true
          setIsReadyToRender(true)
        }
        // Don't render during initial catchup - wait for upToDate
        return
      }

      // After initial sync, schedule throttled render
      scheduleRender()
    },
    [scheduleRender]
  )

  // Handle connection events
  const handleConnected = useCallback(() => {
    setIsConnected(true)
    if (initialSyncCompleteRef.current && !pendingFirstRenderRef.current) {
      setIsLoading(false)
    }
    setError(null)
  }, [])

  const handleDisconnected = useCallback(() => {
    setIsConnected(false)
  }, [])

  const handleError = useCallback((err: Error) => {
    setError(err.message)
  }, [])

  const notifyCanvasRendered = useCallback(() => {
    if (pendingFirstRenderRef.current) {
      pendingFirstRenderRef.current = false
      setIsReadyToRender(false)
      setIsLoading(false)
    }
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

      // Optimistically consume quota (will be synced from server response)
      if (!consume()) {
        setError(`Quota exceeded, please wait`)
        return
      }

      // Set pending edge for optimistic UI
      setPendingEdge(edgeId)

      // Track as local edge for pop animation filtering
      localEdgeIdsRef.current.add(edgeId)

      try {
        const response = await fetch(`/api/draw`, {
          method: `POST`,
          headers: { "Content-Type": `application/json` },
          body: JSON.stringify({ edgeId }),
        })
        const result = await response.json()

        if (result.ok) {
          // Success - edge will be confirmed via stream
          // Sync quota from server (includes any refunds for completed boxes)
          if (typeof result.quotaRemaining === `number`) {
            syncFromServer(
              result.quotaRemaining,
              result.refillIn,
              result.boxesClaimed
            )
          }
          setError(null)
        } else {
          // Handle error codes
          // Sync quota from server response if provided (even on errors)
          if (typeof result.quotaRemaining === `number`) {
            syncFromServer(result.quotaRemaining, result.refillIn)
          }

          switch (result.code) {
            case `EDGE_TAKEN`:
              // Server already refunded - quota synced above
              setError(null) // Not really an error, just already taken
              break
            case `QUOTA_EXHAUSTED`:
              // Server says no quota - already synced above
              setError(`Quota exceeded, please wait`)
              break
            case `NO_TEAM`:
            case `NO_PLAYER`:
              refund() // Fallback refund if no server quota info
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
        // Network error - refund locally since we can't reach server
        refund()
        setPendingEdge(null)
        setError(err instanceof Error ? err.message : `Failed to place edge`)
      }
    },
    [consume, syncFromServer, refund, teamId]
  )

  const value: GameStateContextValue = {
    gameState: gameStateRef.current,
    boxBitmap: boxBitmapRef.current,
    pendingEdge,
    placeEdge,
    isConnected,
    isLoading,
    isReadyToRender,
    notifyCanvasRendered,
    error,
    version,
    recentEvents,
    isGameComplete: gameStateRef.current.isComplete(),
    winner: gameStateRef.current.getWinner(),
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
