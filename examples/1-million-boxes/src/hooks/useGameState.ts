import { useGameStateContext } from "../contexts/game-state-context"

/**
 * Hook for accessing game state and placing edges.
 *
 * Provides:
 * - gameState: The current GameState instance
 * - pendingEdge: Edge ID of an optimistically placed edge (or null)
 * - placeEdge: Function to place an edge
 * - isLoading: Whether initial data is loading
 * - error: Current error message (or null)
 * - isConnected: Whether connected to the stream
 * - version: Counter that increments on state changes (for re-render triggers)
 */
export function useGameState() {
  const {
    gameState,
    pendingEdge,
    placeEdge,
    isLoading,
    error,
    isConnected,
    version,
  } = useGameStateContext()

  return {
    gameState,
    pendingEdge,
    placeEdge,
    isLoading,
    error,
    isConnected,
    version,
  }
}
