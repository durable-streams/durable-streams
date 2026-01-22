import { useState } from "react"
import { GameState } from "../lib/game-state"

/**
 * Placeholder game state hook.
 * This will be replaced with real implementation in Phase 07.
 */
export function useGameState() {
  const [gameState] = useState(() => new GameState())
  const [pendingEdge] = useState<number | null>(null)

  const placeEdge = (_edgeId: number) => {
    // Placeholder - will be implemented in Phase 07
    console.log(`placeEdge called with:`, _edgeId)
  }

  return {
    gameState,
    pendingEdge,
    placeEdge,
  }
}
