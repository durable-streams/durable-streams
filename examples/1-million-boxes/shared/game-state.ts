import {
  BOX_COUNT,
  EDGE_COUNT,
  boxCoordsToId,
  getAdjacentBoxes,
  getBoxEdges,
} from "./edge-math"
import {
  FIRST_TO_SCORE_TARGET,
  GAME_END_MODE,
  TOTAL_BOX_COUNT,
} from "./game-config"
import type { GameEvent } from "./types"

export type { GameEvent } from "./types"

/**
 * Serialized game state for export/import.
 */
export interface SerializedGameState {
  edgeTaken: Uint8Array
  edgeOwner: Int8Array
  boxOwner: Uint8Array
  scores: Array<number>
  edgesPlaced: number
}

/**
 * GameState manages the complete state of a Dots & Boxes game.
 *
 * State is derived by applying events in order. The state includes:
 * - A bitset tracking which edges have been placed
 * - A map tracking which team placed each edge
 * - An array tracking box ownership (0=unclaimed, 1-4=team)
 * - Team scores
 */
export class GameState {
  // Edge bitset: 1 bit per edge (ceil(EDGE_COUNT/8) bytes ≈ 250KB)
  private edgeTaken: Uint8Array

  // Edge ownership: edgeId -> teamId (0-3), -1 for unowned
  private edgeOwner: Int8Array

  // Box ownership: 0 = unclaimed, 1-4 = team (teamId + 1)
  private boxOwner: Uint8Array

  // Team scores indexed by teamId (0-3)
  private scores: [number, number, number, number]

  // Count of placed edges
  private edgesPlacedCount: number

  constructor() {
    this.edgeTaken = new Uint8Array(Math.ceil(EDGE_COUNT / 8))
    this.edgeOwner = new Int8Array(EDGE_COUNT)
    this.edgeOwner.fill(-1)
    this.boxOwner = new Uint8Array(BOX_COUNT)
    this.scores = [0, 0, 0, 0]
    this.edgesPlacedCount = 0
  }

  /**
   * Check if an edge has been taken.
   */
  isEdgeTaken(edgeId: number): boolean {
    const byteIndex = edgeId >> 3
    const bitMask = 1 << (edgeId & 7)
    return (this.edgeTaken[byteIndex] & bitMask) !== 0
  }

  /**
   * Set an edge as taken (internal use only).
   */
  private setEdgeTaken(edgeId: number): void {
    const byteIndex = edgeId >> 3
    const bitMask = 1 << (edgeId & 7)
    this.edgeTaken[byteIndex] |= bitMask
  }

  /**
   * Apply a game event (edge placement).
   *
   * Returns information about boxes claimed as a result of this placement.
   * If the edge was already taken, returns an empty result (event is ignored).
   */
  applyEvent(event: GameEvent): { boxesClaimed: Array<number> } {
    const { edgeId, teamId } = event
    const boxesClaimed: Array<number> = []

    // Ignore if already taken (shouldn't happen with valid stream)
    if (this.isEdgeTaken(edgeId)) {
      return { boxesClaimed }
    }

    // Mark edge as taken and record owner
    this.setEdgeTaken(edgeId)
    this.edgeOwner[edgeId] = teamId
    this.edgesPlacedCount++

    // Check adjacent boxes for completion
    const adjacentBoxes = getAdjacentBoxes(edgeId)

    for (const box of adjacentBoxes) {
      const boxId = boxCoordsToId(box.x, box.y)

      // Skip if already claimed
      if (this.boxOwner[boxId] !== 0) continue

      // Check if all four edges are now set
      const [top, bottom, left, right] = getBoxEdges(box.x, box.y)

      if (
        this.isEdgeTaken(top) &&
        this.isEdgeTaken(bottom) &&
        this.isEdgeTaken(left) &&
        this.isEdgeTaken(right)
      ) {
        // Box is complete - claim it for the team that placed the final edge
        this.boxOwner[boxId] = teamId + 1
        this.scores[teamId]++
        boxesClaimed.push(boxId)
      }
    }

    return { boxesClaimed }
  }

  /**
   * Get the owner of a box.
   * Returns 0 for unclaimed, or 1-4 for team (teamId + 1).
   */
  getBoxOwner(boxId: number): number {
    return this.boxOwner[boxId]
  }

  /**
   * Get the team that placed an edge.
   * Returns the teamId (0-3) or undefined if edge is not taken.
   */
  getEdgeOwner(edgeId: number): number | undefined {
    const owner = this.edgeOwner[edgeId]
    return owner >= 0 ? owner : undefined
  }

  /**
   * Get a team's score.
   */
  getScore(teamId: number): number {
    return this.scores[teamId]
  }

  /**
   * Get all team scores.
   */
  getScores(): [number, number, number, number] {
    return [...this.scores] as [number, number, number, number]
  }

  /**
   * Get the number of edges that have been placed.
   */
  getEdgesPlacedCount(): number {
    return this.edgesPlacedCount
  }

  /**
   * Get the total number of boxes claimed across all teams.
   */
  getTotalBoxesClaimed(): number {
    return this.scores.reduce((sum, score) => sum + score, 0)
  }

  /**
   * Check if all boxes have been claimed.
   */
  isBoardComplete(): boolean {
    return this.getTotalBoxesClaimed() === TOTAL_BOX_COUNT
  }

  /**
   * Check if any team has reached the target score (for first_to_score mode).
   */
  hasTeamReachedTarget(): boolean {
    return this.scores.some((score) => score >= FIRST_TO_SCORE_TARGET)
  }

  /**
   * Check if the game is complete based on the configured end mode.
   * - "board_complete": All boxes are claimed
   * - "first_to_score": Any team has reached the target score
   */
  isComplete(): boolean {
    if (GAME_END_MODE === `first_to_score`) {
      return this.hasTeamReachedTarget()
    }
    // Default: board_complete
    return this.isBoardComplete()
  }

  /**
   * Get the winning team.
   * Returns the teamId (0-3) of the winner, or null if there's a tie.
   */
  getWinner(): number | null {
    if (!this.isComplete()) {
      return null
    }

    const maxScore = Math.max(...this.scores)
    const winners = this.scores
      .map((score, teamId) => (score === maxScore ? teamId : -1))
      .filter((teamId) => teamId !== -1)
    return winners.length === 1 ? winners[0] : null
  }

  /**
   * Export the game state for serialization.
   */
  export(): SerializedGameState {
    return {
      edgeTaken: new Uint8Array(this.edgeTaken),
      edgeOwner: new Int8Array(this.edgeOwner),
      boxOwner: new Uint8Array(this.boxOwner),
      scores: [...this.scores],
      edgesPlaced: this.edgesPlacedCount,
    }
  }

  /**
   * Import a serialized game state.
   */
  static import(data: SerializedGameState): GameState {
    const state = new GameState()
    state.edgeTaken.set(data.edgeTaken)
    state.edgeOwner.set(data.edgeOwner)
    state.boxOwner.set(data.boxOwner)
    state.scores = data.scores.slice(0, 4) as [number, number, number, number]
    state.edgesPlacedCount = data.edgesPlaced
    return state
  }
}
